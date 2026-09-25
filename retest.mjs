// ─────────────────────────────────────────────────────────────────────────
// INVERTED GAP RETEST — live paper test of the user's own chart.
//
// The rule, fixed before going live and not to be adjusted while it runs:
//
//   1. Candle B takes both sides of candle A and closes one way. (The bot's
//      existing detector. B's manipulation wick is the stop, as drawn.)
//   2. Look back up to 10 candles for a fair value gap pointing the OTHER way
//      (a short inverts a bullish gap). A gap is a three candle imbalance:
//      candle j's low above candle j-2's high, or the mirror.
//   3. Within 6 candles of B, price must CLOSE through the far side of that
//      gap. That is the inversion: old support becomes resistance.
//   4. The gap must sit INSIDE B's range, between B's close and B's wick.
//      This is the user's "makes the retest happen in the bigger
//      manipulation", and it is what makes the stop smaller than entering at
//      B's close.
//   5. Within 12 candles, price comes back to the far edge of the gap. That
//      touch is the entry. If the stop is taken first, the setup is dead.
//   6. Target 2R.
//
// Backtest (ifvg-retest.mjs, 32,450 setups, 12 markets, 12 years):
//   entering at B's close   -0.073R per setup, z -9.31, reliably losing
//   this rule               +0.038R per trade, beat the close entry in 12
//                           markets out of 12, 11 of 12 on a shifted 4H grid
//   BUT z against zero is only 1.75, and it fires on 12.8% of setups.
// So it is better than the obvious entry and NOT proven profitable. That is
// exactly why it is being counted live instead of believed.
//
// One deliberate difference from the backtest: resolution starts at the
// candle AFTER the fill, so a target hit in the same candle as the entry is
// not counted. That is the conservative direction.
// ─────────────────────────────────────────────────────────────────────────
import { detectSweep } from "./detector.mjs";

export const RT = {
  FVG_LOOK: 10,      // how far back a gap may have formed, in 4H candles
  INV_WIN: 6,        // candles allowed for price to close through the gap
  RETEST_WIN: 12,    // candles allowed for the pullback into it
  RR: 2,             // target, in multiples of risk
  TF: 14400,
};

// every fair value gap formed in [from, to], as {lo, hi, dir, at}
function gapsIn(bars, from, to) {
  const out = [];
  for (let j = Math.max(2, from); j <= to; j++) {
    const a = bars[j - 2], c = bars[j];
    if (!a || !c) continue;
    if (c.low > a.high) out.push({ lo: a.high, hi: c.low, dir: 1, at: j });
    if (c.high < a.low) out.push({ lo: c.high, hi: a.low, dir: -1, at: j });
  }
  return out;
}

// pending = { instKey, dir: "LONG"|"SHORT", bT }   bars4 = [{t,open,high,low,close}] oldest first
// Returns { status:"wait" } | { status:"drop", why } | { status:"ready", setup }
export function settleRetest(pending, bars4, now) {
  const { instKey, dir, bT } = pending;
  const short = dir === "SHORT";
  const deadline = bT + (RT.INV_WIN + RT.RETEST_WIN + 2) * RT.TF;

  const iB = bars4.findIndex((b) => b.t === bT);
  if (iB < 0) return now - bT > 3 * 86400 ? { status: "drop", why: "candle B not in the feed" } : { status: "wait" };
  if (iB < RT.FVG_LOOK + 2) return { status: "drop", why: "not enough 4H history before B" };

  const B = bars4[iB];
  const stop = short ? B.high : B.low;
  const want = short ? 1 : -1;                   // a short needs a bullish gap to invert

  // most recent qualifying gap first: that is the one the chart points at
  const cands = gapsIn(bars4, iB - RT.FVG_LOOK, iB).filter((z) => z.dir === want).sort((a, b) => b.at - a.at);
  if (!cands.length) return now > deadline ? { status: "drop", why: "no fair value gap before B" } : { status: "wait" };

  for (const z of cands) {
    const limit = short ? z.hi : z.lo;           // far edge of the gap, the deepest entry
    // must sit inside the manipulation candle, between its close and its wick
    const inside = short ? limit > B.close && limit < B.high : limit < B.close && limit > B.low;
    if (!inside) continue;
    const risk = Math.abs(stop - limit);
    if (!(risk > 0)) continue;

    // the inversion: a close through the far side of the gap
    let inv = -1, invExhausted = false;
    for (let m = iB; m <= iB + RT.INV_WIN; m++) {
      const b = bars4[m];
      if (!b) break;
      if (short ? b.close < z.lo : b.close > z.hi) { inv = m; break; }
      if (m === iB + RT.INV_WIN) invExhausted = true;
    }
    if (inv < 0) { if (invExhausted) continue; return now > deadline ? { status: "drop", why: "gap never inverted" } : { status: "wait" }; }

    // the retest, or the stop, whichever comes first
    for (let k = inv + 1; k <= inv + RT.RETEST_WIN; k++) {
      const b = bars4[k];
      if (!b) return now > deadline ? { status: "drop", why: "feed ran out before the retest window closed" } : { status: "wait" };
      if (short ? b.high >= stop : b.low <= stop) return { status: "drop", why: "stop taken before the entry" };
      if (short ? b.high >= limit : b.low <= limit) {
        const sig = detectSweep(bars4[iB - 1], B);
        return {
          status: "ready",
          setup: {
            instKey, tf: 240, level: null, dir,
            entry: limit, stop,
            target: short ? limit - RT.RR * risk : limit + RT.RR * risk,
            setupId: `RETEST:${instKey}:${bT}`,
            source: "retest",
            grade: sig && sig.strength === "STRONG" ? "strong candle" : "ordinary candle",
            move: k - iB,                         // candles waited from B to the fill
            openedAt: b.t + RT.TF,                // the candle after the fill, on purpose
          },
        };
      }
    }
    return { status: "drop", why: "no retest inside 12 candles" };
  }
  return now > deadline ? { status: "drop", why: "no gap sat inside the manipulation candle" } : { status: "wait" };
}
