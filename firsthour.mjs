// ─────────────────────────────────────────────────────────────────────────
// FIRST-HOUR RULE — live paper test of the user's theory:
//   after a confirmed 4H double sweep (candle B), wait for the first hour of
//   the next candle (C) to move in the bias direction, then enter.
//
// Backtest (c-first-hour.mjs): 60% vs 45% random over 300 days, but all of it
// came from the older half; the newer half was no better than momentum. So it
// is measured live, winners and losers, before anyone trusts it.
//
// Every confirmed sweep is booked at the close of C's first hour, whichever
// way that hour went. "against" rows are the comparison: if the rule is real,
// "your way" must beat them. Stop and target sit half a normal 4H candle each
// way (1R), exactly as in the backtest, so a coin toss wins 50%.
// ─────────────────────────────────────────────────────────────────────────
export const FH_VOLN = 20;       // 4H candles that set "normal size", all BEFORE candle B
export const FH_STRONG = 0.5;    // first hour moved a quarter of a normal 4H candle your way
const HOUR = 3600;

// pending = { instKey, dir: "LONG"|"SHORT", bT }  (bT = candle B open time)
// bars4 / bars1 = [{t,open,high,low,close}] 4H and 1H, oldest first
// Returns { status: "wait" } | { status: "drop", why } | { status: "ready", setup }
export function settleFirstHour(pending, bars4, bars1, now) {
  const { instKey, dir, bT } = pending;
  const iB = bars4.findIndex((b) => b.t === bT);
  if (iB < 0) return now - bT > 3 * 86400 ? { status: "drop", why: "candle B not in the feed" } : { status: "wait" };
  if (iB < FH_VOLN) return { status: "drop", why: "not enough 4H history before B" };
  const C = bars4[iB + 1];
  if (!C) return now - bT > 4 * 86400 ? { status: "drop", why: "no candle after B" } : { status: "wait" };

  const entryT = C.t + HOUR;
  if (now < entryT) return { status: "wait" };
  const first = bars1.find((b) => b.t === C.t);
  const later = bars1.some((b) => b.t > C.t);
  if (!first) return later || now - entryT > 6 * HOUR ? { status: "drop", why: "C has no full first hour in the feed" } : { status: "wait" };
  // closed for sure once the next hour exists; otherwise allow 5 minutes for the feed
  if (!later && now < entryT + 300) return { status: "wait" };
  if (now - entryT > 24 * HOUR) return { status: "drop", why: "first hour too old to book honestly" };

  let s = 0;
  for (let k = iB - FH_VOLN; k < iB; k++) s += (bars4[k].high - bars4[k].low) / bars4[k].close;
  const frac = 0.5 * (s / FH_VOLN);           // half a normal 4H candle, as a fraction of price
  const entry = first.close, d = frac * entry, long = dir === "LONG";
  if (!(d > 0)) return { status: "drop", why: "zero candle size" };
  const move = ((first.close - first.open) / d) * (long ? 1 : -1);   // in stop-distance units

  return {
    status: "ready",
    setup: {
      instKey, tf: 60, level: null, dir,
      entry, stop: long ? entry - d : entry + d, target: long ? entry + d : entry - d,
      setupId: `FIRSTHOUR:${instKey}:${bT}`,
      source: "firsthour", grade: move > 0 ? "your way" : "against", move,
      openedAt: entryT,                         // the moment the hour closed, not when the bot noticed
    },
  };
}
