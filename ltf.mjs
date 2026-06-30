// ─────────────────────────────────────────────────────────────────────────
// LOWER-TIMEFRAME (15m) ENTRY FINDER
//
// Given a 4H double-sweep setup (former candle `prev`, sweeping candle `cur`,
// bias `dir`), this maps the two candles onto the 15m chart and hunts for the
// Sweep Of Liquidity (SOL) that is your actual entry trigger:
//
//   BEAR bias → a 15m candle takes out the FORMER 4H candle's HIGH, then closes
//               down  (grabs buy-side liquidity, rejects → short).
//   BULL bias → a 15m candle takes out the FORMER 4H candle's LOW,  then closes
//               up    (grabs sell-side liquidity, rejects → long).
//
// Scan window = former-candle open → sweeping-candle close + bufferHours,
// so both candle times are covered and the SOL can run ~1h past the 4H close.
// All times are reported in the user's display timezone (NY by default).
// ─────────────────────────────────────────────────────────────────────────
import { fmtTime } from "./deriv.mjs";
import { fetch15m } from "./source.mjs";
import { fmt } from "./detector.mjs";

const G15 = 900;     // 15m
const G4 = 14400;    // 4h

export async function analyzeLTF(inst, prev, cur, dir, opts = {}) {
  const bufSec = (opts.bufferHours ?? 1) * 3600;
  const scanStart = cur.t - bufSec;             // ~1h before the sweeping candle opens
  const scanEnd = cur.t + G4 + bufSec;          // ~1h after it closes
  const liquidity = dir === "BEAR" ? prev.high : prev.low;

  // fetch enough 15m bars to reach BACK from now to the scan window start
  // (fetches return the most recent N candles, so N must span now → scanStart)
  const now = Math.floor(Date.now() / 1000);
  const need = Math.min(Math.max(Math.ceil((now - scanStart) / G15) + 8, 40), 5000);
  let c15 = [];
  try { c15 = await fetch15m(inst, need); } catch { /* leave empty */ }

  const sols = [];
  for (const c of c15) {
    if (c.t < scanStart || c.t >= scanEnd) continue;
    if (dir === "BEAR" && c.high > liquidity && c.close < c.open) sols.push({ t: c.t, level: c.high, close: c.close });
    if (dir === "BULL" && c.low < liquidity && c.close > c.open) sols.push({ t: c.t, level: c.low, close: c.close });
  }
  return {
    dir, liquidity,
    formerZone: [prev.t, prev.t + G4],
    sweepZone: [cur.t, cur.t + G4],
    scanZone: [scanStart, scanEnd],
    sols,
    haveData: c15.length > 0,
  };
}

// Concise multi-line summary for an alert / console, times in the user's tz.
export function ltfLines(a, cfg) {
  const T = (e) => fmtTime(e, cfg.displayTzOffset, cfg.displayTzLabel);
  const side = a.dir === "BEAR" ? "high" : "low";
  const dirWord = a.dir === "BEAR" ? "down" : "up";
  const lines = [];
  lines.push(`Former 4H opens ${T(a.formerZone[0])}  ·  Sweeping 4H opens ${T(a.sweepZone[0])}`);
  lines.push(`15m: hunt a sweep of the former 4H ${side} ${fmt(a.liquidity)}, then close ${dirWord} → entry`);
  if (!a.haveData) lines.push(`(15m data unavailable right now)`);
  else if (a.sols.length) {
    const first = a.sols[0];
    lines.push(`⚡ 15m SOL @ ${T(first.t)} (took ${side} ${fmt(first.level)}, closed ${fmt(first.close)})${a.sols.length > 1 ? ` +${a.sols.length - 1} more` : ""}`);
  } else {
    lines.push(`…no 15m SOL yet — watch ${T(a.scanZone[0])} → ${T(a.scanZone[1])}`);
  }
  return lines;
}
