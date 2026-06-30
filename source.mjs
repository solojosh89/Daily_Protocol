// ─────────────────────────────────────────────────────────────────────────
// UNIFIED DATA SOURCE — picks Deriv or TradingView per instrument
//
// Each instrument in deriv.mjs's INSTRUMENTS carries a verified `dataSrc`.
// Callers (monitor/scan/review/ltf) go through here instead of touching
// deriv.mjs or tv.mjs directly, so the routing logic lives in one place.
// ─────────────────────────────────────────────────────────────────────────
import { fetchCandles as fetchDeriv, fetchAligned4H as fetchDerivAligned4H } from "./deriv.mjs";
import { fetchTVCandles } from "./tv.mjs";

// 4H candles for an instrument, in the user's `offsetHours` grid.
//   • "tv" instruments: TradingView's own 4H bars are already correctly
//     aligned to that broker's session — offsetHours is not applied.
//   • "deriv" instruments: re-bucketed to offsetHours (see deriv.mjs).
export async function fetch4H(inst, want = 6, offsetHours = 0) {
  if (inst.dataSrc === "tv") return fetchTVCandles(inst.tvSym, want, 14400);
  return fetchDerivAligned4H(inst.sym, want, offsetHours);
}

// 15-minute candles for an instrument (used by the SOL/entry finder).
export async function fetch15m(inst, count = 200) {
  if (inst.dataSrc === "tv") return fetchTVCandles(inst.tvSym, count, 900);
  return fetchDeriv(inst.sym, count, 900);
}
