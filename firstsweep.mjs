// ─────────────────────────────────────────────────────────────────────────
// STAGE 2 — FIRST-SWEEP DETECTOR (mid-candle "manipulation candidate" alert)
//
// While an H4 candle is still forming, detects the moment it FIRST takes the
// prior candle's high or low, and returns a structured snapshot of the candle
// so far (wicks, body, close position, sweep distance, % elapsed).
//
// It also attaches the honest base rate from conditional-gap.mjs: given how
// early this first sweep landed, how often the OPPOSITE side actually gets
// swept before the H4 closes (the completion the whole setup depends on).
// Those odds are low — the alert says so rather than implying a setup is coming.
// ─────────────────────────────────────────────────────────────────────────
import { fetch15m } from "./source.mjs";
import { fmtTime, sessionOf, idTag } from "./deriv.mjs";
import { dec } from "./detector.mjs";
import { computeGeometry, remainingToOpposite } from "./geometry.mjs";

const G4 = 14400;

// Direction arrow for quick scanning — high sweep points up (grabbed upside
// liquidity), low sweep points down, regardless of what happens afterward.
const sideArrow = (side) => (side === "high" ? "⬆️" : "⬇️");

// P(opposite side swept before close | first sweep landed at this % elapsed),
// measured over 624 real candles in conditional-gap.mjs.
function completionOdds(sweepElapsedPct) {
  if (sweepElapsedPct < 25) return 21;
  if (sweepElapsedPct < 50) return 12;
  if (sweepElapsedPct < 75) return 7;
  return 2;
}

export async function analyzeFirstSweep(inst, prev, cur) {
  const now = Math.floor(Date.now() / 1000);
  const need = Math.min(Math.max(Math.ceil((now - cur.t) / 900) + 8, 20), 5000);
  let c15 = [];
  try { c15 = await fetch15m(inst, need); } catch { return null; }
  const win = c15.filter((b) => b.t >= cur.t && b.t < cur.t + G4);
  if (!win.length) return null;

  let side = null, at = null;
  for (const b of win) {
    if (b.high > prev.high) { side = "high"; at = b.t; break; }
    if (b.low < prev.low) { side = "low"; at = b.t; break; }
  }
  if (!side) return null; // no side taken yet

  const o = win[0].open;
  const hi = Math.max(...win.map((b) => b.high));
  const lo = Math.min(...win.map((b) => b.low));
  const c = win[win.length - 1].close;
  const range = hi - lo || 1e-9;
  const prevRange = prev.high - prev.low || 1e-9;
  const upperWick = hi - Math.max(o, c);
  const lowerWick = Math.min(o, c) - lo;
  const body = Math.abs(c - o);
  const sweepElapsedPct = 100 * ((at - cur.t) / G4);
  const distance = side === "high" ? hi - prev.high : prev.low - lo;

  // relative geometry: B (current forming candle) vs A (prior H4 candle)
  const B = { high: hi, low: lo, open: o, close: c };
  const geo = computeGeometry(prev, B);
  const rem = remainingToOpposite(prev, B, side);
  const elapsedMin = Math.round((now - cur.t) / 60);

  // Progress engine: time progress vs price progress, and their ratio (efficiency).
  const timeProgressPct = 100 * ((now - cur.t) / G4);
  const priceProgressPct = geo.rangeRatioPct;        // B's range as % of A = "how far B has travelled"
  const efficiencyPct = timeProgressPct > 0 ? 100 * priceProgressPct / timeProgressPct : 0;

  return {
    side, at, sweepElapsedPct,
    h4Open: cur.t, session: sessionOf(cur.t),
    aRange: geo.aRange, geo, rem, elapsedMin,
    timeProgressPct, priceProgressPct, efficiencyPct,
    elapsedPct: 100 * ((now - cur.t) / G4),
    distance, distancePctPrev: 100 * distance / prevRange,
    upperWickPct: 100 * upperWick / range,
    lowerWickPct: 100 * lowerWick / range,
    bodyPct: 100 * body / range,
    closeLocPct: 100 * (c - lo) / range,
    color: c > o ? "green" : "red",
    priceNow: c,
    oppositeSide: side === "high" ? "low" : "high",
    oppositeLevel: side === "high" ? prev.low : prev.high,
    completionOdds: completionOdds(sweepElapsedPct),
  };
}

// Rich snapshot text for Telegram/console, in the user's tz.
// Two DIFFERENT clocks are in play here and are kept clearly separate:
//   "Swept"  = when the sweep actually happened (fixed, in the past)
//   "As of"  = when this snapshot/report was taken (now, keeps moving)
export function firstSweepText(inst, fs, cfg, fmt) {
  const sweptT = fmtTime(fs.at, cfg.displayTzOffset, cfg.displayTzLabel);
  const nowT = fmtTime(fs.h4Open + Math.round(fs.elapsedMin * 60), cfg.displayTzOffset, cfg.displayTzLabel);
  const h4 = fmtTime(fs.h4Open, cfg.displayTzOffset, cfg.displayTzLabel);
  const g = fs.geo, d = dec(fs.priceNow);
  const sinceSweepMin = Math.max(0, fs.elapsedMin - Math.round((fs.at - fs.h4Open) / 60));
  const ext = g.extAbovePct > 0 ? `, +${g.extAbovePct.toFixed(0)}% beyond A high` : g.extBelowPct > 0 ? `, +${g.extBelowPct.toFixed(0)}% beyond A low` : "";
  // rejection wick = the wick ON the swept side (direction-normalized, so it
  // measures how hard the grabbed liquidity was rejected — not just candle colour)
  const rejWick = (fs.side === "high" ? fs.upperWickPct : fs.lowerWickPct);
  return (
    `${idTag(inst)} — ${sideArrow(fs.side)} <b>${fs.side.toUpperCase()} SWEPT</b>\n` +
    `<i>Phase 2 · first sweep · manipulation candidate</i>\n` +
    `\n` +
    `Swept: <b>${sweptT}</b> (${fs.sweepElapsedPct.toFixed(0)}% into the H4)\n` +
    `As of: ${nowT} (+${sinceSweepMin}m since the sweep)\n` +
    `H4 candle ${h4} · ${fs.session}\n` +
    `\n<b>B vs A</b> (A = prior candle, range <code>${fmt(g.aRange, d)}</code>)\n` +
    `Coverage of A: <b>${g.coveragePct.toFixed(0)}%</b>${ext}\n` +
    `B range: ${g.rangeRatioPct.toFixed(0)}% of A  ·  body: ${g.bodyVsAPct.toFixed(0)}% of A\n` +
    `Rejection wick (${fs.side}): <b>${rejWick.toFixed(0)}%</b> of candle — bigger = harder rejection\n` +
    `Body vs A: dominance <b>${g.bodyDominancePct.toFixed(0)}%</b> · reclaimed ${g.bodyReclaimedPct.toFixed(0)}% of A body · close ${g.bodyVsAClosePct >= 0 ? "+" : ""}${g.bodyVsAClosePct.toFixed(0)}% vs A close\n` +
    `Time used ${fs.timeProgressPct.toFixed(0)}%  ·  price covered ${fs.priceProgressPct.toFixed(0)}%  ·  <b>efficiency ${fs.efficiencyPct.toFixed(0)}%</b>\n` +
    `Price at ${g.positionPct.toFixed(0)}% of A (0=low, 100=high) · ${fs.color}\n` +
    `Remaining to opposite (${fs.oppositeSide} <code>${fmt(fs.oppositeLevel)}</code>): <code>${fmt(Math.max(0, fs.rem.dist), d)}</code> (${Math.max(0, fs.rem.pctA).toFixed(0)}% of A)\n` +
    `\n📊 only ~${fs.completionOdds}% of sweeps this early complete the opposite side before close`
  );
}

export function firstSweepLine(inst, fs, fmt) {
  return `${idTag(inst)}  ${sideArrow(fs.side)} ${fs.side.toUpperCase()} SWEPT @ ${fs.sweepElapsedPct.toFixed(0)}%  covA ${fs.geo.coveragePct.toFixed(0)}%  Brange ${fs.geo.rangeRatioPct.toFixed(0)}%ofA  toOpp ${fs.rem.pctA.toFixed(0)}%ofA  ${fs.color}  (compl ~${fs.completionOdds}%)`;
}

// Phase 3 — factual status snapshot while ONE side is swept and the other is not.
// Pure progress facts (time vs price vs remaining), no prediction.
export function statusText(inst, fs, cfg, fmt) {
  const g = fs.geo, d = dec(fs.priceNow);
  const h4 = fmtTime(fs.h4Open, cfg.displayTzOffset, cfg.displayTzLabel);
  const sweptT = fmtTime(fs.at, cfg.displayTzOffset, cfg.displayTzLabel);
  const nowT = fmtTime(fs.h4Open + Math.round(fs.elapsedMin * 60), cfg.displayTzOffset, cfg.displayTzLabel);
  const sinceSweepMin = Math.max(0, fs.elapsedMin - Math.round((fs.at - fs.h4Open) / 60));
  return (
    `${idTag(inst)} — ${sideArrow(fs.side)} <b>${fs.side.toUpperCase()} swept</b>, ${sideArrow(fs.oppositeSide)} ${fs.oppositeSide.toUpperCase()} waiting\n` +
    `<i>Phase 3 · status update</i>\n` +
    `\n` +
    `Swept: <b>${sweptT}</b> (${fs.sweepElapsedPct.toFixed(0)}% into the H4)\n` +
    `As of: ${nowT} (+${sinceSweepMin}m since the sweep)\n` +
    `H4 candle ${h4} · ${fs.session} · ${fs.timeProgressPct.toFixed(0)}% elapsed\n` +
    `\n` +
    `Time used <b>${fs.timeProgressPct.toFixed(0)}%</b>  ·  price covered <b>${fs.priceProgressPct.toFixed(0)}%</b>  ·  <b>efficiency ${fs.efficiencyPct.toFixed(0)}%</b>\n` +
    `Coverage of A: ${g.coveragePct.toFixed(0)}%  ·  body dominance ${g.bodyDominancePct.toFixed(0)}% · reclaimed ${g.bodyReclaimedPct.toFixed(0)}% of A body\n` +
    `Rejection wick (${fs.side}): <b>${(fs.side === "high" ? fs.upperWickPct : fs.lowerWickPct).toFixed(0)}%</b> of candle — bigger = harder rejection\n` +
    `Remaining to opposite (${fs.oppositeSide} <code>${fmt(fs.oppositeLevel)}</code>): <code>${fmt(Math.max(0, fs.rem.dist), d)}</code> (${Math.max(0, fs.rem.pctA).toFixed(0)}% of A)`
  );
}

export function statusLine(inst, fs) {
  return `${idTag(inst)}  ${sideArrow(fs.side)} first ${fs.side.toUpperCase()} swept, ${fs.oppositeSide.toUpperCase()} not yet  ·  ${fs.timeProgressPct.toFixed(0)}% time / ${fs.priceProgressPct.toFixed(0)}% price = eff ${fs.efficiencyPct.toFixed(0)}%  ·  toOpp ${Math.max(0, fs.rem.pctA).toFixed(0)}%ofA`;
}

// One-line forms for burst digests. Plain text, NOT a monospace code block:
// emoji aren't fixed-width, so space-padded columns drift and misalign in
// Telegram (esp. desktop). Emoji + bold short-name lead each line so it scans
// by colour; facts are "·"-separated, no column alignment needed.
export function firstSweepDigestLine(inst, fs) {
  const toOpp = Math.round(Math.max(0, fs.rem.pctA));
  return `${inst.emoji || "▫️"} <b>${inst.short || inst.label}</b> · ${sideArrow(fs.side)}${fs.side.toUpperCase()} @${Math.round(fs.sweepElapsedPct)}% · toOpp ${toOpp}% · compl ~${fs.completionOdds}%`;
}
export function statusDigestLine(inst, fs) {
  const toOpp = Math.round(Math.max(0, fs.rem.pctA));
  return `${inst.emoji || "▫️"} <b>${inst.short || inst.label}</b> · ${sideArrow(fs.side)}${fs.side.toUpperCase()} swept, ${fs.oppositeSide.toUpperCase()} waiting · toOpp ${toOpp}% · eff ${Math.round(fs.efficiencyPct)}%`;
}
