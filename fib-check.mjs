// ─────────────────────────────────────────────────────────────────────────
// FIB CHECK — after an ICT sweep (SOL) and a structure shift, does a limit
// entry at a deep retracement of the move beat a random entry?
//
// For every sweep the ICT engine (ict.mjs) confirms with a structure shift:
//   100%  = the sweep extreme (the SOL)
//     0%  = the furthest price has gone since, from closed candles only;
//           it keeps extending until an order fills
//   entry = limit at 66%, 70.5%, 78.6% or 88.6% of that move (each its own
//           test), filled within 20 candles of the shift
//   stop  = just past the sweep extreme (0.1 ATR)
//   target = the 0% point at the moment of the fill (deeper entry = bigger R)
// Settled within 72 candles; the fill candle can only stop a trade out.
//
// Each trade is paired with a random same-weather limit order: same pullback
// distance from the decision close, same fill window, same stop size and the
// same target in R. Clustered by market-week. Pass rule, fixed before running:
// 3 standard errors vs random, same sign in both halves, nothing on the fake
// random-walk markets, positive after spread.
//
//   DATA_DIR=folder OUT=fib.json node fib-check.mjs
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "fs";
import { analyzeLiquidity } from "./ict.mjs";
import { MARKETS, loadBars } from "./research-markets.mjs";

const LEVELS = [0.66, 0.705, 0.786, 0.886];
const FILL_WIN = 20, MAX_BARS = 72;

let seed = 6180;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 886;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };

function race(bars, from, dir, entry, stop, R, fillCandle) {
  const short = dir === "SHORT", risk = Math.abs(entry - stop);
  const tgt = short ? entry - R * risk : entry + R * risk;
  const end = Math.min(bars.length, from + MAX_BARS);
  for (let k = from; k < end; k++) {
    const b = bars[k];
    if (short ? b.high >= stop : b.low <= stop) return { hit: 0, R: -1 };
    if (fillCandle && k === from) continue;
    if (short ? b.low <= tgt : b.high >= tgt) return { hit: 1, R };
  }
  const last = bars[end - 1].close;
  return { hit: 0.5, R: Math.max(-1, Math.min(R, (short ? entry - last : last - entry) / risk)) };
}

function study(bars, tf, key, spread, rows) {
  const { sweeps, atr } = analyzeLiquidity(bars);
  const n = bars.length, lastIdx = n - 2 - MAX_BARS - FILL_WIN;
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
  let fills = 0;
  for (const ev of sweeps) {
    const m = ev.mss;
    if (!m || m.idx > lastIdx || !Number.isFinite(ev.atr)) continue;
    const short = ev.dir === "SHORT", A = ev.extreme;
    const stop = short ? A + 0.1 * ev.atr : A - 0.1 * ev.atr;
    let B = short ? Infinity : -Infinity;                      // 0% point: furthest price since the sweep
    for (let k = ev.idx; k <= m.idx; k++) B = short ? Math.min(B, bars[k].low) : Math.max(B, bars[k].high);
    const open = new Set(LEVELS);
    for (let i = m.idx + 1; i <= m.idx + FILL_WIN && i < n && open.size; i++) {
      const b = bars[i];
      for (const f of [...open]) {
        const lvl = short ? B + f * (A - B) : B - f * (B - A);  // level from the move known before this candle
        if (short ? b.high < lvl : b.low > lvl) continue;
        open.delete(f);
        const risk = Math.abs(lvl - stop), Rm = Math.abs(B - lvl) / risk;
        if (!(risk > 0) || Rm < 0.5) continue;
        const res = race(bars, i, ev.dir, lvl, stop, Rm, true);
        // random partner: the same limit order at a random same-weather moment
        const retrace = short ? (lvl - m.close) / m.close : (m.close - lvl) / m.close;
        const frac = risk / lvl;
        let t = null;
        for (let tries = 0; tries < 60 && !t; tries++) {
          const q = pick(atr[m.idx] / bars[m.idx].close), c = bars[q].close;
          const te = c * (1 + (short ? retrace : -retrace)), ts = short ? te * (1 + frac) : te * (1 - frac);
          for (let k = q + 1; k <= q + FILL_WIN && k < n; k++) {
            if (short ? bars[k].high >= te : bars[k].low <= te) { t = race(bars, k, ev.dir, te, ts, Rm, true); break; }
          }
        }
        if (!t) continue;
        rows.push({
          tf, key, level: f, type: ev.type, dir: ev.dir, R: res.R, hit: res.hit, tR: t.R, tHit: t.hit, Rm, costR: spread / frac,
          half: bars[i].t < midT ? "older" : "newer", cluster: `${tf}|${key}|${Math.floor(bars[i].t / 604800)}`,
        });
        fills++;
      }
      B = short ? Math.min(B, b.low) : Math.max(B, b.high);    // the move can still extend after this candle
      if (short ? b.high > A : b.low < A) break;               // sweep extreme taken: setup over
    }
  }
  return fills;
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
  return { n: rs.length, hit: mean(rs.map((x) => x.hit)), tHit: mean(rs.map((x) => x.tHit)), Rm: mean(rs.map((x) => x.Rm)), R: mean(rs.map((x) => x.R)), tR: mean(rs.map((x) => x.tR)), net: mean(rs.map((x) => x.R - x.costR)), d };
}
function line(label, rs) {
  if (rs.length < 30) return `  ${label.padEnd(26)} ${String(rs.length).padStart(6)}  (too few)`;
  const s = summary(rs);
  return `  ${label.padEnd(26)} ${String(s.n).padStart(6)}  ${s.Rm.toFixed(1).padStart(5)}R  ${(s.hit * 100).toFixed(1).padStart(5)}%  ${(s.tHit * 100).toFixed(1).padStart(5)}%   ` +
    `${sg(s.R).padStart(6)}R  ${sg(s.tR).padStart(6)}R  ${(sg(s.d.m) + " (" + sg(s.d.z, 1) + ")").padStart(14)}${flag(s.d.z)}  ${sg(s.net).padStart(6)}R`;
}
const header = `  ${"".padEnd(26)} ${"trades".padStart(6)}  ${"target".padStart(6)}  ${"won".padStart(6)}  ${"random".padStart(6)}   ${"avg R".padStart(7)}  ${"random".padStart(7)}  ${"R diff (z)".padStart(14)}    ${"after spread".padStart(12)}`;

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
  const label = tf === "60" ? "1H candles, 16 markets" : tf === "30" ? "30m candles, 16 markets" : `FAKE random-walk markets, ${tf.slice(3)}m (must show nothing)`;
  console.log(`\n${"=".repeat(118)}\n${label}\n${header}`);
  out[tf] = {};
  for (const f of LEVELS) {
    const V = T.filter((r) => r.level === f);
    console.log(line(`entry at ${(f * 100).toFixed(1)}%`, V));
    if (V.length >= 2) { const s = summary(V); out[tf][f] = { n: s.n, Rm: s.Rm, hit: s.hit, tHit: s.tHit, R: s.R, tR: s.tR, net: s.net, dR: s.d.m, se: s.d.se, z: s.d.z }; }
    if (tf.startsWith("SIM")) continue;
    for (const h of ["older", "newer"]) {
      const H = V.filter((r) => r.half === h);
      console.log(line(`   ${h} half`, H));
      if (H.length >= 2) out[tf][`${f}_${h}`] = summary(H).d;
    }
  }
  if (tf.startsWith("SIM")) continue;
  const deep = T.filter((r) => r.level === 0.786);
  console.log(`\n  78.6% entry by swept pool and direction`);
  for (const ty of ["swing", "equal", "pair", "asia", "london", "pdh", "pdl"]) console.log(line(`   pool: ${ty}`, deep.filter((r) => r.type === ty)));
  for (const d of ["LONG", "SHORT"]) console.log(line(`   ${d}`, deep.filter((r) => r.dir === d)));
}
console.log(`\n"target": average reward in R when the move's end is the target (deeper entries risk less for more).`);
console.log(`"won": target hit before the stop within 72 candles. A random trade wins about 1 / (1 + target R).`);
console.log(`"avg R": average result per trade in risk units, before costs. z = standard errors vs random partners. ▲▼ = 3 or more.`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out, null, 2));
