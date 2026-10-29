/**
 * Step Index signal scanner for Vercel (one file, no imports, no dependencies).
 * Needs Node 22+ (built-in WebSocket client).
 *
 * Each call: connect to Deriv, pull ~3000 M5 candles for the 5 markets (in pages of 500),
 * replay the supply/demand + candlestick logic over them, and return recent signals,
 * active zones and a backtest of the loaded history.
 *
 * Optional env vars (Vercel -> Settings -> Environment Variables):
 *   DERIV_WS_URL   websocket URL to try first
 *   DERIV_APP_ID   app id for the legacy endpoint (default 1089)
 *   DERIV_SYMBOLS  JSON map, e.g. {"Step Index":"stpRNG","Step Index 200":"stpRNG2"}
 */

// ───────────────────────── config ─────────────────────────
const cfg = {
  granularity: 300, // M5
  history: 3000, // candles kept per market (~10 days); fetched in pages of 500
  atrPeriod: 14,
  warmup: 30,
  // zones
  impulseAtr: 1.2,
  impulseBodyFrac: 0.6,
  baseBodyAtr: 0.5,
  maxBase: 3,
  maxZoneHeightAtr: 1.5,
  zoneMaxAgeCandles: 288,
  maxPriorTouches: 1,
  touchToleranceAtr: 0.25,
  // trades
  slBufferAtr: 0.1,
  minRiskAtr: 0.5,
  maxRiskAtr: 3,
  rr: 2,
  tradeTimeoutCandles: 60,
  costR: 0, // set above 0 to model spread/fees as a fraction of 1R
  recentCandles: 36, // signals from the last 3 hours are returned
};

const MARKETS = [
  { name: "Step Index", aliases: ["step index", "step index 100", "step 100"], guess: "stpRNG" },
  { name: "Step Index 200", aliases: ["step index 200", "step 200"], guess: "stpRNG2" },
  { name: "Step Index 300", aliases: ["step index 300", "step 300"], guess: "stpRNG3" },
  { name: "Step Index 400", aliases: ["step index 400", "step 400"], guess: "stpRNG4" },
  { name: "Step Index 500", aliases: ["step index 500", "step 500"], guess: "stpRNG5" },
];

// ───────────────────────── types ─────────────────────────
interface Candle { t: number; o: number; h: number; l: number; c: number }
interface Zone { kind: "demand" | "supply"; lo: number; hi: number; formedIdx: number; formedT: number; touches: number; used: boolean; dead: boolean }
interface Signal {
  market: string; side: "BUY" | "SELL"; t: number; entry: number; sl: number; tp: number;
  risk: number; rr: number; atr: number; pattern: string;
  zone: { kind: "demand" | "supply"; lo: number; hi: number; formedT: number };
}
type Status = "WIN" | "LOSS" | "TIMEOUT" | "OPEN";

// ───────────────────────── indicators ─────────────────────────
const body = (c: Candle) => Math.abs(c.c - c.o);
const range = (c: Candle) => c.h - c.l;
const upperWick = (c: Candle) => c.h - Math.max(c.o, c.c);
const lowerWick = (c: Candle) => Math.min(c.o, c.c) - c.l;
const bull = (c: Candle) => c.c > c.o;
const bear = (c: Candle) => c.c < c.o;

function atrAt(cs: Candle[], i: number, n = 14): number {
  const from = Math.max(1, i - n + 1);
  let sum = 0, k = 0;
  for (let j = from; j <= i; j++) {
    const p = cs[j - 1], c = cs[j];
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    k++;
  }
  return k ? sum / k : 0;
}

// ───────────────────────── candlestick patterns ─────────────────────────
interface Pattern { name: string; span: number }
interface Patterns { bull: Pattern | null; bear: Pattern | null }

function detectPatterns(cs: Candle[], i: number, atr: number): Patterns {
  const k = cs[i];
  const p = i >= 1 ? cs[i - 1] : null;
  const a = i >= 2 ? cs[i - 2] : null;
  const out: Patterns = { bull: null, bear: null };

  if (p) {
    if (bear(p) && bull(k) && k.o <= p.c && k.c >= p.o && body(k) > body(p) && body(k) >= 0.3 * atr)
      out.bull = { name: "bullish engulfing", span: 2 };
    if (bull(p) && bear(k) && k.o >= p.c && k.c <= p.o && body(k) > body(p) && body(k) >= 0.3 * atr)
      out.bear = { name: "bearish engulfing", span: 2 };
  }
  if (a && p) {
    const aMid = (a.o + a.c) / 2;
    if (!out.bull && bear(a) && body(a) >= 0.6 * atr && body(p) <= 0.35 * body(a) && bull(k) && k.c > aMid && body(k) >= 0.4 * atr)
      out.bull = { name: "morning star", span: 3 };
    if (!out.bear && bull(a) && body(a) >= 0.6 * atr && body(p) <= 0.35 * body(a) && bear(k) && k.c < aMid && body(k) >= 0.4 * atr)
      out.bear = { name: "evening star", span: 3 };
  }
  const r = range(k);
  if (r >= 0.5 * atr && r > 0) {
    const b = Math.max(body(k), 0.1 * r);
    if (!out.bull && lowerWick(k) >= 2 * b && lowerWick(k) >= 0.6 * r && upperWick(k) <= 0.25 * r)
      out.bull = { name: "hammer (pin bar)", span: 1 };
    if (!out.bear && upperWick(k) >= 2 * b && upperWick(k) >= 0.6 * r && lowerWick(k) <= 0.25 * r)
      out.bear = { name: "shooting star (pin bar)", span: 1 };
  }
  return out;
}

// ───────────────────────── supply / demand zones ─────────────────────────
// base (1-3 small candles) followed by a decisive impulse candle that leaves the base behind.
// Up-impulse -> demand zone, down-impulse -> supply zone.
// A zone dies when a candle CLOSES through its far edge, or when it is too old.
class ZoneBook {
  zones: Zone[] = [];

  update(cs: Candle[], i: number) {
    const c = cs[i];
    for (const z of this.zones) {
      if (z.dead) continue;
      if (i - z.formedIdx > cfg.zoneMaxAgeCandles) { z.dead = true; continue; }
      if (z.kind === "demand") {
        if (c.c < z.lo) z.dead = true;
        else if (c.l <= z.hi) z.touches++;
      } else {
        if (c.c > z.hi) z.dead = true;
        else if (c.h >= z.lo) z.touches++;
      }
    }
    this.zones = this.zones.filter((z) => !z.dead);
  }

  detect(cs: Candle[], i: number, atrPrev: number) {
    if (atrPrev <= 0 || i < 2) return;
    const imp = cs[i];
    const r = range(imp);
    if (r <= 0 || body(imp) < cfg.impulseAtr * atrPrev || body(imp) < cfg.impulseBodyFrac * r) return;
    const up = imp.c > imp.o;

    let lo = Infinity, hi = -Infinity, n = 0;
    for (let j = i - 1; j >= 1 && n < cfg.maxBase; j--) {
      const b = cs[j];
      if (body(b) > cfg.baseBodyAtr * atrPrev) break;
      lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); n++;
    }
    if (n === 0) return;
    if (hi - lo > cfg.maxZoneHeightAtr * atrPrev) return;
    if (up && imp.c <= hi) return;
    if (!up && imp.c >= lo) return;

    const kind = up ? "demand" : "supply";
    if (this.zones.some((z) => z.kind === kind && !z.dead && z.lo <= hi && lo <= z.hi)) return;
    this.zones.push({ kind, lo, hi, formedIdx: i, formedT: imp.t, touches: 0, used: false, dead: false });
  }
}

// ───────────────────────── analyzer (one per market) ─────────────────────────
class Analyzer {
  cs: Candle[] = [];
  book = new ZoneBook();
  constructor(public market: string) {}

  push(c: Candle): Signal | null {
    this.cs.push(c);
    const i = this.cs.length - 1;
    if (i < cfg.warmup) return null;
    const atr = atrAt(this.cs, i, cfg.atrPeriod);
    const sig = atr > 0 ? this.findSignal(i, atr, detectPatterns(this.cs, i, atr)) : null;
    this.book.update(this.cs, i);
    this.book.detect(this.cs, i, atrAt(this.cs, i - 1, cfg.atrPeriod));
    return sig;
  }

  private findSignal(i: number, atr: number, pat: Patterns): Signal | null {
    const c = this.cs[i];
    const tol = cfg.touchToleranceAtr * atr;
    for (const z of [...this.book.zones].reverse()) {
      if (z.dead || z.used || z.touches > cfg.maxPriorTouches) continue;
      if (z.kind === "demand" && pat.bull) {
        let low = Infinity;
        for (let j = i - pat.bull.span + 1; j <= i; j++) low = Math.min(low, this.cs[j].l);
        if (low <= z.hi && low >= z.lo - tol && c.c > z.lo)
          return this.build("BUY", c, atr, Math.min(z.lo, low) - cfg.slBufferAtr * atr, pat.bull.name, z);
      }
      if (z.kind === "supply" && pat.bear) {
        let high = -Infinity;
        for (let j = i - pat.bear.span + 1; j <= i; j++) high = Math.max(high, this.cs[j].h);
        if (high >= z.lo && high <= z.hi + tol && c.c < z.hi)
          return this.build("SELL", c, atr, Math.max(z.hi, high) + cfg.slBufferAtr * atr, pat.bear.name, z);
      }
    }
    return null;
  }

  private build(side: "BUY" | "SELL", c: Candle, atr: number, sl: number, pattern: string, z: Zone): Signal | null {
    const entry = c.c;
    const risk = Math.abs(entry - sl);
    if (risk < cfg.minRiskAtr * atr || risk > cfg.maxRiskAtr * atr) return null;
    z.used = true;
    const tp = side === "BUY" ? entry + cfg.rr * risk : entry - cfg.rr * risk;
    return { market: this.market, side, t: c.t, entry, sl, tp, risk, rr: cfg.rr, atr, pattern, zone: { kind: z.kind, lo: z.lo, hi: z.hi, formedT: z.formedT } };
  }
}

// ───────────────────────── trade resolution ─────────────────────────
// If SL and TP are both inside one candle we cannot know the order, so assume the stop hit first.
function stepTrade(s: Signal, c: Candle, barsHeld: number): { R: number; result: Exclude<Status, "OPEN"> } | null {
  const slHit = s.side === "BUY" ? c.l <= s.sl : c.h >= s.sl;
  const tpHit = s.side === "BUY" ? c.h >= s.tp : c.l <= s.tp;
  if (slHit) return { R: -1 - cfg.costR, result: "LOSS" };
  if (tpHit) return { R: s.rr - cfg.costR, result: "WIN" };
  if (barsHeld >= cfg.tradeTimeoutCandles) {
    const move = s.side === "BUY" ? c.c - s.entry : s.entry - c.c;
    return { R: move / s.risk - cfg.costR, result: "TIMEOUT" };
  }
  return null;
}

function resolveSignal(s: Signal, cs: Candle[], idx: Map<number, number>): { status: Status; R: number; bars: number; exitT: number } {
  const i = idx.get(s.t);
  if (i === undefined) return { status: "OPEN", R: 0, bars: 0, exitT: 0 };
  for (let j = i + 1, bars = 1; j < cs.length; j++, bars++) {
    const r = stepTrade(s, cs[j], bars);
    if (r) return { status: r.result, R: r.R, bars, exitT: cs[j].t };
  }
  return { status: "OPEN", R: 0, bars: cs.length - 1 - i, exitT: 0 };
}

function stats(R: number[]) {
  const n = R.length;
  if (!n) return { n: 0, mean: 0, lo: 0, hi: 0 };
  const mean = R.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(R.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(n - 1, 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, lo: mean - 1.96 * se, hi: mean + 1.96 * se };
}

// ───────────────────────── per-market analysis ─────────────────────────
export function analyzeMarket(name: string, cs: Candle[]) {
  const an = new Analyzer(name);
  const all: Signal[] = [];
  for (const c of cs) { const s = an.push(c); if (s) all.push(s); }

  const idx = new Map<number, number>(cs.map((c, i) => [c.t, i] as [number, number]));
  const res = all.map((s) => ({ s, o: resolveSignal(s, cs, idx) }));
  const closed = res.filter((x) => x.o.status !== "OPEN");
  const decided = closed.filter((x) => x.o.status !== "TIMEOUT");
  const wins = decided.filter((x) => x.o.status === "WIN").length;
  const R = closed.map((x) => x.o.R);
  const st = stats(R);

  const last = cs[cs.length - 1];
  const recentFrom = cs.length - cfg.recentCandles;
  const signals = res
    .filter((x) => (idx.get(x.s.t) ?? 0) >= recentFrom)
    .map((x) => ({ ...x.s, status: x.o.status, R: x.o.R, bars: x.o.bars, exitT: x.o.exitT }));
  const zones = an.book.zones.map((z) => ({ kind: z.kind, lo: z.lo, hi: z.hi, touches: z.touches, formedT: z.formedT }));

  return {
    out: {
      name, price: last.c, lastCandleT: last.t, candles: cs.length,
      zones: { demand: zones.filter((z) => z.kind === "demand").length, supply: zones.filter((z) => z.kind === "supply").length, list: zones.slice(-8) },
      signals,
      history: {
        signals: all.length, resolved: closed.length, open: res.length - closed.length,
        wins, losses: decided.length - wins, timeouts: closed.length - decided.length,
        winRate: decided.length ? wins / decided.length : null, meanR: st.mean, lo: st.lo, hi: st.hi,
      },
    },
    R,
  };
}

function verdict(R: number[]) {
  const st = stats(R);
  const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);
  let level = "none", text = "";
  if (st.n < 30) { level = "thin"; text = `Only ${st.n} resolved signals in the loaded history. Too few to judge.`; }
  else if (st.lo > 0) { level = "edge"; text = `Positive in this sample: mean ${f(st.mean)}R, 95% range ${f(st.lo)} to ${f(st.hi)}R. Not proof. Forward-test before trusting it.`; }
  else if (st.hi < 0) { level = "loss"; text = `Loses money in this sample: mean ${f(st.mean)}R, 95% range ${f(st.lo)} to ${f(st.hi)}R.`; }
  else { text = `No detectable edge: mean ${f(st.mean)}R, 95% range ${f(st.lo)} to ${f(st.hi)}R includes zero.`; }
  return { level, text, n: st.n, meanR: st.mean, lo: st.lo, hi: st.hi, breakEvenWinRate: 1 / (1 + cfg.rr) };
}

// ───────────────────────── Deriv websocket client ─────────────────────────
const URLS = [
  process.env.DERIV_WS_URL,
  "wss://api.derivws.com/trading/v1/options/ws/public",
  `wss://ws.derivws.com/websockets/v3?app_id=${process.env.DERIV_APP_ID ?? "1089"}`,
].filter((u): u is string => !!u);

function openSocket(url: string, ms = 6000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error("timeout")); }, ms);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = () => { clearTimeout(t); reject(new Error("connect failed")); };
  });
}

class Deriv {
  ws!: WebSocket;
  url = "";
  private id = 1;
  private pend = new Map<number, { res: (m: any) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  async connect() {
    const errs: string[] = [];
    for (const url of URLS) {
      try { this.ws = await openSocket(url); this.url = url; break; }
      catch (e) { errs.push(`${url} (${(e as Error).message})`); }
    }
    if (!this.url) throw new Error(`Could not connect to Deriv. Tried: ${errs.join("; ")}`);
    this.ws.onmessage = (ev: MessageEvent) => {
      let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
      const p = this.pend.get(m.req_id);
      if (!p) return;
      clearTimeout(p.timer); this.pend.delete(m.req_id);
      if (m.error) p.rej(new Error(`${m.error.code ?? "error"}: ${m.error.message ?? "request failed"}`));
      else p.res(m);
    };
    this.ws.onclose = () => this.failAll("connection closed");
    this.ws.onerror = () => this.failAll("connection error");
  }

  private failAll(why: string) {
    for (const [, p] of this.pend) { clearTimeout(p.timer); p.rej(new Error(why)); }
    this.pend.clear();
  }

  req(payload: Record<string, unknown>, ms = 15000): Promise<any> {
    return new Promise((res, rej) => {
      const id = this.id++;
      const timer = setTimeout(() => { this.pend.delete(id); rej(new Error("request timeout")); }, ms);
      this.pend.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

type SymMap = Record<string, { code: string; confirmed: boolean }>;
let symCache: SymMap | null = null; // survives between warm invocations

async function resolveSymbols(d: Deriv): Promise<SymMap> {
  const override: Record<string, string> = process.env.DERIV_SYMBOLS ? JSON.parse(process.env.DERIV_SYMBOLS) : {};
  let list: any[] = [];
  for (const q of [{ active_symbols: "brief", product_type: "basic" }, { active_symbols: "brief" }]) {
    try { list = (await d.req(q)).active_symbols ?? []; if (list.length) break; } catch { /* try next */ }
  }
  const out: SymMap = {};
  for (const m of MARKETS) {
    const hit = list.find((e) => m.aliases.includes(String(e.display_name ?? e.name ?? "").toLowerCase()));
    const code = override[m.name] ?? hit?.symbol ?? hit?.underlying_symbol;
    out[m.name] = { code: code ?? m.guess, confirmed: !!code };
  }
  return out;
}

// ───────────────────────── candle history (paged) ─────────────────────────
// Deriv returns at most ~500 candles per request, so older candles are fetched page by page
// (end = epoch just before the oldest candle we have) and stitched together. The result is
// cached in memory so warm invocations only need to fetch the newest page.
const PAGE = 500;
const candleCache = new Map<string, Candle[]>();

async function fetchPage(d: Deriv, code: string, end: string, count: number): Promise<Candle[]> {
  const r = await d.req({ ticks_history: code, style: "candles", granularity: cfg.granularity, end, count, adjust_start_time: 1 });
  return (r.candles ?? []).map((x: any) => ({ t: +x.epoch, o: +x.open, h: +x.high, l: +x.low, c: +x.close }));
}

async function getCandles(d: Deriv, code: string, want: number): Promise<Candle[]> {
  const cached = candleCache.get(code);
  const newest = await fetchPage(d, code, "latest", PAGE); // an error here is a real error
  let all = newest;
  if (cached?.length && newest.length && newest[0].t <= cached[cached.length - 1].t)
    all = [...cached.filter((c) => c.t < newest[0].t), ...newest]; // reuse older candles we already hold

  for (let guard = 0; all.length && all.length < want && guard < 20; guard++) {
    let older: Candle[];
    try { older = await fetchPage(d, code, String(all[0].t - 1), Math.min(PAGE, want - all.length)); }
    catch { break; } // e.g. rate limit: carry on with what we have
    const fresh = older.filter((c) => c.t < all[0].t);
    if (!fresh.length) break;
    all = [...fresh, ...all];
  }
  if (all.length > want) all = all.slice(all.length - want);
  candleCache.set(code, all);
  return all;
}

// ───────────────────────── scan ─────────────────────────
export async function scan() {
  const d = new Deriv();
  await d.connect();
  try {
    if (!symCache) symCache = await resolveSymbols(d);
    const sym = symCache;
    const now = Math.floor(Date.now() / 1000);

    const results = await Promise.all(MARKETS.map(async (m) => {
      const s = sym[m.name];
      try {
        const cs = [...(await getCandles(d, s.code, cfg.history))]; // copy: the cache keeps the original
        if (cs.length && cs[cs.length - 1].t + cfg.granularity > now) cs.pop(); // still forming
        if (cs.length < cfg.warmup + 10) throw new Error(`only ${cs.length} candles returned`);
        const a = analyzeMarket(m.name, cs);
        return { ...a.out, symbol: s.code, confirmed: s.confirmed, R: a.R, error: null as string | null };
      } catch (e) {
        symCache = null; // re-resolve symbols next time
        return { name: m.name, symbol: s.code, confirmed: s.confirmed, error: (e as Error).message, R: [] as number[] };
      }
    }));

    const allR = results.flatMap((r) => r.R);
    return {
      ok: true,
      serverTime: now,
      endpoint: d.url,
      config: { rr: cfg.rr, breakEvenWinRate: 1 / (1 + cfg.rr), granularity: cfg.granularity, recentCandles: cfg.recentCandles },
      verdict: verdict(allR),
      markets: results.map(({ R, ...rest }) => rest),
    };
  } finally {
    d.close();
  }
}

// ───────────────────────── Vercel handler ─────────────────────────
export default async function handler(_req: any, res: any) {
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  try {
    res.status(200).json(await scan());
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: (e as Error).message,
      hint: "Deriv could not be reached. Set DERIV_WS_URL (and DERIV_SYMBOLS if needed) in Vercel environment variables.",
    });
  }
}
