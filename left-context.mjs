// ─────────────────────────────────────────────────────────────────────────
// WHAT DID THE MANIPULATION WICK TAP?
//
// The setup is unchanged: a 4H candle B takes both the high and the low of
// candle A and closes one way. Entry at B's close, stop at B's manipulation
// wick, target 3R. On its own that rule measured flat.
//
// The question here is different: does it matter WHERE the wick went? For
// every setup we look LEFT and ask what the wick reached into, using only
// candles that existed before B. Then we compare the setups that tapped
// something with the setups that tapped nothing.
//
// Facts checked, all strictly historical:
//   fvg        an unfilled 4H fair value gap
//   fvgDeep    ... and past its midpoint (consequent encroachment)
//   ob         an order block, the last opposite candle before displacement
//   swing      a prior swing low/high that had stood at least 5 candles
//   equal      a double bottom/top, two swings within 0.15 ATR of each other
//   pd         the previous day's low/high
//   pw         the previous week's low/high
//   discount   the lower third of the last 30 candles (upper third for shorts)
//   deep       the lower third of the last 120 candles
//   dailyFvg   an unfilled DAILY fair value gap
//   story      how many of the above are true, 0 to 5
//
// Every setup is paired with a same-weather random twin so the comparison is
// "tapped something" against "tapped nothing" AFTER the market's own weather
// is taken out. Errors are clustered by market and quarter. Everything is
// repeated on fake random-walk markets, which must show nothing.
//
// Pass rule, fixed before running: 3 standard errors against the no-tap group,
// the same sign in both halves, clean on the fake markets, and positive after
// spread. With this many facts tested, one lucky 3 is expected, so a fact that
// passes must pass all four parts.
//
//   node left-context.mjs            writes left.json
//   GRID=1 node left-context.mjs     rebuild 4H candles shifted one hour
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { detectSweep } from "./detector.mjs";

const DIR = process.env.H1_DIR || "C:/Users/hp/Documents/Smart ToDo List/h1-data";
const GRID = +(process.env.GRID || 0);          // 4H grid offset in hours
const HORIZON = 60;                              // 4H candles allowed to resolve
const ATR_N = 14;
const RR = 3;
const EQ_TOL = 0.15;                             // equal highs/lows tolerance, in ATR
const OB_DISP = 0.5;                             // displacement needed to mark an order block, in ATR

let seed = 19731129;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 8675309;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };

// ── data ─────────────────────────────────────────────────────────────────
function load(key) {
  const j = JSON.parse(readFileSync(`${DIR}/${key}`, "utf8"));
  return { key: j.key, spread: j.spread, h1: j.bars.map((b) => ({ t: b[0], open: b[1], high: b[2], low: b[3], close: b[4] })) };
}
// group hourly bars into 4H candles on a chosen grid
function toTF(h1, hours, offset = 0) {
  const out = [];
  let cur = null, bucket = null;
  for (const b of h1) {
    const k = Math.floor((b.t / 3600 - offset) / hours);
    if (k !== bucket) {
      if (cur) out.push(cur);
      bucket = k;
      cur = { t: b.t, open: b.open, high: b.high, low: b.low, close: b.close };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}
const dayKey = (t) => Math.floor(t / 86400);
const weekKey = (t) => Math.floor((t + 4 * 86400) / (7 * 86400));
function group(bars, keyOf) {
  const m = new Map();
  for (const b of bars) {
    const k = keyOf(b.t);
    const g = m.get(k);
    if (!g) m.set(k, { k, high: b.high, low: b.low, open: b.open, close: b.close, t: b.t });
    else { g.high = Math.max(g.high, b.high); g.low = Math.min(g.low, b.low); g.close = b.close; }
  }
  return [...m.values()].sort((a, b) => a.k - b.k);
}

function atrSeries(bars) {
  const a = new Float64Array(bars.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], p = i ? bars[i - 1] : b;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    s += tr;
    if (i >= ATR_N) {
      const q = bars[i - ATR_N], qp = bars[i - ATR_N - 1] || q;
      s -= Math.max(q.high - q.low, Math.abs(q.high - qp.close), Math.abs(q.low - qp.close));
      a[i] = s / ATR_N;
    }
  }
  return a;
}

// ── the left side: zones that exist BEFORE candle i ──────────────────────
// Fair value gaps, tracked forward and killed once price fills them.
function fvgZones(bars) {
  const live = [];        // {lo, hi, dir, at}
  const perBar = [];      // zones alive when bar i opens
  for (let i = 0; i < bars.length; i++) {
    perBar.push(live.filter((z) => z.dead === undefined).map((z) => z));
    // kill zones this bar trades through
    for (const z of live) {
      if (z.dead !== undefined) continue;
      if (z.dir === 1 && bars[i].low <= z.lo) z.dead = i;
      if (z.dir === -1 && bars[i].high >= z.hi) z.dead = i;
    }
    // a gap is confirmed by the close of bar i, using bars i-2, i-1, i
    if (i >= 2) {
      const a = bars[i - 2], c = bars[i];
      if (c.low > a.high) live.push({ lo: a.high, hi: c.low, dir: 1, at: i });      // bullish imbalance below
      if (c.high < a.low) live.push({ lo: c.high, hi: a.low, dir: -1, at: i });     // bearish imbalance above
    }
  }
  return perBar;
}
// Order blocks: the last opposite candle before a displacement move.
function obZones(bars, atr) {
  const live = [];
  const perBar = [];
  for (let i = 0; i < bars.length; i++) {
    perBar.push(live.filter((z) => z.dead === undefined));
    for (const z of live) {
      if (z.dead !== undefined) continue;
      if (z.dir === 1 && bars[i].low < z.lo) z.dead = i;
      if (z.dir === -1 && bars[i].high > z.hi) z.dead = i;
    }
    if (i >= 1 && Number.isFinite(atr[i])) {
      const k = bars[i - 1], c = bars[i];
      if (k.close < k.open && c.close > k.high && c.close - k.high >= OB_DISP * atr[i]) live.push({ lo: k.low, hi: k.high, dir: 1, at: i });
      if (k.close > k.open && c.close < k.low && k.low - c.close >= OB_DISP * atr[i]) live.push({ lo: k.low, hi: k.high, dir: -1, at: i });
    }
  }
  return perBar;
}
// Confirmed swing points (3-bar pivots), with the index they were confirmed at.
function swings(bars) {
  const hi = [], lo = [];
  for (let i = 1; i < bars.length - 1; i++) {
    if (bars[i].high > bars[i - 1].high && bars[i].high > bars[i + 1].high) hi.push({ i, p: bars[i].high });
    if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i + 1].low) lo.push({ i, p: bars[i].low });
  }
  return { hi, lo };
}

const inZone = (p, z) => p <= z.hi && p >= z.lo;

// ── outcome ──────────────────────────────────────────────────────────────
function race(bars, from, dir, entry, stop, R) {
  const short = dir === "SHORT", risk = Math.abs(entry - stop);
  const tgt = short ? entry - R * risk : entry + R * risk;
  const end = Math.min(bars.length, from + HORIZON);
  for (let k = from; k < end; k++) {
    const b = bars[k];
    if (short ? b.high >= stop : b.low <= stop) return { r: -1, done: 1 };
    if (short ? b.low <= tgt : b.high >= tgt) return { r: R, done: 1 };
  }
  if (end <= from) return null;
  const last = bars[end - 1].close;
  return { r: Math.max(-1, Math.min(R, (short ? entry - last : last - entry) / risk)), done: 0 };
}

// ── run one book of bars ─────────────────────────────────────────────────
function runBook(key, bars4, daily, weekly, spread, label) {
  const atr = atrSeries(bars4);
  const fvgs = fvgZones(bars4);
  const obs = obZones(bars4, atr);
  const { hi: swHi, lo: swLo } = swings(bars4);
  const dailyBars = daily, weeklyBars = weekly;
  const dFvgByDay = (() => {                       // unfilled daily FVGs, keyed by day index
    const live = [], out = new Map();
    for (let i = 0; i < dailyBars.length; i++) {
      out.set(dailyBars[i].k, live.filter((z) => z.dead === undefined).map((z) => z));
      for (const z of live) {
        if (z.dead !== undefined) continue;
        if (z.dir === 1 && dailyBars[i].low <= z.lo) z.dead = i;
        if (z.dir === -1 && dailyBars[i].high >= z.hi) z.dead = i;
      }
      if (i >= 2) {
        const a = dailyBars[i - 2], c = dailyBars[i];
        if (c.low > a.high) live.push({ lo: a.high, hi: c.low, dir: 1, at: i });
        if (c.high < a.low) live.push({ lo: c.high, hi: a.low, dir: -1, at: i });
      }
    }
    return out;
  })();
  const dayByKey = new Map(dailyBars.map((d) => [d.k, d]));
  const weekByKey = new Map(weeklyBars.map((w) => [w.k, w]));

  // same-weather partner pool: index by ATR as a share of price
  const pool = [];
  for (let i = ATR_N + 2; i < bars4.length - HORIZON - 1; i++) if (Number.isFinite(atr[i])) pool.push([atr[i] / bars4[i].close, i]);
  pool.sort((a, b) => a[0] - b[0]);
  const W = Math.max(25, Math.floor(pool.length * 0.02));
  const pick = (w) => {
    let lo = 0, hi = pool.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pool[m][0] < w) lo = m + 1; else hi = m; }
    const a = Math.max(0, lo - W), b = Math.min(pool.length - 1, lo + W);
    return pool[a + Math.floor(rnd() * (b - a + 1))][1];
  };

  const rows = [];
  for (let i = ATR_N + 3; i < bars4.length - 2; i++) {
    if (!Number.isFinite(atr[i])) continue;
    const A = bars4[i - 1], B = bars4[i];
    const sig = detectSweep(A, B);
    if (!sig) continue;
    const dir = sig.dir === "BULL" ? "LONG" : "SHORT";
    const long = dir === "LONG";
    const entry = B.close;
    const stop = long ? B.low : B.high;
    const wick = stop;                                   // the manipulation wick itself
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const cost = spread / risk;
    if (risk < 2 * spread) continue;                     // not tradeable, same rule as the other tests

    // ── what did the wick tap, using only what existed before B ──────────
    const want = long ? 1 : -1;
    const liveFvg = (fvgs[i] || []).filter((z) => z.dir === want && (z.dead === undefined || z.dead >= i));
    const hitFvg = liveFvg.find((z) => inZone(wick, z));
    const hitFvgDeep = liveFvg.find((z) => (long ? wick <= (z.lo + z.hi) / 2 : wick >= (z.lo + z.hi) / 2) && inZone(wick, z));
    const liveOb = (obs[i] || []).filter((z) => z.dir === want && (z.dead === undefined || z.dead >= i));
    const hitOb = liveOb.find((z) => inZone(wick, z));

    const priorSw = (long ? swLo : swHi).filter((s) => s.i <= i - 5);
    const lastSw = priorSw.length ? priorSw[priorSw.length - 1] : null;
    // did the wick take out a prior swing that had stood at least 5 candles?
    const tookSwing = priorSw.some((s) => (long ? wick <= s.p && B.close > s.p : wick >= s.p && B.close < s.p) && s.i >= i - 120);
    // equal lows / equal highs: two prior swings within tolerance, both taken
    const tol = EQ_TOL * atr[i];
    let equal = false;
    for (let a = priorSw.length - 1; a > 0 && priorSw[a].i >= i - 120; a--) {
      for (let b = a - 1; b >= 0 && priorSw[b].i >= i - 120; b--) {
        if (Math.abs(priorSw[a].p - priorSw[b].p) <= tol && (long ? wick <= Math.min(priorSw[a].p, priorSw[b].p) : wick >= Math.max(priorSw[a].p, priorSw[b].p))) { equal = true; break; }
      }
      if (equal) break;
    }

    const dk = dayKey(B.t), wk = weekKey(B.t);
    const pd = dayByKey.get(dk - 1) || dayByKey.get(dk - 2) || dayByKey.get(dk - 3);
    const pw = weekByKey.get(wk - 1);
    const tookPD = pd ? (long ? wick <= pd.low && B.close > pd.low : wick >= pd.high && B.close < pd.high) : false;
    const tookPW = pw ? (long ? wick <= pw.low && B.close > pw.low : wick >= pw.high && B.close < pw.high) : false;

    const rangeOf = (n) => {
      let hi = -Infinity, lo = Infinity;
      for (let k = Math.max(0, i - n); k < i; k++) { if (bars4[k].high > hi) hi = bars4[k].high; if (bars4[k].low < lo) lo = bars4[k].low; }
      return { hi, lo };
    };
    const r30 = rangeOf(30), r120 = rangeOf(120);
    const posIn = (r) => (r.hi > r.lo ? (wick - r.lo) / (r.hi - r.lo) : 0.5);
    const discount = long ? posIn(r30) <= 0.33 : posIn(r30) >= 0.67;
    const deep = long ? posIn(r120) <= 0.33 : posIn(r120) >= 0.67;

    const dz = (dFvgByDay.get(dk) || []).filter((z) => z.dir === want);
    const hitDailyFvg = !!dz.find((z) => inZone(wick, z));

    const facts = {
      fvg: !!hitFvg, fvgDeep: !!hitFvgDeep, ob: !!hitOb, swing: tookSwing, equal,
      pd: tookPD, pw: tookPW, discount, deep, dailyFvg: hitDailyFvg,
    };
    const story = ["fvg", "ob", "swing", "pd", "discount"].reduce((s, k2) => s + (facts[k2] ? 1 : 0), 0);

    // ── outcome, and the same-weather twin ───────────────────────────────
    const real = race(bars4, i + 1, dir, entry, stop, RR);
    if (!real) continue;
    const q = pick(atr[i] / B.close);
    const te = bars4[q].close;
    const ts = long ? te * (1 - risk / entry) : te * (1 + risk / entry);
    const twin = race(bars4, q + 1, dir, te, ts, RR);
    if (!twin) continue;

    rows.push({
      key, label, t: B.t, dir, strong: sig.strength === "STRONG",
      realR: real.r - cost, twinR: twin.r - cost, done: real.done,
      risk, cost, facts, story,
    });
  }
  return rows;
}

// ── statistics ───────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const quarter = (t) => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3)}`; };
// difference in means, clustered by market and quarter
function clusterZ(groupA, groupB) {
  if (groupA.length < 30 || groupB.length < 30) return NaN;
  const mA = mean(groupA.map((r) => r.d)), mB = mean(groupB.map((r) => r.d));
  const diff = mA - mB;
  const cl = new Map();
  for (const r of groupA) { const k = r.key + quarter(r.t); cl.set(k, (cl.get(k) || 0) + (r.d - mA) / groupA.length); }
  for (const r of groupB) { const k = r.key + quarter(r.t); cl.set(k, (cl.get(k) || 0) - (r.d - mB) / groupB.length); }
  const v = [...cl.values()].reduce((s, x) => s + x * x, 0);
  return v > 0 ? diff / Math.sqrt(v) : NaN;
}

// ── go ───────────────────────────────────────────────────────────────────
const files = readdirSync(DIR).filter((f) => f.endsWith("-H1.json"));
const all = [];
const perMarket = {};
for (const f of files) {
  const { key, spread, h1 } = load(f);
  if (h1.length < 5000) continue;
  const bars4 = toTF(h1, 4, GRID);
  const daily = group(h1, dayKey), weekly = group(h1, weekKey);
  const rows = runBook(key, bars4, daily, weekly, spread, "real");
  perMarket[key] = { bars4: bars4.length, setups: rows.length, first: new Date(bars4[0].t * 1000).toISOString().slice(0, 10), last: new Date(bars4[bars4.length - 1].t * 1000).toISOString().slice(0, 10) };
  all.push(...rows);

  // fake market, same length and volatility: every fact must show nothing here
  let p = 100;
  const fake = bars4.map((b) => {
    const o = p; let hi = p, lo = p;
    for (let k = 0; k < 16; k++) { p *= 1 + 0.0025 * gauss(); if (p > hi) hi = p; if (p < lo) lo = p; }
    return { t: b.t, open: o, high: hi, low: lo, close: p };
  });
  const fakeH1 = fake;
  all.push(...runBook(key, fake, group(fakeH1, dayKey), group(fakeH1, weekKey), spread * (100 / bars4[0].close), "sim"));
  console.log(`${key.padEnd(8)} ${bars4.length} 4H candles, ${rows.length} setups`);
}

const ONLY_STRONG = !!process.env.STRONG;
const keep = (r) => !ONLY_STRONG || r.strong;
const real = all.filter((r) => r.label === "real" && keep(r)).map((r) => ({ ...r, d: r.realR - r.twinR }));
const sim = all.filter((r) => r.label === "sim" && keep(r)).map((r) => ({ ...r, d: r.realR - r.twinR }));
const mid = real.length ? [...real].sort((a, b) => a.t - b.t)[Math.floor(real.length / 2)].t : 0;

const FACTS = ["fvg", "fvgDeep", "ob", "swing", "equal", "pd", "pw", "discount", "deep", "dailyFvg"];
const pct = (x) => (x * 100).toFixed(1) + "%";
const sg = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(3) : "n/a");
const line = "=".repeat(124);

console.log(`\n${line}\nSETUPS: ${real.length} real, ${sim.length} on fake markets. 4H grid offset ${GRID}h. Target ${RR}R, stop at the manipulation wick, spread charged.`);
console.log(`Base rule, everything together: net ${sg(mean(real.map((r) => r.realR)))}R per trade, twin ${sg(mean(real.map((r) => r.twinR)))}R, difference ${sg(mean(real.map((r) => r.d)))}R`);

console.log(`\n${line}\nDID THE WICK TAP IT? each fact against the setups where it is false`);
console.log(`  ${"fact".padEnd(11)} ${"taps".padStart(6)} ${"rate".padStart(6)} ${"net R".padStart(8)} ${"twin".padStart(8)} ${"edge".padStart(8)} | ${"no tap".padStart(7)} ${"net R".padStart(8)} ${"edge".padStart(8)} | ${"gap".padStart(8)} ${"z".padStart(6)} ${"old".padStart(7)} ${"new".padStart(7)} ${"SIM z".padStart(6)}`);
const results = [];
for (const f of FACTS) {
  const T = real.filter((r) => r.facts[f]), F = real.filter((r) => !r.facts[f]);
  if (T.length < 30 || F.length < 30) { console.log(`  ${f.padEnd(11)} ${String(T.length).padStart(6)}  too few`); continue; }
  const z = clusterZ(T, F);
  const oldT = T.filter((r) => r.t < mid), newT = T.filter((r) => r.t >= mid);
  const oldF = F.filter((r) => r.t < mid), newF = F.filter((r) => r.t >= mid);
  const gap = mean(T.map((r) => r.d)) - mean(F.map((r) => r.d));
  const sT = sim.filter((r) => r.facts[f]), sF = sim.filter((r) => !r.facts[f]);
  const simZ = clusterZ(sT, sF);
  const row = {
    fact: f, n: T.length, rate: T.length / real.length,
    netT: mean(T.map((r) => r.realR)), twinT: mean(T.map((r) => r.twinR)), edgeT: mean(T.map((r) => r.d)),
    nF: F.length, netF: mean(F.map((r) => r.realR)), edgeF: mean(F.map((r) => r.d)),
    gap, z,
    oldGap: oldT.length > 20 && oldF.length > 20 ? mean(oldT.map((r) => r.d)) - mean(oldF.map((r) => r.d)) : NaN,
    newGap: newT.length > 20 && newF.length > 20 ? mean(newT.map((r) => r.d)) - mean(newF.map((r) => r.d)) : NaN,
    simZ,
  };
  results.push(row);
  console.log(`  ${f.padEnd(11)} ${String(row.n).padStart(6)} ${pct(row.rate).padStart(6)} ${sg(row.netT).padStart(8)} ${sg(row.twinT).padStart(8)} ${sg(row.edgeT).padStart(8)} | ${String(row.nF).padStart(7)} ${sg(row.netF).padStart(8)} ${sg(row.edgeF).padStart(8)} | ${sg(row.gap).padStart(8)} ${(Number.isFinite(z) ? z.toFixed(2) : "n/a").padStart(6)} ${sg(row.oldGap).padStart(7)} ${sg(row.newGap).padStart(7)} ${(Number.isFinite(simZ) ? simZ.toFixed(2) : "n/a").padStart(6)}`);
}

console.log(`\n${line}\nHOW MUCH STORY? number of zones the wick tapped at once`);
console.log(`  ${"story".padEnd(7)} ${"setups".padStart(7)} ${"share".padStart(7)} ${"net R".padStart(8)} ${"twin".padStart(8)} ${"edge".padStart(8)}`);
const byStory = [];
for (let s = 0; s <= 5; s++) {
  const G = real.filter((r) => r.story === s);
  if (!G.length) continue;
  const row = { story: s, n: G.length, share: G.length / real.length, net: mean(G.map((r) => r.realR)), twin: mean(G.map((r) => r.twinR)), edge: mean(G.map((r) => r.d)) };
  byStory.push(row);
  console.log(`  ${String(s).padEnd(7)} ${String(row.n).padStart(7)} ${pct(row.share).padStart(7)} ${sg(row.net).padStart(8)} ${sg(row.twin).padStart(8)} ${sg(row.edge).padStart(8)}`);
}
const rich = real.filter((r) => r.story >= 3), poor = real.filter((r) => r.story === 0);
if (rich.length > 30 && poor.length > 30)
  console.log(`  three or more against none: ${sg(mean(rich.map((r) => r.d)) - mean(poor.map((r) => r.d)))}R, z ${clusterZ(rich, poor).toFixed(2)}`);

// The combination the idea actually implies: a strong manipulation candle
// whose wick reached into something, against everything else.
console.log(`\n${line}\nSTRONG CANDLE AND A STORY, against the rest`);
console.log(`  ${"group".padEnd(30)} ${"setups".padStart(7)} ${"share".padStart(7)} ${"net R".padStart(8)} ${"twin".padStart(8)} ${"edge".padStart(8)}`);
const combos = [
  ["strong candle, tapped a zone", (r) => r.strong && r.story >= 1],
  ["strong candle, tapped nothing", (r) => r.strong && r.story === 0],
  ["ordinary candle, tapped a zone", (r) => !r.strong && r.story >= 1],
  ["ordinary candle, tapped nothing", (r) => !r.strong && r.story === 0],
];
const comboRows = [];
for (const [name, fn] of combos) {
  const G = real.filter(fn);
  if (G.length < 30) continue;
  const row = { name, n: G.length, share: G.length / real.length, net: mean(G.map((r) => r.realR)), twin: mean(G.map((r) => r.twinR)), edge: mean(G.map((r) => r.d)) };
  comboRows.push(row);
  console.log(`  ${name.padEnd(30)} ${String(row.n).padStart(7)} ${pct(row.share).padStart(7)} ${sg(row.net).padStart(8)} ${sg(row.twin).padStart(8)} ${sg(row.edge).padStart(8)}`);
}
const best = real.filter((r) => r.strong && r.story >= 1), rest = real.filter((r) => !(r.strong && r.story >= 1));
const comboZ = best.length > 30 && rest.length > 30 ? clusterZ(best, rest) : NaN;
const bOld = best.filter((r) => r.t < mid), bNew = best.filter((r) => r.t >= mid);
if (Number.isFinite(comboZ)) {
  console.log(`  the pick against the rest: ${sg(mean(best.map((r) => r.d)) - mean(rest.map((r) => r.d)))}R, z ${comboZ.toFixed(2)}`);
  console.log(`  and its own halves: ${sg(mean(bOld.map((r) => r.realR)))}R then ${sg(mean(bNew.map((r) => r.realR)))}R after spread`);
}

writeFileSync(process.env.OUT || "left.json", JSON.stringify({
  combos: comboRows,
  combo: Number.isFinite(comboZ) ? { n: best.length, gap: mean(best.map((r) => r.d)) - mean(rest.map((r) => r.d)), z: comboZ, net: mean(best.map((r) => r.realR)), oldNet: mean(bOld.map((r) => r.realR)), newNet: mean(bNew.map((r) => r.realR)) } : null,
  built: new Date().toISOString(), grid: GRID, rr: RR, horizon: HORIZON,
  setups: real.length, simSetups: sim.length, perMarket,
  base: { net: mean(real.map((r) => r.realR)), twin: mean(real.map((r) => r.twinR)), edge: mean(real.map((r) => r.d)) },
  facts: results, story: byStory,
  richVsPoor: rich.length > 30 && poor.length > 30 ? { gap: mean(rich.map((r) => r.d)) - mean(poor.map((r) => r.d)), z: clusterZ(rich, poor), nRich: rich.length, nPoor: poor.length } : null,
}, null, 1));
console.log(`\nnet R = per trade after spread. twin = the same trade at a random moment in the same market and weather.`);
console.log(`edge = net minus twin. gap = the edge where the fact is true minus the edge where it is false.`);
console.log(`z = that gap in standard errors, clustered by market and quarter. SIM z = the same gap on fake random-walk markets, which should be noise.`);
console.log(`\nwrote ${process.env.OUT || "left.json"}`);
