// ─────────────────────────────────────────────────────────────────────────
// EXPANSION CHECK — the one bet that needs no direction.
//
// The only thing the research proved is that volatility is predictable: quiet
// stretches follow quiet ones, busy follow busy. Direction is not. So this
// tests the trade that only needs SIZE: after a squeeze, put an order on BOTH
// sides of the range. Whichever side breaks first is the trade, the other side
// is cancelled, and the stop sits at the far edge of the range.
//
//   squeeze     the last 20 candles' range, as % of price, sits in the
//               quietest quarter of its own last 200 readings
//   orders      buy stop above the 20-candle high, sell stop below the low,
//               each a tenth of an ATR beyond, live for 20 candles
//   stop        the opposite edge of the range (so one range = 1R)
//   target      2R, settled within 72 candles. Both edges in one candle = loss.
//
// Three comparisons:
//   1. the same breakout taken at ANY time, squeeze or not (does the squeeze add anything?)
//   2. a random same-weather entry with the same stop and target
//   3. fake random-walk markets, which must show nothing
//
//   DATA_DIR=folder OUT=expansion.json node expansion-check.mjs
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "fs";
import { MARKETS, loadBars } from "./research-markets.mjs";

const RANGE_N = 20, HIST_N = 200, LIVE = 20, MAX_BARS = 72, RR = 2, ATR_N = 14, GAP = 20;

let seed = 135791;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 97531;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };

function race(bars, from, dir, entry, stop, fillCandle = false) {
  const short = dir === "SHORT", risk = Math.abs(entry - stop);
  const tgt = short ? entry - RR * risk : entry + RR * risk;
  const end = Math.min(bars.length, from + MAX_BARS);
  for (let k = from; k < end; k++) {
    const b = bars[k];
    if (short ? b.high >= stop : b.low <= stop) return { hit: 0, R: -1 };
    if (fillCandle && k === from) continue;
    if (short ? b.low <= tgt : b.high >= tgt) return { hit: 1, R: RR };
  }
  const last = bars[end - 1].close;
  return { hit: 0.5, R: Math.max(-1, Math.min(RR, (short ? entry - last : last - entry) / risk)) };
}

function study(bars, tf, key, spread, rows) {
  const n = bars.length;
  const atr = new Float64Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const tr = i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low;
    if (i >= ATR_N) atr[i] = s / ATR_N;
    s += tr;
    if (i >= ATR_N) {
      const p = bars[i - ATR_N], pp = i - ATR_N ? bars[i - ATR_N - 1] : null;
      s -= pp ? Math.max(p.high - p.low, Math.abs(p.high - pp.close), Math.abs(p.low - pp.close)) : p.high - p.low;
    }
  }
  // range of the last 20 closed candles, as a share of price
  const width = new Float64Array(n).fill(NaN);
  for (let i = RANGE_N - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - RANGE_N + 1; k <= i; k++) { hi = Math.max(hi, bars[k].high); lo = Math.min(lo, bars[k].low); }
    width[i] = (hi - lo) / bars[i].close;
  }
  const lastIdx = n - 2 - MAX_BARS - LIVE;
  const pool = [];
  for (let q = 20; q <= lastIdx; q++) if (Number.isFinite(atr[q])) pool.push([atr[q] / bars[q].close, q]);
  pool.sort((a, b) => a[0] - b[0]);
  const W = Math.max(30, Math.floor(pool.length * 0.02));
  const pick = (w) => {
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid][0] < w) lo = mid + 1; else hi = mid; }
    const a = Math.max(0, lo - W), b = Math.min(pool.length - 1, lo + W);
    return pool[a + Math.floor(rnd() * (b - a + 1))][1];
  };
  const midT = bars[Math.floor(n / 2)].t;
  let lastEntry = -GAP;

  for (let j = HIST_N + RANGE_N; j <= lastIdx; j++) {
    if (!Number.isFinite(atr[j]) || !Number.isFinite(width[j])) continue;
    if (j - lastEntry < GAP) continue;                       // one trade at a time per market
    let below = 0;
    for (let k = j - HIST_N; k < j; k++) if (Number.isFinite(width[k]) && width[k] < width[j]) below++;
    const pct = below / HIST_N;
    let hi = -Infinity, lo = Infinity;
    for (let k = j - RANGE_N + 1; k <= j; k++) { hi = Math.max(hi, bars[k].high); lo = Math.min(lo, bars[k].low); }
    const buf = 0.1 * atr[j], up = hi + buf, dn = lo - buf;
    if (!(up > dn)) continue;
    // whichever side breaks first inside the next 20 candles
    let fill = -1, dir = null;
    for (let i = j + 1; i <= j + LIVE && i < n; i++) {
      const b = bars[i];
      const hitUp = b.high >= up, hitDn = b.low <= dn;
      if (hitUp && hitDn) { fill = i; dir = "BOTH"; break; }   // both in one candle: treat as an immediate loss
      if (hitUp) { fill = i; dir = "LONG"; break; }
      if (hitDn) { fill = i; dir = "SHORT"; break; }
    }
    if (fill < 0) continue;
    lastEntry = fill;
    const entry = dir === "SHORT" ? dn : up, stop = dir === "SHORT" ? up : dn;
    const res = dir === "BOTH" ? { hit: 0, R: -1 } : race(bars, fill, dir, entry, stop, true);
    const tradeDir = dir === "BOTH" ? "LONG" : dir;
    const frac = Math.abs(entry - stop) / entry;
    // random same-weather partner: market entry, same stop distance and target
    const q = pick(atr[j] / bars[j].close), te = bars[q].close;
    const ts = tradeDir === "SHORT" ? te * (1 + frac) : te * (1 - frac);
    const t = race(bars, q + 1, tradeDir, te, ts);
    rows.push({
      tf, key, squeeze: pct < 0.25, pct, dir: tradeDir, hit: res.hit, R: res.R, tHit: t.hit, tR: t.R, costR: spread / frac,
      half: bars[fill].t < midT ? "older" : "newer", cluster: `${tf}|${key}|${Math.floor(bars[fill].t / 604800)}`,
    });
  }
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function cz(rs, f) {
  const n = rs.length;
  if (n < 2) return { m: 0, se: 0, z: 0 };
  const d = rs.map(f), m = mean(d), cl = new Map();
  rs.forEach((r, i) => cl.set(r.cluster, (cl.get(r.cluster) || 0) + d[i] - m));
  let v = 0;
  for (const x of cl.values()) v += x * x;
  const se = Math.sqrt(v) / n;
  return { m, se, z: se > 0 ? m / se : 0 };
}
// two-sample difference between squeeze trades and the rest
function twoSample(a, b, f) {
  if (a.length < 30 || b.length < 30) return { m: 0, z: 0 };
  const xa = a.map(f), xb = b.map(f);
  const ma = mean(xa), mb = mean(xb);
  const va = xa.reduce((s, x) => s + (x - ma) ** 2, 0) / (xa.length - 1);
  const vb = xb.reduce((s, x) => s + (x - mb) ** 2, 0) / (xb.length - 1);
  const se = Math.sqrt(va / xa.length + vb / xb.length);
  return { m: ma - mb, z: se > 0 ? (ma - mb) / se : 0 };
}
const sg = (x, p = 2) => (x >= 0 ? "+" : "") + x.toFixed(p);
const flag = (z) => (Math.abs(z) >= 3 ? (z > 0 ? " ▲" : " ▼") : "  ");
function summary(rs) {
  const d = cz(rs, (x) => x.R - x.tR);
  return { n: rs.length, hit: mean(rs.map((x) => x.hit)), tHit: mean(rs.map((x) => x.tHit)), R: mean(rs.map((x) => x.R)), tR: mean(rs.map((x) => x.tR)), net: mean(rs.map((x) => x.R - x.costR)), d };
}
function line(label, rs) {
  if (rs.length < 30) return `  ${label.padEnd(26)} ${String(rs.length).padStart(6)}  (too few)`;
  const s = summary(rs);
  return `  ${label.padEnd(26)} ${String(s.n).padStart(6)}  ${(s.hit * 100).toFixed(1).padStart(5)}%  ${(s.tHit * 100).toFixed(1).padStart(5)}%   ` +
    `${sg(s.R).padStart(6)}R  ${sg(s.tR).padStart(6)}R  ${(sg(s.d.m) + " (" + sg(s.d.z, 1) + ")").padStart(14)}${flag(s.d.z)}  ${sg(s.net).padStart(6)}R`;
}
const header = `  ${"".padEnd(26)} ${"trades".padStart(6)}  ${"won".padStart(6)}  ${"random".padStart(6)}   ${"avg R".padStart(7)}  ${"random".padStart(7)}  ${"R diff (z)".padStart(14)}    ${"after spread".padStart(12)}`;

const rows = [];
for (const tf of ["60", "30"]) {
  for (const [key, sym, , spread] of MARKETS) {
    try { const { bars } = await loadBars(sym, tf, 20000); study(bars, tf, key, spread, rows); }
    catch (e) { console.log(`  ${key}/${tf}: ${e.message}`); }
  }
  const { bars: real } = await loadBars("FOREXCOM:EURUSD", tf, 20000);
  for (let s = 0; s < 4; s++) {
    let p = 1.1;
    const step = tf === "60" ? 0.0012 : 0.00085;
    const bars = real.map((rb) => {
      const o = p; let h = p, l = p;
      for (let k = 0; k < 12; k++) { p *= 1 + (step / Math.sqrt(12)) * gauss(); if (p > h) h = p; if (p < l) l = p; }
      return { t: rb.t, open: o, high: h, low: l, close: p };
    });
    study(bars, `SIM${tf}`, `SIM${s}`, 0.00008, rows);
  }
}

const out = {};
for (const tf of ["60", "30", "SIM60", "SIM30"]) {
  const T = rows.filter((r) => r.tf === tf);
  const sq = T.filter((r) => r.squeeze), rest = T.filter((r) => !r.squeeze);
  console.log(`\n${"=".repeat(118)}\n${tf === "60" ? "1H candles, 16 markets" : tf === "30" ? "30m candles, 16 markets" : `FAKE random-walk markets, ${tf.slice(3)}m`}\n${header}`);
  console.log(line("after a squeeze", sq));
  console.log(line("any time (no squeeze filter)", T));
  console.log(line("not a squeeze", rest));
  if (!tf.startsWith("SIM")) {
    for (const h of ["older", "newer"]) console.log(line(`   squeeze, ${h} half`, sq.filter((r) => r.half === h)));
    for (const d of ["LONG", "SHORT"]) console.log(line(`   squeeze, ${d}`, sq.filter((r) => r.dir === d)));
  }
  const vs = twoSample(sq, rest, (x) => x.R);
  console.log(`  squeeze minus the rest: ${sg(vs.m)}R a trade (${sg(vs.z, 1)} standard errors)`);
  if (sq.length >= 2) {
    const s = summary(sq), a = summary(T);
    out[tf] = { squeeze: { n: s.n, hit: s.hit, tHit: s.tHit, R: s.R, tR: s.tR, net: s.net, dR: s.d.m, se: s.d.se, z: s.d.z }, all: { n: a.n, R: a.R, tR: a.tR, net: a.net, dR: a.d.m, z: a.d.z }, vsRest: vs };
    if (!tf.startsWith("SIM")) for (const h of ["older", "newer"]) { const H = sq.filter((r) => r.half === h); if (H.length >= 2) out[tf][`squeeze_${h}`] = summary(H).d; }
  }
}
console.log(`\n"won": 2R target hit before the stop. One range = 1R, so this needs a move of twice the range.`);
console.log(`z = standard errors vs the random partners; the last line compares squeeze trades with every other breakout. ▲▼ = 3 or more.`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out, null, 2));
