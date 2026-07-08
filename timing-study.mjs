// ─────────────────────────────────────────────────────────────────────────
// SOL TIMING DISTRIBUTION STUDY
//
// Question: after an H4 double-sweep candle OPENS, how long until the first
// valid 15m Sweep-Of-Liquidity (the actual entry trigger) shows up? And does
// that timing correlate with how well the trade follows through?
//
// Method (on real data, no simulation):
//   1. Find every H4 double-sweep setup in the available history per instrument.
//   2. For each, scan 15m candles from 1h before the H4 open to 1h after its
//      close, and record the time of the FIRST valid SOL (matches ltf.mjs's rule).
//   3. Bucket "minutes from H4 open to SOL" into windows.
//   4. For each SOL found, measure forward follow-through over the next 4h and
//      8h of 15m data, in units of the H4 sweeping candle's range (scale-fair
//      across instruments) — same methodology used earlier to pick GBP/JPY.
//   5. Report count, median favorable move, and % with positive net
//      (favorable > adverse) per time bucket.
//
// This is descriptive, not a cost/stop-modeled backtest — it answers "does
// entry timing matter" honestly, without dressing it up as a guaranteed edge.
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS } from "./deriv.mjs";
import { fetch4H, fetch15m } from "./source.mjs";
import { detectSweep } from "./detector.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const G4 = 14400;
const BUFFER = 3600; // 1h either side, matches ltf.mjs default

const BUCKETS = [
  { label: "before open", test: (m) => m < 0 },
  { label: "0-30m", test: (m) => m >= 0 && m < 30 },
  { label: "30-60m", test: (m) => m >= 30 && m < 60 },
  { label: "60-120m", test: (m) => m >= 60 && m < 120 },
  { label: "120-180m", test: (m) => m >= 120 && m < 180 },
  { label: "180-240m", test: (m) => m >= 180 && m < 240 },
  { label: "240m+", test: (m) => m >= 240 },
];

function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

// Only the three real-market instruments from config; synthetics carry no meaning here.
const targetKeys = ["XAUUSD", "NAS100", "GBPJPY"];
const targets = INSTRUMENTS.filter((i) => targetKeys.includes(i.key));

async function studyInstrument(inst) {
  const c4 = await fetch4H(inst, 600, cfg.bucketOffsetHours);
  const c15 = await fetch15m(inst, 20000); // capped by feed (~50-90 days)
  const c15Start = c15[0].t;

  const setups = [];
  for (let i = 1; i < c4.length - 1; i++) {
    const s = detectSweep(c4[i - 1], c4[i]);
    if (!s) continue;
    const scanStart = c4[i].t - BUFFER;
    if (scanStart < c15Start) continue; // outside available 15m history — skip, don't guess
    setups.push({ s, cur: c4[i] });
  }

  const results = [];
  for (const { s, cur } of setups) {
    const scanStart = cur.t - BUFFER;
    const scanEnd = cur.t + G4 + BUFFER;
    const liquidity = s.dir === "BEAR" ? s.sweptHigh : s.sweptLow;

    let solIdx = -1;
    for (let k = 0; k < c15.length; k++) {
      const b = c15[k];
      if (b.t < scanStart || b.t >= scanEnd) continue;
      const hit = s.dir === "BEAR" ? (b.high > liquidity && b.close < b.open) : (b.low < liquidity && b.close > b.open);
      if (hit) { solIdx = k; break; }
    }
    if (solIdx === -1) continue; // no SOL found in window — excluded, not counted as a bucket

    const sol = c15[solIdx];
    const minutesFromOpen = (sol.t - cur.t) / 60;
    const range = cur.high - cur.low;
    if (range <= 0) continue;

    // forward follow-through from the SOL's close, in units of the H4 range
    const fwd = (nBars) => {
      const slice = c15.slice(solIdx + 1, solIdx + 1 + nBars);
      if (!slice.length) return null;
      const entry = sol.close;
      const fav = s.dir === "BEAR" ? entry - Math.min(...slice.map((x) => x.low)) : Math.max(...slice.map((x) => x.high)) - entry;
      const adv = s.dir === "BEAR" ? Math.max(...slice.map((x) => x.high)) - entry : entry - Math.min(...slice.map((x) => x.low));
      return { fav: fav / range, net: (fav - adv) / range };
    };

    results.push({ minutesFromOpen, strength: s.strength, f4: fwd(16), f8: fwd(32) });
  }
  return results;
}

function report(label, rows) {
  console.log(`\n━━ ${label} — ${rows.length} setups with a found SOL`);
  for (const b of BUCKETS) {
    const inB = rows.filter((r) => b.test(r.minutesFromOpen));
    if (!inB.length) { console.log(`   ${b.label.padEnd(14)} n=0`); continue; }
    const f4 = inB.map((r) => r.f4).filter(Boolean);
    const f8 = inB.map((r) => r.f8).filter(Boolean);
    const pct = (arr) => arr.length ? Math.round(100 * arr.filter((x) => x.net > 0).length / arr.length) : 0;
    console.log(
      `   ${b.label.padEnd(14)} n=${String(inB.length).padStart(3)}  freq ${String(Math.round(100 * inB.length / rows.length)).padStart(3)}%` +
      `   4H-fwd: median-fav ${median(f4.map((x) => x.fav)).toFixed(2)}x  net>0 ${pct(f4)}%` +
      `   8H-fwd: median-fav ${median(f8.map((x) => x.fav)).toFixed(2)}x  net>0 ${pct(f8)}%`
    );
  }
}

const run = async () => {
  console.log("SOL timing distribution — real data, per-instrument feed depth limits history length.\n");
  let all = [];
  for (const inst of targets) {
    try {
      const rows = await studyInstrument(inst);
      report(inst.label, rows);
      all = all.concat(rows);
    } catch (e) { console.log(`${inst.label}: FAILED ${e.message}`); }
  }
  report("ALL COMBINED", all);
  console.log(`\nNote: "net>0" means favorable move exceeded adverse move over that forward window —`);
  console.log(`a directional-edge check, not a costed win-rate. Small per-bucket n on any single`);
  console.log(`instrument — read the COMBINED row as the more reliable signal.`);
};
run().catch((e) => { console.error(e); process.exit(1); });
