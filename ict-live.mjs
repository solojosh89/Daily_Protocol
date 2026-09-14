// ─────────────────────────────────────────────────────────────────────────
// ICT LIVE — the wording for ICT liquidity alerts and the /liquidity map.
// Pure functions (tested); monitor.mjs and commands.mjs fetch the candles and
// run the engine in ict.mjs.
// ─────────────────────────────────────────────────────────────────────────
import { nyTime } from "./ict.mjs";
import { fmt, dec } from "./detector.mjs";

// What the engine did before going live (ict-check.mjs, 16 real markets, each
// trade paired with a same-weather random entry using the same order type).
// won/rnd = % of trades that hit 2R before the stop; net = average R after spread.
export const ICT_TESTED = {
  60: {
    sweep: { n: 30398, won: 31.7, rnd: 32.4, net: -0.20 },
    full: { n: 1985, won: 34.1, rnd: 32.4, net: -0.03 },
    pair: { n: 6488, won: 31.6, rnd: 30.6, net: -0.19 },
  },
  30: {
    sweep: { n: 21942, won: 32.6, rnd: 31.7, net: -0.25 },
    full: { n: 1474, won: 34.3, rnd: 33.5, net: -0.05 },
    pair: { n: 5332, won: 32.6, rnd: 30.4, net: -0.24 },
  },
};

// Pools worth a heads-up: the day, the sessions, and stacked highs/lows. A lone
// swing high/low is swept several times a day, so it only matters inside a setup.
export const STRONG_POOLS = new Set(["pdh", "pdl", "asia", "london", "equal", "pair"]);
const RANKS = { pdh: 5, pdl: 5, london: 4, asia: 4, pair: 3.5, equal: 3, swing: 1 };

export function poolName(type, side) {
  switch (type) {
    case "pdh": return "previous day high";
    case "pdl": return "previous day low";
    case "asia": return `Asia ${side}`;
    case "london": return `London ${side}`;
    case "equal": return `equal ${side}s`;
    case "pair": return `relative ${side}s (left one further out)`;
    default: return `swing ${side}`;
  }
}
export const tfLabel = (tf) => (tf >= 60 ? `${tf / 60}H` : `${tf}m`);
export function nyClock(t) {
  const n = nyTime(t);
  return `${String(n.h).padStart(2, "0")}:${String(n.minutes % 60).padStart(2, "0")} NY`;
}
const nyStamp = (t) => `${nyTime(t).date.slice(5)} ${nyClock(t)}`;
export const closedBars = (bars, tfMin, now) => bars.filter((b) => b.t + tfMin * 60 <= now);
const mainPool = (ev) => ev.levels.reduce((a, x) => ((RANKS[x.type] || 0) > (RANKS[a.type] || 0) ? x : a));
const sideOf = (dir) => (dir === "SHORT" ? "high" : "low");

export function sweepText({ name, tf, ev, d = dec(ev.close) }) {
  const L = mainPool(ev), s = sideOf(ev.dir), T = ICT_TESTED[tf]?.sweep;
  const more = ev.levels.length - 1;
  return (
    `💧 <b>${ev.dir === "SHORT" ? "BUY-SIDE" : "SELL-SIDE"} LIQUIDITY SWEPT</b> · ${name} · ${tfLabel(tf)}\n` +
    `Took the <b>${poolName(L.type, s)}</b> <code>${fmt(L.price, d)}</code>${more ? ` and ${more} more pool${more > 1 ? "s" : ""}` : ""}, closed back ${ev.dir === "SHORT" ? "below" : "above"} at <code>${fmt(ev.close, d)}</code>\n` +
    `${nyClock(ev.t)} candle${ev.killzone ? ` · ${ev.session === "london" ? "London" : "New York"} killzone` : ""} · sweep ${s} <code>${fmt(ev.extreme, d)}</code>\n` +
    (ev.ref != null ? `A structure shift needs a body close ${ev.dir === "SHORT" ? "below" : "above"} <code>${fmt(ev.ref, d)}</code> within 10 candles.\n` : "") +
    (T ? `<i>Not an entry. Tested on 16 markets, a sweep alone won ${T.won}% against ${T.rnd}% for random entries at 2R (${T.n.toLocaleString("en-US")} trades) and lost ${Math.abs(T.net).toFixed(2)}R a trade after spread. Wait for the shift.</i>` : "")
  );
}

export function setupText({ name, tf, ev, d = dec(ev.mss.entry) }) {
  const m = ev.mss, short = ev.dir === "SHORT", risk = Math.abs(m.entry - m.stop);
  const L = mainPool(ev), T = ICT_TESTED[tf]?.full;
  const t2 = short ? m.entry - 2 * risk : m.entry + 2 * risk;
  const liq = m.target != null
    ? `\nLiquidity target: ${poolName(m.targetType, short ? "low" : "high")} <code>${fmt(m.target, d)}</code> (${(Math.abs(m.target - m.entry) / risk).toFixed(1)}R)`
    : "";
  return (
    `🔁 <b>ICT SETUP · ${ev.dir}</b> · ${name} · ${tfLabel(tf)}\n` +
    `1. Swept the ${poolName(L.type, sideOf(ev.dir))} <code>${fmt(L.price, d)}</code> (${nyClock(ev.t)} candle${ev.killzone ? ", killzone" : ""})\n` +
    `2. Structure shift: body closed ${short ? "below" : "above"} <code>${fmt(ev.ref, d)}</code> (${nyClock(m.t)} candle), leaving a fair value gap\n` +
    `3. Entry, limit at the gap's 50%: <code>${fmt(m.entry, d)}</code> (gap ${fmt(m.fvg.bottom, d)} to ${fmt(m.fvg.top, d)})\n\n` +
    `Stop past the sweep: <code>${fmt(m.stop, d)}</code>\n` +
    `Target 2R: <code>${fmt(t2, d)}</code>${liq}\n` +
    `Cancel the order if it hasn't filled within 10 candles.\n` +
    (T ? `\n<i>Tested on 16 markets, this exact model won ${T.won}% against ${T.rnd}% for random entries at 2R (${T.n.toLocaleString("en-US")} trades), ${T.net >= 0 ? "+" : ""}${T.net.toFixed(2)}R a trade after spread. Not a proven edge: size it with the risk card.</i>` : "")
  );
}

// last: [[tfMinutes, latestSweepEvent, indexOfLastClosedCandle], ...]
export function liquidityMap({ name, price, levels, d = dec(price), dist = (x) => fmt(x, d), last = [] }) {
  const uniq = new Map();
  for (const L of levels) {
    const k = `${L.side}|${L.price}`, cur = uniq.get(k);
    if (!cur || (RANKS[L.type] || 0) > (RANKS[cur.type] || 0)) uniq.set(k, L);
  }
  const all = [...uniq.values()];
  const above = all.filter((L) => L.side === "high" && L.price > price).sort((a, b) => a.price - b.price).slice(0, 5);
  const below = all.filter((L) => L.side === "low" && L.price < price).sort((a, b) => b.price - a.price).slice(0, 5);
  const row = (L) => `<code>${fmt(L.price, d)}</code>  ${poolName(L.type, L.side)} · ${dist(Math.abs(L.price - price))} away`;
  const lastLines = last.filter(([, ev]) => ev).map(([tf, ev, lastIdx]) => {
    const L = mainPool(ev);
    const status = ev.mss
      ? `structure shifted, entry ${fmt(ev.mss.entry, d)}, stop ${fmt(ev.mss.stop, d)}`
      : lastIdx - ev.idx <= 10 ? "no structure shift yet" : "no structure shift";
    return `${tfLabel(tf)}: ${ev.dir === "SHORT" ? "buy-side" : "sell-side"}, ${poolName(L.type, sideOf(ev.dir))} <code>${fmt(L.price, d)}</code> at ${nyStamp(ev.t)} · ${status}`;
  });
  return (
    `💧 <b>LIQUIDITY MAP</b> · ${name} · price <code>${fmt(price, d)}</code>\n\n` +
    `<b>Buy-side above</b> (buy stops rest here)\n${above.length ? above.map(row).join("\n") : "none untaken nearby"}\n\n` +
    `<b>Sell-side below</b> (sell stops rest here)\n${below.length ? below.map(row).join("\n") : "none untaken nearby"}\n` +
    (lastLines.length ? `\n<b>Latest sweeps</b>\n${lastLines.join("\n")}\n` : "") +
    `\n<i>Where stops rest, not where price will go. Tested on 16 markets: sweeps alone lose after spread, the full ICT model was about breakeven.</i>`
  );
}
