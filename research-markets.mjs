// ─────────────────────────────────────────────────────────────────────────
// Shared market list and candle loader for the long-history research scripts
// (sol-check.mjs, edge-lab.mjs).
//
// TradingView's public feed gives 20 to 29 years of DAILY candles, about 3.5
// years of 4H and about 20 months of 1H. Earlier studies used 100 to 300 days,
// which is far too little to prove or disprove an edge.
//
// Set DATA_DIR to a folder of cached candles (e.g. FOREXCOM_XAUUSD_1D.json)
// to skip the download on repeat runs.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { fetchTVCandles } from "./tv.mjs";

// [key, TradingView symbol, asset class, typical spread as a fraction of price]
// Spreads are round-number retail CFD estimates, on the generous side.
export const MARKETS = [
  ["XAUUSD", "FOREXCOM:XAUUSD", "metal", 0.00015],
  ["XAGUSD", "FOREXCOM:XAGUSD", "metal", 0.0006],
  ["NAS100", "IG:NASDAQ", "index", 0.0001],
  ["SPX500", "FOREXCOM:SPXUSD", "index", 0.0001],
  ["US30", "FOREXCOM:DJI", "index", 0.0001],
  ["UK100", "FOREXCOM:UKXGBP", "index", 0.00015],
  ["JP225", "FOREXCOM:JPXJPY", "index", 0.0002],
  ["EURUSD", "FOREXCOM:EURUSD", "fx", 0.00008],
  ["GBPUSD", "FOREXCOM:GBPUSD", "fx", 0.0001],
  ["USDJPY", "FOREXCOM:USDJPY", "fx", 0.0001],
  ["AUDUSD", "FOREXCOM:AUDUSD", "fx", 0.0001],
  ["NZDUSD", "FOREXCOM:NZDUSD", "fx", 0.00015],
  ["USDCAD", "FOREXCOM:USDCAD", "fx", 0.00012],
  ["USDCHF", "FOREXCOM:USDCHF", "fx", 0.00012],
  ["GBPJPY", "FOREXCOM:GBPJPY", "fx", 0.00015],
  ["EURJPY", "FOREXCOM:EURJPY", "fx", 0.00012],
];
// US oil is left out on purpose: its CFD rolls from one futures contract to the
// next, which prints fake 15 to 37% one-day jumps.

// IG's daily Nasdaq history is broken before 2001 (a fake -40% day) and mixes
// two sets of daily candles. FOREX.com's Nasdaq 100 CFD is clean from 2008, so
// daily studies use it. 4H and 1H keep IG:NASDAQ, the feed the bot watches.
const DAILY_SYMBOL = { "IG:NASDAQ": "FOREXCOM:NSXUSD" };
const SECONDS = { "1D": 86400, "240": 14400, "60": 3600, "30": 1800 };

export async function loadBars(tvSym, res, count = 8000) {
  const sym = res === "1D" ? DAILY_SYMBOL[tvSym] || tvSym : tvSym;
  const file = process.env.DATA_DIR && join(process.env.DATA_DIR, `${sym.replace(":", "_")}_${res}.json`);
  let bars = null;
  if (file && existsSync(file)) bars = JSON.parse(readFileSync(file, "utf8"));
  for (let attempt = 0; !bars && attempt < 3; attempt++) {
    try { bars = await fetchTVCandles(sym, count, SECONDS[res], 90000); }
    catch (e) { if (attempt === 2) throw e; }
  }
  return clean(res === "1D" ? byDay(bars) : bars);
}

// A daily candle stamped late evening UTC belongs to the next calendar day.
export const dayKey = (t) => new Date((t + 12 * 3600) * 1000).toISOString().slice(0, 10);

// If a feed returns two pieces of the same trading day, join them into one candle.
export function byDay(bars) {
  const out = [];
  for (const b of [...bars].sort((x, y) => x.t - y.t)) {
    const last = out.at(-1);
    if (last && dayKey(last.t) === dayKey(b.t)) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
    } else out.push({ ...b });
  }
  return out;
}

// Bad ticks, fixed before any study sees them:
//   a wick reaching 20% beyond both neighbouring closes is trimmed to the body
//   (USDCHF printed a 0.677 low on a quiet day in 2012);
//   a close that jumps 15% and snaps straight back the next day is removed.
// Real crashes (the 2015 Swiss franc, silver in January 2026) close far away
// and stay there, so they are kept.
export function clean(bars) {
  const out = bars.filter((b) => b.high > b.low && b.close > 0).map((b) => ({ ...b })).sort((x, y) => x.t - y.t);
  let fixed = 0;
  for (let i = 1; i < out.length; i++) {
    const b = out[i], p = out[i - 1].close;
    if (b.low < 0.8 * Math.min(p, b.close)) { b.low = Math.min(b.open, b.close); fixed++; }
    if (b.high > 1.25 * Math.max(p, b.close)) { b.high = Math.max(b.open, b.close); fixed++; }
  }
  const bad = new Set();
  for (let i = 1; i < out.length - 1; i++) {
    const r1 = out[i].close / out[i - 1].close - 1, r2 = out[i + 1].close / out[i].close - 1;
    if (Math.abs(r1) > 0.15 && Math.abs(r2) > 0.12 && Math.sign(r1) !== Math.sign(r2)) bad.add(i);
  }
  return { bars: out.filter((_, i) => !bad.has(i)), dropped: fixed + bad.size };
}
