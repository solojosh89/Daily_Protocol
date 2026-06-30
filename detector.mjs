// ─────────────────────────────────────────────────────────────────────────
// 4H DOUBLE-SIDED LIQUIDITY-SWEEP DETECTOR  (pure, testable)
//
// The current 4H candle must take out BOTH extremes of the previous candle —
// sweep its HIGH *and* its LOW (an outside bar / both-sided liquidity purge) —
// then close directionally. The side OPPOSITE the close is the manipulation grab.
//
//   Required (both sides):
//     cur.high > prev.high    swept the upside liquidity
//     cur.low  < prev.low     swept the downside liquidity
//
//   Direction (intent) from the close:
//     close > open  → 🟢 BULL : the LOW sweep was the manipulation, intent is UP
//     close < open  → 🔴 BEAR : the HIGH sweep was the manipulation, intent is DOWN
//
//   STRONG — close clears the previous candle's OPEN (engulfing) AND body fills
//            ≥50% of the range ("huge body close") AND the sweeping candle's
//            body is BIGGER than the former candle's body (the second move
//            shows more conviction than the first). These are the prime setups.
//
// NOTE: OHLC alone can't prove which wick formed first inside the candle, so the
// close direction is used as the standard proxy for which side was manipulation.
//
// Returns null if it didn't sweep both sides (or closed flat), else the signal.
// ─────────────────────────────────────────────────────────────────────────

const STRONG_BODY_PCT = 0.5;

export function detectSweep(prev, cur) {
  if (!prev || !cur) return null;
  const range = cur.high - cur.low;
  if (range <= 0) return null;

  // BOTH sides must be swept — this is the core requirement.
  const sweptHigh = cur.high > prev.high;
  const sweptLow = cur.low < prev.low;
  if (!sweptHigh || !sweptLow) return null;

  if (cur.close === cur.open) return null; // need a directional close to read intent

  const body = Math.abs(cur.close - cur.open);
  const bodyPct = body / range;
  const prevBody = Math.abs(prev.close - prev.open);
  const biggerBody = body > prevBody;       // sweeping candle shows more conviction than the former one
  const bull = cur.close > cur.open;
  const dir = bull ? "BULL" : "BEAR";
  const engulf = bull ? cur.close > prev.open : cur.close < prev.open;
  const strong = engulf && bodyPct >= STRONG_BODY_PCT && biggerBody;

  return {
    dir,
    strength: strong ? "STRONG" : "NORMAL",
    sweptHigh: prev.high,            // upper liquidity that was taken
    sweptLow: prev.low,              // lower liquidity that was taken
    manipSide: bull ? "low" : "high", // the side that was the manipulation grab
    highTakeout: cur.high - prev.high, // how far above prior high
    lowTakeout: prev.low - cur.low,    // how far below prior low
    bodyPct,
    body, prevBody, biggerBody,
    engulf,
    prev, cur,
  };
}

// price precision helper for clean display
export function dec(price) {
  const a = Math.abs(price);
  if (a >= 1000) return 2;
  if (a >= 100) return 3;
  if (a >= 1) return 4;
  return 5;
}
export const fmt = (n, d = dec(n)) => Number(n).toFixed(d);
