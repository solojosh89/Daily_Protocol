// ─────────────────────────────────────────────────────────────────────────
// ICT CHECK — does the ICT liquidity sweep model beat a random entry on 30m
// and 1H candles? 16 real markets, every setup the engine (ict.mjs) finds.
//
// Variants, fixed before running:
//   S    sweep only: enter at the sweep candle's close
//   M    sweep + market structure shift: enter at the MSS candle's close
//   F    the full ICT 2022 model: limit at the fair value gap's 50%, filled
//        within 10 candles (skipped if price reaches the target first)   ← primary
//   FK   F, sweep inside a killzone (London 02-05 or New York 07-10)
//   FH   F, and the swept pool is the previous day, Asia or London range
//   FL   F, targeting the nearest liquidity on the other side instead of 2R
//   SP   sweep only, where both of a relative pair of highs/lows were taken
//        (the left one a little further out): the user's remembered SOL setup
//   FP   SP followed by the full model
// Every trade: stop just beyond the sweep extreme, target 2R (FL: the pool),
// settled within 72 candles. Stop and target in one candle = loss.
//
// Each trade is paired with a random entry in the same market, same direction,
// same weather (ATR as % of price), same stop distance and same target in R.
// Errors are clustered by market and week. Pass rule, fixed before running:
// F beats random by 3 standard errors, the same way in the older and newer
// half, nothing on the fake random-walk markets, and positive after spread.
//
//   DATA_DIR=folder OUT=ict.json node ict-check.mjs
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "fs";
import { analyzeLiquidity, HTF_POOLS } from "./ict.mjs";
import { MARKETS, loadBars } from "./research-markets.mjs";

const MAX_BARS = 72, ENTRY_WIN = 10, RR = 2;
const VARIANTS = ["S", "M", "F", "FK", "FH", "FL", "SP", "FP"];
const NAMES = {
  S: "sweep only", M: "sweep + MSS", F: "full ICT model (FVG 50%)", FK: "full model, killzone",
  FH: "full model, day/session pool", FL: "full model, liquidity target",
  SP: "pair swept (your SOL setup)", FP: "pair swept + full model",
};

let seed = 9090;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 5150;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };

// race from candle `from`; on a limit fill the fill candle can only stop us out
function race(bars, from, dir, entry, stop, R, fillCandle = false) {
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
  return { hit: 0.5, R: Math.max(-1, Math.min(R, ((short ? entry - last : last - entry) / risk))) };
}

function study(bars, tf, key, spread, rows) {
  const { sweeps, atr } = analyzeLiquidity(bars);
  const n = bars.length, lastIdx = n - 2 - MAX_BARS - ENTRY_WIN;
  const pool = [];
  for (let q = 20; q <= lastIdx; q++) if (Number.isFinite(atr[q])) pool.push([atr[q] / bars[q].close, q]);
  pool.sort((a, b) => a[0] - b[0]);
  const W = Math.max(30, Math.floor(pool.length * 0.02));
  const twin = (w) => {
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid][0] < w) lo = mid + 1; else hi = mid; }
    const a = Math.max(0, lo - W), b = Math.min(pool.length - 1, lo + W);
    return pool[a + Math.floor(rnd() * (b - a + 1))][1];
  };
  const midT = bars[Math.floor(n / 2)].t;
  let count = 0;
  // lim = { decisionIdx, retrace }: the setup used a limit order, so its random
  // partner places the SAME limit (same retrace from the decision close, same
  // 10-candle fill window, same fill-candle rule). Comparing a limit fill with a
  // market entry is unfair: limits fill when price moves toward the stop, and
  // the fake markets exposed that bias in the first run.
  const push = (variant, ev, entryIdx, entry, stop, res, R, lim = null) => {
    const frac = Math.abs(entry - stop) / entry;
    const short = ev.dir === "SHORT";
    let t = null;
    if (!lim) {
      const q = twin(atr[entryIdx] / bars[entryIdx].close);
      const te = bars[q].close, ts = short ? te * (1 + frac) : te * (1 - frac);
      t = race(bars, q + 1, ev.dir, te, ts, R);
    } else {
      for (let tries = 0; tries < 60 && !t; tries++) {
        const q = twin(atr[lim.decisionIdx] / bars[lim.decisionIdx].close);
        const c = bars[q].close;
        const te = c * (1 + (short ? lim.retrace : -lim.retrace));
        const ts = short ? te * (1 + frac) : te * (1 - frac), risk = Math.abs(te - ts);
        const miss = short ? te - RR * risk : te + RR * risk;
        for (let k = q + 1; k <= q + ENTRY_WIN && k < n; k++) {
          const b = bars[k];
          if (short ? b.high >= te : b.low <= te) { t = race(bars, k, ev.dir, te, ts, R, true); break; }
          if (short ? b.low <= miss : b.high >= miss) break;
        }
      }
      if (!t) return;                    // no comparable random fill: leave the trade out of both arms
    }
    rows.push({
      tf, key, variant, type: ev.type, dir: ev.dir, killzone: ev.killzone,
      half: bars[entryIdx].t < midT ? "older" : "newer", cluster: `${tf}|${key}|${Math.floor(bars[entryIdx].t / 604800)}`,
      hit: res.hit, R: res.R, tHit: t.hit, tR: t.R, costR: spread / frac, month: new Date(bars[entryIdx].t * 1000).toISOString().slice(0, 7),
    });
    count++;
  };
  for (const ev of sweeps) {
    if (ev.idx > lastIdx || !Number.isFinite(ev.atr)) continue;
    const stop = ev.dir === "SHORT" ? ev.extreme + 0.1 * ev.atr : ev.extreme - 0.1 * ev.atr;
    const pair = ev.levels.some((L) => L.type === "pair");
    if (Math.abs(ev.close - stop) > 0) {
      const sres = race(bars, ev.idx + 1, ev.dir, ev.close, stop, RR);
      push("S", ev, ev.idx, ev.close, stop, sres, RR);
      if (pair) push("SP", ev, ev.idx, ev.close, stop, sres, RR);
    }
    const m = ev.mss;
    if (!m) continue;
    if ((ev.dir === "SHORT" ? m.close < m.stop : m.close > m.stop)) push("M", ev, m.idx, m.close, m.stop, race(bars, m.idx + 1, ev.dir, m.close, m.stop, RR), RR);
    // limit at the gap's 50%: filled when price comes back to it within 10 candles
    const short = ev.dir === "SHORT", risk = Math.abs(m.entry - m.stop);
    if (!(risk > 0) || (short ? m.entry >= m.stop : m.entry <= m.stop)) continue;
    const tgt2 = short ? m.entry - RR * risk : m.entry + RR * risk;
    let fill = -1;
    for (let k = m.idx + 1; k <= m.idx + ENTRY_WIN && k < n; k++) {
      const b = bars[k];
      if (short ? b.high >= m.entry : b.low <= m.entry) { fill = k; break; }
      if (short ? b.low <= tgt2 : b.high >= tgt2) break;          // ran to target without us: missed
    }
    if (fill < 0) continue;
    const res = race(bars, fill, ev.dir, m.entry, m.stop, RR, true);
    const lim = { decisionIdx: m.idx, retrace: short ? (m.entry - m.close) / m.close : (m.close - m.entry) / m.close };
    push("F", ev, fill, m.entry, m.stop, res, RR, lim);
    if (ev.killzone) push("FK", ev, fill, m.entry, m.stop, res, RR, lim);
    if (HTF_POOLS.includes(ev.type)) push("FH", ev, fill, m.entry, m.stop, res, RR, lim);
    if (pair) push("FP", ev, fill, m.entry, m.stop, res, RR, lim);
    if (m.target != null) {
      const Rm = Math.abs(m.target - m.entry) / risk;
      if (Rm >= 1 && Rm <= 6) push("FL", ev, fill, m.entry, m.stop, race(bars, fill, ev.dir, m.entry, m.stop, Rm, true), Rm, lim);
    }
  }
  return { count, sweeps: sweeps.length, mss: sweeps.filter((s) => s.mss).length };
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
  const r = cz(rs, (x) => x.R - x.tR), h = cz(rs, (x) => x.hit - x.tHit);
  return { n: rs.length, hit: mean(rs.map((x) => x.hit)), tHit: mean(rs.map((x) => x.tHit)), R: mean(rs.map((x) => x.R)), tR: mean(rs.map((x) => x.tR)), net: mean(rs.map((x) => x.R - x.costR)), dR: r, dHit: h };
}
function line(label, rs) {
  if (rs.length < 30) return `  ${label.padEnd(30)} ${String(rs.length).padStart(6)}  (too few)`;
  const s = summary(rs);
  return `  ${label.padEnd(30)} ${String(s.n).padStart(6)}  ${(s.hit * 100).toFixed(1).padStart(5)}%  ${(s.tHit * 100).toFixed(1).padStart(5)}%   ` +
    `${sg(s.R).padStart(6)}R  ${sg(s.tR).padStart(6)}R  ${(sg(s.dR.m) + " (" + sg(s.dR.z, 1) + ")").padStart(14)}${flag(s.dR.z)}  ${sg(s.net).padStart(6)}R`;
}
const header = `  ${"".padEnd(30)} ${"trades".padStart(6)}  ${"won".padStart(6)}  ${"random".padStart(6)}   ${"avg R".padStart(7)}  ${"random".padStart(7)}  ${"R diff (z)".padStart(14)}    ${"after spread".padStart(12)}`;

const rows = [];
const info = [];
for (const tf of ["60", "30"]) {
  for (const [key, sym, , spread] of MARKETS) {
    try {
      const { bars } = await loadBars(sym, tf, 20000);
      const r = study(bars, tf, key, spread, rows);
      info.push(`${key}/${tf === "60" ? "1H" : "30m"} ${bars.length} candles, ${r.sweeps} sweeps, ${r.mss} MSS`);
    } catch (e) { info.push(`${key}/${tf}: ${e.message}`); }
  }
}
// fake markets: random walks on real timestamps, so sessions and days exist
for (const tf of ["60", "30"]) {
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
console.log(info.join("\n"));

const out = {};
for (const tf of ["60", "30", "SIM60", "SIM30"]) {
  const T = rows.filter((r) => r.tf === tf);
  const label = tf === "60" ? "1H candles, 16 markets" : tf === "30" ? "30m candles, 16 markets" : `FAKE random-walk markets, ${tf.slice(3)}m (must show nothing)`;
  console.log(`\n${"=".repeat(116)}\n${label}\n${header}`);
  out[tf] = {};
  for (const v of VARIANTS) {
    const V = T.filter((r) => r.variant === v);
    console.log(line(`${v}  ${NAMES[v]}`, V));
    if (V.length >= 2) {
      const s = summary(V);
      out[tf][v] = { n: s.n, hit: s.hit, tHit: s.tHit, R: s.R, tR: s.tR, net: s.net, dR: s.dR.m, se: s.dR.se, z: s.dR.z };
    }
    if (tf.startsWith("SIM")) continue;
    if (v === "F" || v === "S") {
      for (const h of ["older", "newer"]) {
        const H = V.filter((r) => r.half === h);
        console.log(line(`     ${h} half`, H));
        if (v === "F" && H.length >= 2) out[tf][`F_${h}`] = summary(H).dR;
      }
      for (const d of ["LONG", "SHORT"]) console.log(line(`     ${d}`, V.filter((r) => r.dir === d)));
    }
    if (v === "F") {
      for (const ty of ["swing", "equal", "pair", "asia", "london", "pdh", "pdl"]) console.log(line(`     pool: ${ty}`, V.filter((r) => r.type === ty)));
    }
  }
  if (!tf.startsWith("SIM")) {
    const F = T.filter((r) => r.variant === "F");
    const months = new Set(F.map((r) => r.month)).size || 1;
    console.log(`\n  full-model trades per market per month: ${(F.length / 16 / months).toFixed(1)}`);
    console.log(`  by market (full model):`);
    for (const [key] of MARKETS) console.log(line(`     ${key}`, F.filter((r) => r.key === key)));
  }
}
console.log(`\n"won": 2R target hit before the stop within 72 candles (FL: the liquidity target). A random 2R race wins about 33%.`);
console.log(`"avg R": average result per trade in risk units, before costs. "after spread": the setup's average R minus the spread in R.`);
console.log(`z = standard errors vs the paired random entries, clustered by market-week. ▲▼ = 3 or more.`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out, null, 2));
