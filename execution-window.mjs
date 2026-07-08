// ─────────────────────────────────────────────────────────────────────────
// EXECUTION-WINDOW RESEARCH — is the best entry in Candle C really in the
// first ~60-75 minutes after Candle B closes?  (the friend's hypothesis)
//
// Model: B (double-sweep) sets the bias. C = the NEXT 4H candle = execution.
// The IDEAL entry for a bias trade is C's extreme AGAINST the bias:
//   BULL bias → the LOWEST point of C is the best long entry
//   BEAR bias → the HIGHEST point of C is the best short entry
// We find that point on 15m, record HOW MANY MINUTES into C it occurred, and
// whether the trade would then have WORKED (price moved favourably afterwards).
//
// If the best entries of the winners cluster in the first 60-75 min, the window
// is real. Honest caveat: "best entry" is defined with hindsight, and we
// condition on winners — so this tells you WHEN to look, not WHETHER to trade
// (we already know the raw setup is ~coin-flip). RNG synthetics included as a
// sanity control for what "no structure" timing looks like.
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS } from "./deriv.mjs";
import { fetch4H, fetch15m } from "./source.mjs";
import { detectSweep } from "./detector.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const G4 = 14400, G15 = 900;
const REAL = ["XAUUSD", "NAS100", "GBPJPY"];
const SYNTH = ["V25", "V50", "V75", "V100"];
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);
const BUCK = [[0, 30], [30, 60], [60, 75], [75, 120], [120, 240]];

async function rowsFor(inst) {
  const c4 = await fetch4H(inst, 600, cfg.bucketOffsetHours);
  const c15 = await fetch15m(inst, 20000);
  const start15 = c15[0].t;
  const out = [];

  for (let i = 1; i < c4.length - 2; i++) {
    const s = detectSweep(c4[i - 1], c4[i]);
    if (!s) continue;
    const B = c4[i], Copen = c4[i].t + G4;      // Candle C opens when B closes
    if (Copen < start15) continue;
    const aRange = B.high - B.low || 1e-9;
    const bull = s.dir === "BULL";

    // 15m bars inside Candle C
    const cw = c15.filter((b) => b.t >= Copen && b.t < Copen + G4);
    if (cw.length < 4) continue;

    // best-entry bar = extreme against the bias
    let bestIdx = 0;
    for (let k = 1; k < cw.length; k++) {
      if (bull ? cw[k].low < cw[bestIdx].low : cw[k].high > cw[bestIdx].high) bestIdx = k;
    }
    const entryBar = cw[bestIdx];
    const entryOffsetMin = (entryBar.t - Copen) / 60;
    const entryPrice = bull ? entryBar.low : entryBar.high;

    // did it work? favourable move in bias direction AFTER the ideal entry
    const after = cw.slice(bestIdx + 1);
    if (!after.length) continue;
    const fav = bull ? Math.max(...after.map((x) => x.high)) - entryPrice
                     : entryPrice - Math.min(...after.map((x) => x.low));
    const successful = fav >= 0.5 * aRange;      // moved at least half of A's range from the ideal entry

    out.push({ entryOffsetMin, successful });
  }
  return out;
}

function report(label, rows) {
  const win = rows.filter((r) => r.successful);
  console.log(`\n${label}: ${rows.length} setups, ${win.length} "successful" (price ran ≥0.5×A-range from the ideal entry)`);
  console.log(`   best-entry timing (minutes into Candle C), among the successful ones:`);
  for (const [lo, hi] of BUCK) {
    const n = win.filter((r) => r.entryOffsetMin >= lo && r.entryOffsetMin < hi).length;
    console.log(`     ${String(lo).padStart(3)}-${String(hi).padEnd(3)} min   ${String(n).padStart(3)}   ${pct(n, win.length)}%`);
  }
  const within75 = win.filter((r) => r.entryOffsetMin < 75).length;
  console.log(`   → within first 75 min: ${pct(within75, win.length)}%`);
}

const run = async () => {
  const by = {};
  for (const inst of INSTRUMENTS.filter((i) => [...REAL, ...SYNTH].includes(i.key))) {
    try { by[inst.key] = await rowsFor(inst); } catch (e) { console.log(`${inst.key}: ${e.message}`); by[inst.key] = []; }
  }
  console.log("Does the best entry in Candle C land in the first ~75 min after Candle B closes?");
  report("REAL (Gold+Nasdaq+GBPJPY)", REAL.flatMap((k) => by[k] || []));
  report("SYNTHETIC (RNG control)", SYNTH.flatMap((k) => by[k] || []));
  console.log(`\nIf REAL clusters in the first 75 min far more than the RNG control, the window is real.`);
  console.log(`Reminder: this is WHEN-to-look among winners (hindsight best entry), not proof of edge.`);
};
run().catch((e) => { console.error(e); process.exit(1); });
