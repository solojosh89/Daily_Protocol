// ─────────────────────────────────────────────────────────────────────────
// FEATURE DATASET — one row per completed H4 double-sweep, + rigorous outcome
//
// Builds the ~10-feature table the PTLab research needs, writes it to
// features.csv, then does the FIRST honest check: does any single feature
// separate winners from losers? (Expectation, per the caution: probably not
// on its own — the edge, if any, is in combinations, which needs far more
// data than the ~50-90 days these feeds allow.)
//
// Outcome definition (a real, if un-costed, trade — not a vague "net>0"):
//   Entry  = H4 candle close.
//   Stop   = the manipulation extreme (the swept wick): for BEAR bias the H4
//            high, for BULL the H4 low.  Risk R = |close - that extreme|.
//   Target = 2R in the bias direction (reward:risk 2:1).
//   WIN if, over the next 8h of 15m data, target is hit before stop.
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "fs";
import { INSTRUMENTS, sessionOf } from "./deriv.mjs";
import { fetch4H, fetch15m } from "./source.mjs";
import { detectSweep } from "./detector.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const G4 = 14400;
const targetKeys = ["XAUUSD", "NAS100", "GBPJPY"];
const targets = INSTRUMENTS.filter((i) => targetKeys.includes(i.key));
const median = (a) => { const v = a.filter((x) => x != null && !isNaN(x)); if (!v.length) return NaN; const s = [...v].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);

async function extract(inst) {
  const c4 = await fetch4H(inst, 600, cfg.bucketOffsetHours);
  const c15 = await fetch15m(inst, 20000);
  const start15 = c15[0].t;
  const rows = [];

  for (let i = 1; i < c4.length - 1; i++) {
    const s = detectSweep(c4[i - 1], c4[i]);
    if (!s) continue;
    const cur = c4[i], prev = c4[i - 1];
    if (cur.t < start15) continue;

    const range = cur.high - cur.low;
    const prevRange = prev.high - prev.low || 1e-9;
    if (range <= 0) continue;

    // intra-candle sweep order on 15m
    const win = c15.filter((b) => b.t >= cur.t && b.t < cur.t + G4);
    let hi = -1, lo = -1;
    for (let k = 0; k < win.length; k++) {
      if (hi === -1 && win[k].high > prev.high) hi = k;
      if (lo === -1 && win[k].low < prev.low) lo = k;
    }
    if (hi === -1 || lo === -1) continue;
    const firstSide = hi < lo ? "high" : "low";
    const gapMin = Math.abs(win[Math.max(hi, lo)].t - win[Math.min(hi, lo)].t) / 60;

    // candle-structure features
    const upperWick = cur.high - Math.max(cur.open, cur.close);
    const lowerWick = Math.min(cur.open, cur.close) - cur.low;
    const feat = {
      inst: inst.key,
      bias: s.dir,
      strength: s.strength,
      firstSweep: firstSide,
      secondSweep: firstSide === "high" ? "low" : "high",
      upperWickPct: +(100 * upperWick / range).toFixed(1),
      lowerWickPct: +(100 * lowerWick / range).toFixed(1),
      bodyPct: +(100 * s.bodyPct).toFixed(1),
      closeLoc: +(100 * (cur.close - cur.low) / range).toFixed(1),
      color: cur.close > cur.open ? "bull" : "bear",
      manipDepthPct: +(100 * (firstSide === "high" ? (cur.high - prev.high) : (prev.low - cur.low)) / prevRange).toFixed(1),
      gapMin,
      session: sessionOf(cur.t),
      biggerBody: s.biggerBody ? 1 : 0,
    };

    // outcome: 2R vs stop-at-manipulation-extreme, from H4 close over next 8h
    const closeT = cur.t + G4;
    const fwd = c15.filter((b) => b.t >= closeT).slice(0, 32);
    let outcome = null;
    if (fwd.length) {
      if (s.dir === "BEAR") {
        const R = cur.high - cur.close, stop = cur.high, tgt = cur.close - 2 * R;
        for (const b of fwd) { if (b.high >= stop) { outcome = 0; break; } if (b.low <= tgt) { outcome = 1; break; } }
      } else {
        const R = cur.close - cur.low, stop = cur.low, tgt = cur.close + 2 * R;
        for (const b of fwd) { if (b.low <= stop) { outcome = 0; break; } if (b.high >= tgt) { outcome = 1; break; } }
      }
    }
    feat.outcome = outcome; // 1 win, 0 loss, null unresolved in 8h
    rows.push(feat);
  }
  return rows;
}

function numericSplit(rows, key) {
  const w = median(rows.filter((r) => r.outcome === 1).map((r) => r[key]));
  const l = median(rows.filter((r) => r.outcome === 0).map((r) => r[key]));
  return `win ${isNaN(w) ? "—" : w.toFixed(1)}   loss ${isNaN(l) ? "—" : l.toFixed(1)}`;
}
function catSplit(rows, key) {
  const cats = [...new Set(rows.map((r) => r[key]))];
  return cats.map((c) => { const g = rows.filter((r) => r[key] === c && r.outcome != null); return `${c} ${pct(g.filter((r) => r.outcome === 1).length, g.length)}%(n${g.length})`; }).join("  ");
}

const run = async () => {
  let all = [];
  for (const inst of targets) { try { all = all.concat(await extract(inst)); } catch (e) { console.log(`${inst.label}: ${e.message}`); } }

  const cols = Object.keys(all[0]);
  writeFileSync("features.csv", cols.join(",") + "\n" + all.map((r) => cols.map((c) => r[c]).join(",")).join("\n"));

  const resolved = all.filter((r) => r.outcome != null);
  const wins = resolved.filter((r) => r.outcome === 1).length;
  console.log(`Wrote features.csv — ${all.length} completed double-sweeps.`);
  console.log(`Resolved within 8h: ${resolved.length}   base win rate (2R vs stop-at-manip-extreme): ${pct(wins, resolved.length)}%`);
  console.log(`(2:1 R:R needs >33% just to break even before costs.)\n`);

  console.log("Does any SINGLE feature separate winners from losers? (median for wins vs losses)");
  for (const k of ["upperWickPct", "lowerWickPct", "bodyPct", "closeLoc", "manipDepthPct", "gapMin"])
    console.log(`  ${k.padEnd(14)} ${numericSplit(resolved, k)}`);

  console.log("\nWin rate by category:");
  for (const k of ["strength", "color", "firstSweep", "session"])
    console.log(`  ${k.padEnd(12)} ${catSplit(resolved, k)}`);

  console.log(`\nCaveat: n=${resolved.length} resolved is small, per-category thinner. This is a first look at`);
  console.log(`single features (expected: no lone separator). Combination-mining needs far more data than`);
  console.log(`these feeds allow (~50-90 days). features.csv is the seed dataset to keep growing.`);
};
run().catch((e) => { console.error(e); process.exit(1); });
