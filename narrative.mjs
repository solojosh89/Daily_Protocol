// ─────────────────────────────────────────────────────────────────────────
// CANDLE B NARRATIVE — replay the analysis candle on 15m, catalogue EVERY
// sweep, and build a factual chronological summary. No prediction.
//
// Definition of a "sweep event": a 15m bar within Candle B that pushes to a
// NEW extreme beyond Candle A's high (upside) or low (downside) — i.e. each
// time the sweep gets DEEPER on either side. That gives the progression the
// user reads on the chart (small poke → bigger poke → deepest), and the true
// chronological ORDER of which side was taken first (measured, not assumed).
//
// Reports: number of sweeps, first side, largest (major) sweep, last sweep
// before close, body vs A, range vs A — plus a timestamped narrative.
// ─────────────────────────────────────────────────────────────────────────
import { fetch15m } from "./source.mjs";
import { fmtTime } from "./deriv.mjs";
import { fmt, dec } from "./detector.mjs";
import { computeGeometry } from "./geometry.mjs";

const G4 = 14400;

export async function analyzeB(inst, A, B, dir) {
  const now = Math.floor(Date.now() / 1000);
  const need = Math.min(Math.max(Math.ceil((now - B.t) / 900) + 8, 40), 5000);
  let c15 = [];
  try { c15 = await fetch15m(inst, need); } catch { /* leave empty */ }
  const win = c15.filter((b) => b.t >= B.t && b.t < B.t + G4);

  const aRange = (A.high - A.low) || 1e-9;
  const events = [];
  let maxHigh = 0, maxLow = 0;
  for (const b of win) {
    if (b.high > A.high) { const d = b.high - A.high; if (d > maxHigh + 1e-9) { maxHigh = d; events.push({ t: b.t, side: "high", dist: d, pctA: 100 * d / aRange }); } }
    if (b.low < A.low) { const d = A.low - b.low; if (d > maxLow + 1e-9) { maxLow = d; events.push({ t: b.t, side: "low", dist: d, pctA: 100 * d / aRange }); } }
  }
  events.sort((a, b) => a.t - b.t);

  let largest = null;
  for (const e of events) if (!largest || e.dist > largest.dist) largest = e;
  if (largest) largest.isLargest = true;

  const geo = computeGeometry(A, B);
  return {
    haveData: win.length > 0,
    events,
    sweepCount: events.length,
    firstSide: events[0]?.side ?? null,
    firstTime: events[0]?.t ?? null,
    largest,
    lastSweep: events[events.length - 1] ?? null,
    bodyPctA: geo.bodyVsAPct,
    bodyDominancePct: geo.bodyDominancePct,
    rangeRatioPct: geo.rangeRatioPct,
    bodyVsAClosePct: geo.bodyVsAClosePct,
    bias: dir,
    closeT: B.t + G4,
    B,
  };
}

// One-line factual summary for the alert.
export function bSummaryLine(a) {
  if (!a.haveData) return "Candle B summary: 15m data unavailable.";
  const L = a.largest;
  const big = L ? `largest ${L.side.toUpperCase()} ${fmt(L.dist, dec(a.B.close))} (${L.pctA.toFixed(0)}% of A)` : "no sweep beyond A";
  return `Sweeps: <b>${a.sweepCount}</b> · first ${a.firstSide ? a.firstSide.toUpperCase() : "—"} · ${big} · body ${a.bodyPctA.toFixed(0)}% / range ${a.rangeRatioPct.toFixed(0)}% of A`;
}

// Chronological narrative (array of lines), times in the user's tz.
export function narrativeLines(a, cfg) {
  if (!a.haveData) return [];
  const T = (e) => fmtTime(e, cfg.displayTzOffset, cfg.displayTzLabel);
  const d = dec(a.B.close);
  const lines = [`${T(a.B.t)}  Candle B opened`];
  for (const e of a.events) {
    lines.push(`${T(e.t)}  swept ${e.side.toUpperCase()} ${fmt(e.dist, d)} (${e.pctA.toFixed(0)}% of A)${e.isLargest ? "  ← largest" : ""}`);
  }
  const dirWord = a.bias === "BULL" ? "BULLISH" : "BEARISH";
  const above = a.bodyVsAClosePct >= 0 ? "above" : "below";
  lines.push(`${T(a.closeT)}  closed ${dirWord} — body ${a.bodyPctA.toFixed(0)}% of A, range ${a.rangeRatioPct.toFixed(0)}% of A, close ${above} A body`);
  return lines;
}
