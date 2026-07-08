// ─────────────────────────────────────────────────────────────────────────
// 15m SOL CHECK — the user's manual habit, automated:
// "whenever a sweep of any side is taken, a 15min chart should be watched
//  immediately to see if a SOL is cleanly formed."
//
// The instant the forming 4H candle first takes the prior candle's high/low,
// this pulls the 15m series and answers ONE factual question about the
// breaching 15m bar:
//
//   ✅ CLEAN SOL   the breach bar closed back through the level (grab+reject)
//   ❌ NO SOL      the breach bar CLOSED beyond the level (continuation so far)
//   ⏳ FORMING     the breach bar hasn't closed yet — verdict at its close
//
// Plus context facts: rejection wick of the breach bar, extension beyond the
// level so far (%A), whether the bars since have held back inside, and the
// measured base-rate odds. NO prediction — this is a "go look" cue with
// evidence attached, because most one-side takes simply continue.
// ─────────────────────────────────────────────────────────────────────────
import { fetch15m } from "./source.mjs";

const G4 = 14400, M15 = 900;

export async function analyzeSweep15(inst, prev, cur, side) {
  const now = Math.floor(Date.now() / 1000);
  const need = Math.min(Math.max(Math.ceil((now - prev.t) / M15) + 8, 72), 500); // ≥72 so the chart always has 64 bars
  let c15;
  try { c15 = await fetch15m(inst, need); } catch { return null; }
  const win = c15.filter((b) => b.t >= cur.t && b.t < cur.t + G4);
  if (!win.length) return null;

  const level = side === "high" ? prev.high : prev.low;
  const bi = win.findIndex((b) => (side === "high" ? b.high > level : b.low < level));
  if (bi < 0) return null;
  const bar = win[bi];
  const barClosed = bar.t + M15 <= now;
  const reclaimed = side === "high" ? bar.close < level : bar.close > level;
  const range = bar.high - bar.low || 1e-9;
  const rejWickPct = 100 * (side === "high"
    ? (bar.high - Math.max(bar.open, bar.close))
    : (Math.min(bar.open, bar.close) - bar.low)) / range;
  const aR = prev.high - prev.low || 1e-9;
  const sinceBreach = win.slice(bi);
  const ext = side === "high"
    ? Math.max(...sinceBreach.map((b) => b.high)) - level
    : level - Math.min(...sinceBreach.map((b) => b.low));
  // closed bars AFTER the breach bar: have they all held back inside the level?
  const after = win.slice(bi + 1).filter((b) => b.t + M15 <= now);
  const holding = after.length
    ? after.every((b) => (side === "high" ? b.close < level : b.close > level))
    : null;
  const last = win[win.length - 1];

  return {
    side, level, breachT: bar.t, bar, barClosed, reclaimed, rejWickPct,
    extPctA: 100 * ext / aR, afterN: after.length, holding,
    priceNow: last.close,
    // chart window: enough 15m context to see prior structure + the event
    c15win: c15.slice(-64),
  };
}

// One-line factual verdict for the caption/log.
export function solVerdict(s) {
  if (!s.barClosed) return { icon: "⏳", text: "breach bar still forming — SOL verdict at its close" };
  if (s.reclaimed) return { icon: "✅", text: `CLEAN SOL — breach bar closed back ${s.side === "high" ? "below" : "above"} the level` };
  return { icon: "❌", text: `no SOL — breach bar CLOSED ${s.side === "high" ? "above" : "below"} the level (continuation so far)` };
}
