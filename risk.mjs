// ─────────────────────────────────────────────────────────────────────────
// RISK ENGINE — position sizing per setup, from account balance + risk %.
//
// The piece that decides survival: a 55%/1.6R edge still ruins an account
// that risks too much per trade. At 55%, a 5-loss streak arrives roughly
// every ~40 trades — at 1% risk that's a -5% bruise, at 10% it's -40% and
// a broken head. Size is computed so ONE stop-out = the chosen % of account.
//
// Per-instrument unit conversion (watched reals only — OTE doesn't fire on
// synthetics, and the RNG verdict says don't trade them for expectancy):
//   XAUUSD  price is USD/oz          → units = risk$ / stopDist (oz), lot=100oz
//   NAS100  index points, CFD        → contracts at $1/pt (broker-dependent!)
//   GBPJPY  price is JPY per GBP     → risk must be converted USD→JPY at spot
// ─────────────────────────────────────────────────────────────────────────
import { fetchCandles } from "./deriv.mjs";

export async function positionSize(inst, entry, stop, balance, riskPct) {
  const riskUsd = balance * (riskPct / 100);
  const dist = Math.abs(entry - stop);
  if (!(dist > 0) || !(riskUsd > 0)) return null;
  let note;
  switch (inst.key) {
    case "XAUUSD": {
      const oz = riskUsd / dist;
      note = `<b>${oz.toFixed(2)} oz</b> = ${(oz / 100).toFixed(2)} std lots (stop $${dist.toFixed(2)}/oz)`;
      break;
    }
    case "NAS100": {
      const contracts = riskUsd / dist;
      note = `<b>${contracts.toFixed(2)} contracts</b> at $1/point (check your broker's point value — IG minis differ)`;
      break;
    }
    case "GBPJPY": {
      let usdjpy = null;
      try { const c = await fetchCandles("frxUSDJPY", 2, 900); usdjpy = c[c.length - 1].close; } catch {}
      if (!usdjpy) { note = `stop ${(dist * 100).toFixed(0)} pips — USDJPY fetch failed, size manually: (risk$ × USDJPY) / stop`; break; }
      const units = (riskUsd * usdjpy) / dist;
      note = `<b>${(units / 100000).toFixed(2)} std lots</b> (stop ${(dist * 100).toFixed(0)} pips · USDJPY ${usdjpy.toFixed(2)} for conversion)`;
      break;
    }
    default: {
      note = `${(riskUsd / dist).toFixed(2)} units (generic risk$/distance — verify your contract spec)`;
    }
  }
  return { riskUsd, dist, note };
}
