// ─────────────────────────────────────────────────────────────────────────
// FILTER STACK — do the filters traders swear by rescue the ICT model?
//
// Base trade: the full ICT 2022 model (ict.mjs): sweep of a pool, structure
// shift with a fair value gap, limit at the gap's 50% filled within 10 candles,
// stop past the sweep extreme, target 2R, settled within 72 candles.
//
// Filters, each decided from closed candles only, fixed before running:
//   with trend / against trend   price above/below its own 200-candle average
//   calm / normal / stormy       ATR as % of price, against its own last 500 candles
//   killzone                     sweep inside London 02-05 or New York 07-10 (NY time)
//   day/session pool             the swept pool was the previous day, Asia or London
//   the stack                    with trend AND killzone AND day/session pool
//
// Same-weather random partners place the SAME limit order (same retrace from the
// decision close, same fill window, same stop and target), so the comparison is
// like for like. Clustered by market-week, split into halves, run on fake
// random-walk markets too. Pass rule: 3 standard errors, same sign in both
// halves, SIM clean, positive after spread.
//
//   DATA_DIR=folder OUT=filters.json node filter-stack.mjs
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "fs";
import { analyzeLiquidity, HTF_POOLS } from "./ict.mjs";
import { MARKETS, loadBars } from "./research-markets.mjs";

const RR = 2, ENTRY_WIN = 10, MAX_BARS = 72, TREND_N = 200, VOL_N = 500;
const GROUPS = ["base", "with trend", "against trend", "calm", "normal", "stormy", "killzone", "day/session pool", "the stack"];

let seed = 777333;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 24680;
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
  const { sweeps, atr } = analyzeLiquidity(bars);
  const n = bars.length, lastIdx = n - 2 - MAX_BARS - ENTRY_WIN;
  // 200-candle average (trend) and the ATR percentile (weather), both causal
  const sma = new Float64Array(n).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) { s += bars[i].close; if (i >= TREND_N) { s -= bars[i - TREND_N].close; sma[i] = s / TREND_N; } }
  const volPct = new Float64Array(n).fill(NaN);
  for (let i = VOL_N; i < n; i++) {
    if (!Number.isFinite(atr[i])) continue;
    const v = atr[i] / bars[i].close;
    let below = 0, seen = 0;
    for (let k = i - VOL_N; k < i; k++) {
      if (!Number.isFinite(atr[k])) continue;
      seen++;
      if (atr[k] / bars[k].close < v) below++;
    }
    if (seen > 50) volPct[i] = below / seen;
  }
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

  for (const ev of sweeps) {
    const m = ev.mss;
    if (!m || m.idx > lastIdx || !Number.isFinite(ev.atr)) continue;
    const short = ev.dir === "SHORT", risk = Math.abs(m.entry - m.stop);
    if (!(risk > 0) || (short ? m.entry >= m.stop : m.entry <= m.stop)) continue;
    const miss = short ? m.entry - RR * risk : m.entry + RR * risk;
    let fill = -1;
    for (let i = m.idx + 1; i <= m.idx + ENTRY_WIN && i < n; i++) {
      const b = bars[i];
      if (short ? b.high >= m.entry : b.low <= m.entry) { fill = i; break; }
      if (short ? b.low <= miss : b.high >= miss) break;
    }
    if (fill < 0) continue;
    const res = race(bars, fill, ev.dir, m.entry, m.stop, true);

    // the same limit order at a random same-weather moment
    const frac = risk / m.entry, retrace = short ? (m.entry - m.close) / m.close : (m.close - m.entry) / m.close;
    let t = null;
    for (let tries = 0; tries < 60 && !t; tries++) {
      const q = pick(atr[m.idx] / bars[m.idx].close), c = bars[q].close;
      const te = c * (1 + (short ? retrace : -retrace)), ts = short ? te * (1 + frac) : te * (1 - frac);
      const tm = short ? te - RR * Math.abs(te - ts) : te + RR * Math.abs(te - ts);
      for (let k = q + 1; k <= q + ENTRY_WIN && k < n; k++) {
        if (short ? bars[k].high >= te : bars[k].low <= te) { t = race(bars, k, ev.dir, te, ts, true); break; }
        if (short ? bars[k].low <= tm : bars[k].high >= tm) break;
      }
    }
    if (!t) continue;

    const trend = Number.isFinite(sma[m.idx]) ? (bars[m.idx].close > sma[m.idx] ? "LONG" : "SHORT") : null;
    const p = volPct[m.idx];
    const weather = !Number.isFinite(p) ? null : p < 1 / 3 ? "calm" : p < 2 / 3 ? "normal" : "stormy";
    const htf = HTF_POOLS.includes(ev.type);
    const groups = ["base"];
    if (trend) groups.push(trend === ev.dir ? "with trend" : "against trend");
    if (weather) groups.push(weather);
    if (ev.killzone) groups.push("killzone");
    if (htf) groups.push("day/session pool");
    if (trend === ev.dir && ev.killzone && htf) groups.push("the stack");
    const row = {
      tf, key, hit: res.hit, R: res.R, tHit: t.hit, tR: t.R, costR: spread / frac,
      half: bars[fill].t < midT ? "older" : "newer", cluster: `${tf}|${key}|${Math.floor(bars[fill].t / 604800)}`,
    };
    for (const g of groups) rows.push({ ...row, group: g });
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
const sg = (x, p = 2) => (x >= 0 ? "+" : "") + x.toFixed(p);
const flag = (z) => (Math.abs(z) >= 3 ? (z > 0 ? " ▲" : " ▼") : "  ");
function summary(rs) {
  const d = cz(rs, (x) => x.R - x.tR);
  return { n: rs.length, hit: mean(rs.map((x) => x.hit)), tHit: mean(rs.map((x) => x.tHit)), R: mean(rs.map((x) => x.R)), tR: mean(rs.map((x) => x.tR)), net: mean(rs.map((x) => x.R - x.costR)), d };
}
function line(label, rs) {
  if (rs.length < 30) return `  ${label.padEnd(24)} ${String(rs.length).padStart(6)}  (too few)`;
  const s = summary(rs);
  return `  ${label.padEnd(24)} ${String(s.n).padStart(6)}  ${(s.hit * 100).toFixed(1).padStart(5)}%  ${(s.tHit * 100).toFixed(1).padStart(5)}%   ` +
    `${sg(s.R).padStart(6)}R  ${sg(s.tR).padStart(6)}R  ${(sg(s.d.m) + " (" + sg(s.d.z, 1) + ")").padStart(14)}${flag(s.d.z)}  ${sg(s.net).padStart(6)}R`;
}
const header = `  ${"".padEnd(24)} ${"trades".padStart(6)}  ${"won".padStart(6)}  ${"random".padStart(6)}   ${"avg R".padStart(7)}  ${"random".padStart(7)}  ${"R diff (z)".padStart(14)}    ${"after spread".padStart(12)}`;

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
  console.log(`\n${"=".repeat(116)}\n${tf === "60" ? "1H candles, 16 markets" : tf === "30" ? "30m candles, 16 markets" : `FAKE random-walk markets, ${tf.slice(3)}m`}\n${header}`);
  out[tf] = {};
  for (const g of GROUPS) {
    const V = T.filter((r) => r.group === g);
    console.log(line(g, V));
    if (V.length >= 2) { const s = summary(V); out[tf][g] = { n: s.n, hit: s.hit, tHit: s.tHit, R: s.R, tR: s.tR, net: s.net, dR: s.d.m, se: s.d.se, z: s.d.z }; }
    if ((g === "with trend" || g === "the stack") && !tf.startsWith("SIM")) {
      for (const h of ["older", "newer"]) {
        const H = V.filter((r) => r.half === h);
        console.log(line(`   ${h} half`, H));
        if (H.length >= 2) out[tf][`${g}_${h}`] = summary(H).d;
      }
    }
  }
}
console.log(`\nEvery filter is a slice of the same trades, so they are not independent tests. z = standard errors vs the random partners. ▲▼ = 3 or more.`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out, null, 2));
