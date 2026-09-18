// ─────────────────────────────────────────────────────────────────────────
// MANIPULATION CANDLE, STOP AT ITS OWN WICK — the user's rule, tested.
//
// Setup: the bot's own double-sweep candle (detector.mjs). Candle B takes both
// the high and the low of candle A, then closes one way. Close up = long,
// close down = short.
//   entry   B's close
//   stop    B's low for a long, B's high for a short (the manipulation wick,
//           no buffer, exactly as asked)
//   target  3R, or the nearest swing high above (swing low below), whichever
//           version is being tested
// Settled within 40 candles (daily) or 60 candles (4H). Stop and target in one
// candle counts as a loss.
//
// Timeframes: DAILY on 16 markets (20+ years) and 4H on the same 16 markets.
// Each trade is paired with a random entry in the same market, same direction,
// same weather, same stop distance and the same target in R. Errors clustered
// by market and quarter, split into halves, and the whole thing repeated on
// fake random-walk markets, which must show nothing.
//
// Pass rule, fixed before running: 3 standard errors vs random, the same sign
// in both halves, nothing on the fake markets, and positive after spread.
//
//   DATA_DIR=folder OUT=manip.json node manip-stop-check.mjs
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "fs";
import { detectSweep } from "./detector.mjs";
import { MARKETS, loadBars } from "./research-markets.mjs";

const HORIZON = { "1D": 40, "240": 60 };
const SWING_LOOK = 60;      // how far back to look for the nearest high/low
const ATR_N = 14;

let seed = 31415926;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 271828;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };
function simBars(src, step) {
  let p = 100;
  return src.map((b) => {
    const o = p; let h = p, l = p;
    for (let k = 0; k < 24; k++) { p *= 1 + (step / Math.sqrt(24)) * gauss(); if (p > h) h = p; if (p < l) l = p; }
    return { t: b.t, open: o, high: h, low: l, close: p };
  });
}

function race(bars, from, dir, entry, stop, R, horizon) {
  const short = dir === "SHORT", risk = Math.abs(entry - stop);
  const tgt = short ? entry - R * risk : entry + R * risk;
  const end = Math.min(bars.length, from + horizon);
  for (let k = from; k < end; k++) {
    const b = bars[k];
    if (short ? b.high >= stop : b.low <= stop) return { hit: 0, R: -1 };
    if (short ? b.low <= tgt : b.high >= tgt) return { hit: 1, R };
  }
  const last = bars[end - 1].close;
  return { hit: 0.5, R: Math.max(-1, Math.min(R, (short ? entry - last : last - entry) / risk)) };
}

function study(bars, tf, key, cls, spread, rows) {
  const n = bars.length, horizon = HORIZON[tf] || 40;
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
  const lastIdx = n - 2 - horizon;
  const pool = [];
  for (let q = ATR_N + 1; q <= lastIdx; q++) if (Number.isFinite(atr[q])) pool.push([atr[q] / bars[q].close, q]);
  pool.sort((a, b) => a[0] - b[0]);
  const W = Math.max(25, Math.floor(pool.length * 0.02));
  const pick = (w) => {
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid][0] < w) lo = mid + 1; else hi = mid; }
    const a = Math.max(0, lo - W), b = Math.min(pool.length - 1, lo + W);
    return pool[a + Math.floor(rnd() * (b - a + 1))][1];
  };
  const midT = bars[Math.floor(n / 2)].t;
  const quarter = (t) => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3)}`; };

  const push = (model, j, dir, entry, stop, R, res, strength) => {
    const frac = Math.abs(entry - stop) / entry;
    if (!(frac > 0)) return;
    const q = pick(atr[j] / bars[j].close), te = bars[q].close;
    const ts = dir === "SHORT" ? te * (1 + frac) : te * (1 - frac);
    const t = race(bars, q + 1, dir, te, ts, R, horizon);
    rows.push({
      tf, key, cls, model, dir, strength, R, hit: res.hit, r: res.R, tHit: t.hit, tR: t.R, costR: spread / frac,
      half: bars[j].t < midT ? "older" : "newer", cluster: `${tf}|${key}|${quarter(bars[j].t)}`,
    });
  };

  for (let j = ATR_N + 2; j <= lastIdx; j++) {
    if (!Number.isFinite(atr[j])) continue;
    const sig = detectSweep(bars[j - 1], bars[j]);
    if (!sig) continue;
    const dir = sig.dir === "BULL" ? "LONG" : "SHORT";
    const entry = bars[j].close, stop = dir === "LONG" ? bars[j].low : bars[j].high;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;

    // target 3R
    push("3R target", j, dir, entry, stop, 3, race(bars, j + 1, dir, entry, stop, 3, horizon), sig.strength);

    // target: the nearest swing high above (swing low below), confirmed before this candle
    let best = null;
    for (let i = Math.max(1, j - SWING_LOOK); i <= j - 2; i++) {
      const a = bars[i - 1], m = bars[i], c = bars[i + 1];
      if (dir === "LONG") {
        if (m.high > a.high && m.high > c.high && m.high > entry && (best === null || m.high < best)) best = m.high;
      } else if (m.low < a.low && m.low < c.low && m.low < entry && (best === null || m.low > best)) best = m.low;
    }
    if (best != null) {
      const Rm = Math.abs(best - entry) / risk;
      if (Rm >= 0.5 && Rm <= 10) push("nearest high/low", j, dir, entry, stop, Rm, race(bars, j + 1, dir, entry, stop, Rm, horizon), sig.strength);
    }
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
  const d = cz(rs, (x) => x.r - x.tR);
  return { n: rs.length, R: mean(rs.map((x) => x.R)), hit: mean(rs.map((x) => x.hit)), tHit: mean(rs.map((x) => x.tHit)), r: mean(rs.map((x) => x.r)), tR: mean(rs.map((x) => x.tR)), net: mean(rs.map((x) => x.r - x.costR)), d };
}
function line(label, rs) {
  if (rs.length < 30) return `  ${label.padEnd(28)} ${String(rs.length).padStart(6)}  (too few)`;
  const s = summary(rs);
  return `  ${label.padEnd(28)} ${String(s.n).padStart(6)}  ${s.R.toFixed(1).padStart(5)}R  ${(s.hit * 100).toFixed(1).padStart(5)}%  ${(s.tHit * 100).toFixed(1).padStart(5)}%   ` +
    `${sg(s.r).padStart(6)}R  ${sg(s.tR).padStart(6)}R  ${(sg(s.d.m) + " (" + sg(s.d.z, 1) + ")").padStart(14)}${flag(s.d.z)}  ${sg(s.net).padStart(6)}R`;
}
const header = `  ${"".padEnd(28)} ${"trades".padStart(6)}  ${"target".padStart(6)}  ${"won".padStart(6)}  ${"random".padStart(6)}   ${"avg R".padStart(7)}  ${"random".padStart(7)}  ${"R diff (z)".padStart(14)}    ${"after spread".padStart(12)}`;

const rows = [];
const info = [];
for (const tf of ["1D", "240"]) {
  for (const [key, sym, cls, spread] of MARKETS) {
    try {
      const { bars } = await loadBars(sym, tf, 20000);
      const before = rows.length;
      study(bars, tf, key, cls, spread, rows);
      info.push(`${key}/${tf} ${bars.length} candles, ${rows.length - before} trades`);
    } catch (e) { info.push(`${key}/${tf}: ${e.message}`); }
  }
  const { bars: real } = await loadBars("FOREXCOM:EURUSD", tf, 20000);
  for (let s = 0; s < 4; s++) study(simBars(real, tf === "1D" ? 0.006 : 0.003), `SIM${tf}`, `SIM${s}`, "sim", 0.00008, rows);
}
console.log(info.slice(0, 4).join("\n"));

const out = {};
for (const tf of ["1D", "240", "SIM1D", "SIM240"]) {
  const T = rows.filter((r) => r.tf === tf);
  const label = tf === "1D" ? "DAILY candles, 16 markets" : tf === "240" ? "4H candles, 16 markets" : `FAKE random-walk markets, ${tf.slice(3)}`;
  console.log(`\n${"=".repeat(124)}\n${label}\n${header}`);
  out[tf] = {};
  for (const model of ["3R target", "nearest high/low"]) {
    const V = T.filter((r) => r.model === model);
    console.log(line(model, V));
    if (V.length >= 2) { const s = summary(V); out[tf][model] = { n: s.n, R: s.R, hit: s.hit, tHit: s.tHit, r: s.r, tR: s.tR, net: s.net, dR: s.d.m, se: s.d.se, z: s.d.z }; }
    if (tf.startsWith("SIM")) continue;
    for (const h of ["older", "newer"]) {
      const H = V.filter((r) => r.half === h);
      console.log(line(`   ${h} half`, H));
      if (H.length >= 2) out[tf][`${model}_${h}`] = summary(H).d;
    }
    console.log(line("   STRONG candles only", V.filter((r) => r.strength === "STRONG")));
    for (const d of ["LONG", "SHORT"]) console.log(line(`   ${d}`, V.filter((r) => r.dir === d)));
    for (const c of ["metal", "index", "fx"]) console.log(line(`   ${c}`, V.filter((r) => r.cls === c)));
  }
}
console.log(`\n"target": average reward in R (3R is fixed; the nearest high/low varies). "won": target hit before the stop.`);
console.log(`A random trade with a 3R target wins about 25%. z = standard errors vs the paired random entries. ▲▼ = 3 or more.`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out, null, 2));
