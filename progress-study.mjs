// ─────────────────────────────────────────────────────────────────────────
// PROGRESS-MILESTONE STUDY — after sweep1, does progress toward the opposite
// side predict completion of the double-sweep? And how fast do completers
// finish once they cross a threshold?
//
// Progress = how far B's extreme has travelled back across A's range toward
// the un-swept side (monotonic: uses B's running extreme, not current price,
// so a threshold crossing can't "un-happen"). 100% = opposite side touched.
//
//   low swept first  → progress = (runningMaxHigh − A.low) / A.range
//   high swept first → progress = (A.high − runningMinLow) / A.range
//
// For each threshold T: P(completes before close | progress crossed T), and
// median minutes from crossing T to completion among completers.
//
// Synthetics are run as the usual control: if reals ≈ RNG, the odds are pure
// random-walk geometry — still real odds worth showing in alerts, but labeled
// as geometry, not "structure".
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS } from "./deriv.mjs";
import { fetch4H, fetch15m } from "./source.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const G4 = 14400;
const REAL = ["XAUUSD", "NAS100", "GBPJPY"];
const SYNTH = ["V25", "V25S", "V50", "V50S", "V75", "V75S", "V100", "V100S"];
const THRESH = [30, 50, 70, 90];
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function study(inst) {
  const c4 = await fetch4H(inst, 600, inst.offset ?? cfg.bucketOffsetHours);
  const c15 = await fetch15m(inst, 20000);
  const start15 = c15[0].t;
  const rows = [];

  for (let i = 1; i < c4.length - 1; i++) {
    const A = c4[i - 1], B = c4[i];
    if (B.t < start15) continue;
    const win = c15.filter((b) => b.t >= B.t && b.t < B.t + G4);
    if (win.length < 8) continue;
    const range = A.high - A.low;
    if (range <= 0) continue;

    // first sweep side (skip the rare bar that takes both sides at once —
    // no progression to study there)
    let side = null, s1 = -1;
    for (let k = 0; k < win.length; k++) {
      const hi = win[k].high > A.high, lo = win[k].low < A.low;
      if (hi && lo) { side = "both"; break; }
      if (hi) { side = "high"; s1 = k; break; }
      if (lo) { side = "low"; s1 = k; break; }
    }
    if (!side || side === "both") continue;

    let runHi = -Infinity, runLo = Infinity;
    let complete = false, compK = -1;
    const crossK = {};
    for (let k = s1; k < win.length; k++) {
      runHi = Math.max(runHi, win[k].high);
      runLo = Math.min(runLo, win[k].low);
      const prog = side === "low" ? 100 * (runHi - A.low) / range : 100 * (A.high - runLo) / range;
      for (const T of THRESH) if (prog >= T && crossK[T] === undefined) crossK[T] = k;
      if (!complete && (side === "low" ? runHi > A.high : runLo < A.low)) { complete = true; compK = k; }
    }
    rows.push({ complete, crossK, compK });
  }
  return rows;
}

function report(label, rows) {
  const total = rows.length, comp = rows.filter((r) => r.complete).length;
  console.log(`\n${label}: ${total} first-sweep candles, base completion ${pct(comp, total)}%`);
  console.log(`   crossed   n     P(completes)   median mins cross→done`);
  for (const T of THRESH) {
    const crossed = rows.filter((r) => r.crossK[T] !== undefined);
    const done = crossed.filter((r) => r.complete);
    const mins = median(done.map((r) => (r.compK - r.crossK[T]) * 15));
    console.log(`   ${String(T).padStart(3)}%    ${String(crossed.length).padStart(4)}      ${String(pct(done.length, crossed.length)).padStart(3)}%          ${isNaN(mins) ? "—" : "~" + mins + "m"}`);
  }
}

const run = async () => {
  const by = {};
  for (const inst of INSTRUMENTS.filter((i) => [...REAL, ...SYNTH].includes(i.key))) {
    try { by[inst.key] = await study(inst); } catch (e) { console.log(`${inst.key}: ${e.message}`); by[inst.key] = []; }
  }
  console.log("Does progress toward the opposite side predict double-sweep completion?");
  report("REAL (Gold+Nasdaq+GBPJPY)", REAL.flatMap((k) => by[k] || []));
  report("SYNTHETIC (RNG control)", SYNTH.flatMap((k) => by[k] || []));
  console.log(`\nIf REAL ≈ SYNTHETIC, the odds are random-walk geometry (still true odds — just not "structure").`);
};
run().catch((e) => { console.error(e); process.exit(1); });
