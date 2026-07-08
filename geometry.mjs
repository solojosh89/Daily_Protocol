// ─────────────────────────────────────────────────────────────────────────
// RELATIVE GEOMETRY — Candle B measured against Candle A (the reference stick)
//
// A = the prior H4 candle (reference). B = the current/forming H4 candle.
// Everything is expressed as a % of A's range, so it generalizes across
// instruments and days. No opinion — just where B is, relative to A.
//
// The friend's refinement is respected: "coverage of A" (how much of A's
// territory B has explored, capped at 100%) is kept SEPARATE from "extension
// beyond A" (how far past A's high/low the sweep pushed) — they answer
// different questions.
// ─────────────────────────────────────────────────────────────────────────

export function computeGeometry(A, B) {
  const aRange = (A.high - A.low) || 1e-9;
  const bRange = B.high - B.low;
  const price = B.close;                       // current price so far (B's latest close)
  const body = Math.abs(B.close - B.open);
  const overlap = Math.max(0, Math.min(B.high, A.high) - Math.max(B.low, A.low));

  // ── body-relative (A's body is the reference, not just its range) ──
  const aBodyTop = Math.max(A.open, A.close);
  const aBodyBot = Math.min(A.open, A.close);
  const aBody = (aBodyTop - aBodyBot) || 1e-9;
  const bodyOverlap = Math.max(0, Math.min(B.high, aBodyTop) - Math.max(B.low, aBodyBot));

  return {
    aRange, aBody, aBodyClose: A.close,
    reachedHigh: B.high >= A.high,
    reachedLow: B.low <= A.low,
    coveragePct: 100 * overlap / aRange,                 // A's territory B has been in (0–100)
    rangeRatioPct: 100 * bRange / aRange,                // B's own range vs A's (volatility; can exceed 100)
    extAbovePct: 100 * Math.max(0, B.high - A.high) / aRange, // how far past A's high (aggression up)
    extBelowPct: 100 * Math.max(0, A.low - B.low) / aRange,   // how far past A's low  (aggression down)
    bodyVsAPct: 100 * body / aRange,                     // B body as % of A's range
    positionPct: 100 * (price - A.low) / aRange,         // where price sits in A (0=low,100=high; may exceed)
    toHigh: A.high - price,                              // distance still to A's high
    toLow: price - A.low,                                // distance still to A's low
    // body-relative measures
    bodyDominancePct: 100 * body / aBody,                // B body vs A body (>100 = B overpowers A)
    bodyReclaimedPct: 100 * bodyOverlap / aBody,         // how much of A's body B's range covers (0–100)
    bodyVsAClosePct: 100 * (price - A.close) / aRange,   // B close vs A's body close (+ = above), in A-range units
  };
}

// Remaining distance to the OPPOSITE liquidity, given which side was swept first.
// high-first → opposite is A's low; low-first → opposite is A's high.
// Uses B's furthest extreme toward that side (>0 = not yet taken).
export function remainingToOpposite(A, B, firstSide) {
  if (firstSide === "high") return { level: A.low, dist: B.low - A.low, pctA: 100 * (B.low - A.low) / ((A.high - A.low) || 1e-9) };
  return { level: A.high, dist: A.high - B.high, pctA: 100 * (A.high - B.high) / ((A.high - A.low) || 1e-9) };
}
