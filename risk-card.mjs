// ─────────────────────────────────────────────────────────────────────────
// RISK CARD — what leads every real-market setup alert, and /card on demand.
//
// The 20-year test (sol-check.mjs, edge-lab.mjs) found no setup that beats a
// random entry. What still decides whether an account survives is risk:
//   · a stop wide enough for the current weather (weather.mjs, the one proven tool)
//   · a size where one stop-out costs exactly your chosen % (risk.mjs)
//   · a daily loss limit, so a bad day stays a bad day
// riskCardText is pure and tested; buildRiskCard gathers the live inputs.
// ─────────────────────────────────────────────────────────────────────────
import { idTag } from "./deriv.mjs";
import { fetch1H } from "./source.mjs";
import { fmt, dec } from "./detector.mjs";
import { weatherReport } from "./weather.mjs";
import { positionSize } from "./risk.mjs";
import { loadTrades } from "./trades.mjs";
import { loadConfig } from "./config.mjs";

export const DAILY_LOSS_PCT = 3;

// Cached 5 minutes per pair: the forecast only changes when an hourly candle
// closes, and repeated taps or alerts should not hammer the data feed.
const WEATHER_TTL = 5 * 60;
const weatherCache = new Map();
export async function getWeather(inst) {
  const now = Math.floor(Date.now() / 1000);
  const hit = weatherCache.get(inst.key);
  if (hit && now - hit.at < WEATHER_TTL) return hit.w;
  const bars = await fetch1H(inst, 1500);
  const w = weatherReport(bars, { tfMin: 60, horizon: 4, now });
  weatherCache.set(inst.key, { at: now, w });
  return w;
}

// Distances in the units a trader actually reads on that chart.
export function distText(inst, d) {
  if (inst.key === "XAUUSD") return `$${d.toFixed(2)}`;
  if (inst.key === "NAS100") return `${d.toFixed(1)} pts`;
  if (/^[A-Z]{6}$/.test(inst.key)) return `${(d * (/JPY$/.test(inst.key) ? 100 : 10000)).toFixed(1)} pips`;
  return fmt(d, dec(d));
}

// Midnight of the current day in the display timezone, as a unix timestamp.
export function dayStart(nowS, tzOffsetHours = 0) {
  const local = nowS + tzOffsetHours * 3600;
  return nowS - (((local % 86400) + 86400) % 86400);
}

// Net money lost today on trades logged with /trade and /close, at the current
// /risk amount per trade. Wins offset losses; a green day counts as nothing lost.
export function lossToday(store, account, sinceTs) {
  const riskUsd = ((account?.balance || 0) * (account?.riskPct || 1)) / 100;
  const netR = (store?.closed || []).filter((t) => (t.closedAt || 0) >= sinceTs).reduce((a, t) => a + (t.R || 0), 0);
  return netR < 0 ? -netR * riskUsd : 0;
}

export function riskCardText({ name, w = null, dist = (d) => String(d), size = null, account = {}, lostUsd = 0, setupStopDist = null }) {
  const bal = account.balance > 0 ? account.balance : 0;
  const riskPct = account.riskPct || 1;
  const limitPct = account.dailyLossPct || DAILY_LOSS_PCT;
  const riskUsd = (bal * riskPct) / 100, limitUsd = (bal * limitPct) / 100;
  const stopped = bal > 0 && lostUsd >= limitUsd;
  const out = [`${stopped ? "🛑" : "🛡️"} <b>RISK CARD</b> · ${name}`];
  if (stopped) {
    out.push(`<b>Daily loss limit reached.</b> $${lostUsd.toFixed(2)} lost today, limit $${limitUsd.toFixed(2)} (${limitPct}%).`);
    out.push(`No new trades until tomorrow. Skipping this one protects the account.`);
  }
  if (w && w.ok) {
    const icon = w.label === "stormy" ? "⛈" : w.label === "calm" ? "☀️" : "🌤";
    out.push(`${icon} Next 4 hrs: <b>${w.label.toUpperCase()}</b>, candles ${w.vsNormal.toFixed(1)}x normal`);
    out.push(`Stop that rode out the noise ${Math.round(w.survival * 10)} times in 10: <b>${dist(w.stopDist)}</b>`);
    if (setupStopDist > 0 && setupStopDist < 0.5 * w.stopDist) {
      out.push(`⚠️ This setup's stop is only ${dist(setupStopDist)}, under half of that. Normal noise can take it out.`);
    }
  } else if (w && w.closed) {
    out.push(`💤 Market closed, no weather forecast right now.`);
  } else {
    out.push(`Weather forecast unavailable right now.`);
  }
  if (!bal) {
    out.push(`Set <code>/risk 500 1</code> to see your size and daily limit here.`);
  } else if (!stopped) {
    if (size) out.push(`Size at ${riskPct}% ($${riskUsd.toFixed(2)}): ${size.note}`);
    const left = Math.floor((limitUsd - lostUsd) / riskUsd + 1e-9);
    out.push(`Today: $${lostUsd.toFixed(2)} lost of your $${limitUsd.toFixed(2)} daily limit, ${left} full loss${left === 1 ? "" : "es"} left`);
  }
  out.push(`<i>No setup beat a random entry in 20 years of tests. Your size and stop are the part you control.</i>`);
  return out.join("\n");
}

// setupStop/entry are optional: when a setup has its own stop, the card warns
// if that stop is tighter than normal noise, and sizes from it if the weather
// forecast is unavailable.
export async function buildRiskCard(inst, { setupStop = null, entry = null, now = Math.floor(Date.now() / 1000) } = {}) {
  const cfg = loadConfig();                       // read fresh: /risk changes apply without a restart
  const account = cfg.account || {};
  let w = null;
  try { w = await getWeather(inst); } catch {}
  const setupStopDist = Number.isFinite(setupStop) && Number.isFinite(entry) ? Math.abs(entry - setupStop) : null;
  let size = null;
  if (account.balance > 0) {
    const price = w && w.ok ? w.price : entry;
    const d = w && w.ok ? w.stopDist : setupStopDist;
    if (price > 0 && d > 0) {
      try { size = await positionSize(inst, price, price - d, account.balance, account.riskPct || 1); } catch {}
    }
  }
  const lostUsd = lossToday(loadTrades(), account, dayStart(now, cfg.displayTzOffset || 0));
  return riskCardText({ name: idTag(inst), w, dist: (d) => distText(inst, d), size, account, lostUsd, setupStopDist });
}
