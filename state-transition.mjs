// ─────────────────────────────────────────────────────────────────────────
// STATE-TRANSITION STUDY — sweep1 → market state → sweep2
//
// For each historical H4 double-sweep, reconstructs the INTRA-CANDLE order of
// events on 15m data:
//   sweep1 = whichever side (prior H4 high or low) got taken out FIRST
//   sweep2 = the other side, taken out LATER, which completes the double-sweep
//            and (per detector.mjs) determines the final close direction
//
// Three honest questions, in order of how load-bearing they are:
//   A) Does detector.mjs's assumption ("close direction tells you which side
//      was manipulation") actually match the true chronological order? This
//      was never verified until now — it's the foundation everything else
//      sits on.
//   B) What does the sweep1→sweep2 time gap actually look like? (Answers
//      "is there a fixed timing rule" — expectation: no, but let's see the
//      real distribution rather than assume.)
//   C) A first concrete state signal: after sweep1, does price FAIL to make
//      a new extreme beyond sweep1's candle in sweep1's own direction before
//      sweep2 happens? Does that "failure to continue" correlate with a
//      faster sweep2 and/or better follow-through after it?
//
// Caveat up front: this only studies setups that DID complete a double-sweep
// (detector.mjs already requires that). It cannot yet tell you the odds that
// sweep2 happens AT ALL after a lone sweep1 — that needs a control group of
// "sweep1 with no sweep2" cases, which is the natural next study.
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS } from "./deriv.mjs";
import { fetch4H, fetch15m } from "./source.mjs";
import { detectSweep } from "./detector.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const G4 = 14400;
const targetKeys = ["XAUUSD", "NAS100", "GBPJPY"];
const targets = INSTRUMENTS.filter((i) => targetKeys.includes(i.key));

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);

async function studyInstrument(inst) {
  const c4 = await fetch4H(inst, 600, cfg.bucketOffsetHours);
  const c15 = await fetch15m(inst, 20000);
  const c15Start = c15[0].t;

  const rows = [];
  for (let i = 1; i < c4.length - 1; i++) {
    const s = detectSweep(c4[i - 1], c4[i]);
    if (!s) continue;
    const cur = c4[i], prev = c4[i - 1];
    if (cur.t < c15Start) continue; // outside available 15m history

    const window = c15.filter((b) => b.t >= cur.t && b.t < cur.t + G4);
    if (!window.length) continue;

    let thighIdx = -1, tlowIdx = -1;
    for (let k = 0; k < window.length; k++) {
      if (thighIdx === -1 && window[k].high > prev.high) thighIdx = k;
      if (tlowIdx === -1 && window[k].low < prev.low) tlowIdx = k;
    }
    if (thighIdx === -1 || tlowIdx === -1) continue; // shouldn't happen if H4-level detector passed, but guard anyway

    const highFirst = thighIdx < tlowIdx;
    const expectedHighFirst = s.dir === "BEAR"; // detector.mjs assumption: BEAR -> high was manipulation (first)
    const matchesHeuristic = highFirst === expectedHighFirst;

    const sweep1Idx = highFirst ? thighIdx : tlowIdx;
    const sweep2Idx = highFirst ? tlowIdx : thighIdx;
    const sweep1 = window[sweep1Idx], sweep2 = window[sweep2Idx];
    const gapMinutes = (sweep2.t - sweep1.t) / 60;

    // "failure to continue": after sweep1, before sweep2, does price make a
    // NEW extreme beyond sweep1 candle's own high/low in sweep1's direction?
    const between = window.slice(sweep1Idx + 1, sweep2Idx);
    let failureToContinue = true; // vacuously true if no candles in between
    if (between.length) {
      failureToContinue = highFirst
        ? !between.some((b) => b.high > sweep1.high)   // sweep1 was an upside push; did it ever push higher again?
        : !between.some((b) => b.low < sweep1.low);    // sweep1 was a downside push; did it ever push lower again?
    }

    // follow-through from sweep2's close, over the next 4H/8H of 15m data (scale-fair, in H4-range units)
    const range = cur.high - cur.low;
    const idxInFull = c15.indexOf(sweep2);
    const fwd = (nBars) => {
      if (idxInFull === -1 || range <= 0) return null;
      const slice = c15.slice(idxInFull + 1, idxInFull + 1 + nBars);
      if (!slice.length) return null;
      const entry = sweep2.close;
      const fav = s.dir === "BEAR" ? entry - Math.min(...slice.map((x) => x.low)) : Math.max(...slice.map((x) => x.high)) - entry;
      const adv = s.dir === "BEAR" ? Math.max(...slice.map((x) => x.high)) - entry : entry - Math.min(...slice.map((x) => x.low));
      return { net: (fav - adv) / range };
    };

    rows.push({ matchesHeuristic, gapMinutes, failureToContinue, betweenCount: between.length, f8: fwd(32) });
  }
  return rows;
}

function reportHeuristic(label, rows) {
  const n = rows.length, ok = rows.filter((r) => r.matchesHeuristic).length;
  console.log(`  ${label.padEnd(10)} n=${n}   heuristic matched true order: ${pct(ok, n)}% (${ok}/${n})`);
}

function reportGap(label, rows) {
  const g = rows.map((r) => r.gapMinutes);
  console.log(`  ${label.padEnd(10)} n=${g.length}   median gap ${median(g).toFixed(0)}m   min ${Math.min(...g).toFixed(0)}m   max ${Math.max(...g).toFixed(0)}m`);
}

function reportState(label, rows) {
  const withGap = rows.filter((r) => r.betweenCount > 0); // only where there WAS a market-state window to observe
  const ftc = withGap.filter((r) => r.failureToContinue);
  const noFtc = withGap.filter((r) => !r.failureToContinue);
  const netPos = (arr) => { const v = arr.map((r) => r.f8).filter(Boolean); return { n: v.length, pct: pct(v.filter((x) => x.net > 0).length, v.length), medGap: median(arr.map((r) => r.gapMinutes)) }; };
  const a = netPos(ftc), b = netPos(noFtc);
  console.log(`  ${label.padEnd(10)} failure-to-continue: n=${a.n}  net>0 ${a.pct}%  median gap-to-sweep2 ${a.medGap.toFixed(0)}m`);
  console.log(`  ${"".padEnd(10)} continued anyway:     n=${b.n}  net>0 ${b.pct}%  median gap-to-sweep2 ${b.medGap.toFixed(0)}m`);
}

const run = async () => {
  let all = [];
  const perInst = [];
  for (const inst of targets) {
    try { const rows = await studyInstrument(inst); perInst.push([inst.label, rows]); all = all.concat(rows); }
    catch (e) { console.log(`${inst.label}: FAILED ${e.message}`); }
  }

  console.log("\nA) Does the close-direction heuristic (BEAR=high-first, BULL=low-first) match the TRUE intra-candle order?");
  for (const [label, rows] of perInst) reportHeuristic(label, rows);
  reportHeuristic("ALL", all);

  console.log("\nB) Time gap between sweep1 (first side taken) and sweep2 (confirming side) — is it fixed?");
  for (const [label, rows] of perInst) reportGap(label, rows);
  reportGap("ALL", all);

  console.log("\nC) State signal: after sweep1, does price FAIL to push further in sweep1's own direction before sweep2?");
  console.log("   (only counted where at least one 15m candle sits between sweep1 and sweep2)");
  for (const [label, rows] of perInst) reportState(label, rows);
  reportState("ALL", all);

  console.log("\nNote: 'net>0' = favorable move exceeded adverse over the next 8h from sweep2 (directional-edge");
  console.log("check, not a costed win rate). Sample sizes are modest — read as a first signal, not a verdict.");
};
run().catch((e) => { console.error(e); process.exit(1); });
