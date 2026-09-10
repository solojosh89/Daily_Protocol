// ---------------------------------------------------------------------------
// 4H DOUBLE SWEEP, STOP AT THE WICK: does the manipulation wick hold?
//
//   node sweep-stop-control.mjs [BARS] [INSTRUMENTS]
//   e.g. node sweep-stop-control.mjs 4500
//        node sweep-stop-control.mjs 4500 SIM
//
// The setup: a 4H candle takes BOTH the high and the low of the candle before
// it, then closes one way (detector.mjs, the same rule the live alerts use).
// A bullish close says the low was the manipulation, so the idea is: enter at
// the close, stop just beyond the bottom of that wick. Bearish is the mirror.
//
// Three questions:
//   1. HOLD   Is the wick extreme hit less often than a random level placed
//             the same distance from a random close? (within 1 day, 5 days)
//   2. PAY    With that stop, do 1R / 2R / 3R targets make money, compared
//             with the identical trade taken at a random moment?
//   3. FIT    How far is the stop in real money, and how often is the right
//             size for a $500 account at 1% below 0.01 lot?
//
// Stops tested:
//   wick         exactly at the wick extreme
//   wick + 10%   a little beyond it (10% of the candle's range)
//   half candle  at the middle of the candle (tighter, for comparison)
//
// TWO RANDOM TWINS, and why:
//   any time      a random close anywhere in the series, same direction, same
//                 stop and target distance in price. This is what the first
//                 version used, and it made the setup look better than chance
//                 at up to 3.9 sigma.
//   same weather  a random close whose last 20 candles were as lively as the
//                 setup's, with the stop as the same PERCENT of price. A double
//                 sweep is a big candle, and big candles come in bunches, so
//                 setups live in stormy stretches while "any time" twins mostly
//                 don't; and Gold doubled over the sample, so a fixed dollar
//                 stop means a different thing years apart. The generated
//                 random walk has neither storms nor this problem, which is
//                 why it could not expose it.
// Verdicts use the SAME WEATHER twin. The "any time" column stays visible so
// the size of the difference is on record.
//
// Fairness: signals use only the closed candle; the walk starts on the next
// candle; stop and target in the same candle count as a loss; every trade and
// twin gets a full 200-candle window.
// ---------------------------------------------------------------------------
import { INSTRUMENTS } from "./deriv.mjs";
import { fetchGran } from "./source.mjs";
import { detectSweep } from "./detector.mjs";

const BARS = Number(process.argv[2] || 4500);
const KEYS = (process.argv[3] || "XAUUSD,NAS100,GBPJPY").split(",").map((s) => s.trim().toUpperCase());
const TF = 240;
const MAX_BARS = 200;
const HOLD = [6, 30];     // 1 day and 5 days of 4H candles
const VOLN = 20;          // weather = average % candle size over the last 20 candles

let seed = 20260910;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 4242;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };
function simBars(n) {
  const out = []; let p = 1000;
  for (let i = 0; i < n; i++) {
    const o = p; let h = p, l = p;
    for (let k = 0; k < 40; k++) { p *= 1 + 0.0012 * gauss(); if (p > h) h = p; if (p < l) l = p; }
    out.push({ t: 1700000000 + i * TF * 60, open: o, high: h, low: l, close: p });
  }
  return out;
}

function hitWithin(bars, from, dir, stop, n) {
  const end = Math.min(from + n, bars.length);
  for (let i = from; i < end; i++) if (dir === "LONG" ? bars[i].low <= stop : bars[i].high >= stop) return 1;
  return 0;
}

function settle(bars, from, dir, entry, stop, target) {
  const long = dir === "LONG";
  const risk = long ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;
  const end = Math.min(from + MAX_BARS, bars.length);
  for (let i = from; i < end; i++) {
    const b = bars[i];
    if (long ? b.low <= stop : b.high >= stop) return -1;
    if (long ? b.high >= target : b.low <= target) return Math.abs(target - entry) / risk;
  }
  const last = bars[end - 1];
  return (long ? last.close - entry : entry - last.close) / risk;
}

const STOPS = {
  "wick": (c, long) => (long ? c.low : c.high),
  "wick + 10%": (c, long) => (long ? c.low - 0.1 * (c.high - c.low) : c.high + 0.1 * (c.high - c.low)),
  "half candle": (c, long) => (long ? c.low + 0.5 * (c.high - c.low) : c.high - 0.5 * (c.high - c.low)),
};
const TARGETS = [1, 2, 3];
const ARMS = ["t", "m"]; // t = any time twin, m = same weather twin

const rows = [];
const fit = new Map();

for (const key of KEYS) {
  let bars;
  if (key === "SIM") bars = simBars(BARS);
  else {
    const inst = INSTRUMENTS.find((i) => i.key === key);
    if (!inst) { console.log(`  ${key}: unknown instrument`); continue; }
    try { bars = await fetchGran(inst, BARS, TF * 60); }
    catch (e) { console.log(`  ${key}: fetch failed (${e.message})`); continue; }
  }
  if (!bars || bars.length < MAX_BARS + 300) { console.log(`  ${key}: too little data`); continue; }
  const lastEntry = bars.length - 2 - MAX_BARS;

  // weather at each candle, from that candle and the 19 before it only
  const vol = new Array(bars.length).fill(null);
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    acc += (bars[i].high - bars[i].low) / bars[i].close;
    if (i >= VOLN) acc -= (bars[i - VOLN].high - bars[i - VOLN].low) / bars[i - VOLN].close;
    if (i >= VOLN - 1) vol[i] = acc / VOLN;
  }
  const pool = [];
  for (let k = VOLN; k <= lastEntry; k++) pool.push([vol[k], k]);
  pool.sort((a, b) => a[0] - b[0]);
  const W = Math.max(25, Math.floor(pool.length * 0.02)); // pick among the ~4% nearest in weather
  const sameWeather = (v) => {
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid][0] < v) lo = mid + 1; else hi = mid; }
    const a = Math.max(0, lo - W), b = Math.min(pool.length - 1, lo + W);
    return pool[a + Math.floor(rnd() * (b - a + 1))][1];
  };

  let n = 0;
  for (let j = VOLN; j <= lastEntry; j++) {
    const s = detectSweep(bars[j - 1], bars[j]);
    if (!s) continue;
    const c = bars[j], long = s.dir === "BULL", dir = long ? "LONG" : "SHORT";
    const entry = c.close;
    n++;
    for (const [name, fn] of Object.entries(STOPS)) {
      const stop = fn(c, long);
      const dist = long ? entry - stop : stop - entry;
      if (!(dist > 0)) continue;
      if (name === "wick") { if (!fit.has(key)) fit.set(key, []); fit.get(key).push(dist); }

      const kt = 1 + Math.floor(rnd() * (lastEntry - 1));
      const km = sameWeather(vol[j]);
      const twins = {
        t: { k: kt, px: bars[kt].close, d: dist },                            // any time, same price distance
        m: { k: km, px: bars[km].close, d: (dist / entry) * bars[km].close },  // same weather, same % distance
      };
      const row = { key, strength: s.strength, dir, stop: name };
      for (const h of HOLD) {
        row[`hit${h}`] = hitWithin(bars, j + 1, dir, stop, h);
        for (const a of ARMS) {
          const tw = twins[a];
          row[`${a}hit${h}`] = hitWithin(bars, tw.k + 1, dir, long ? tw.px - tw.d : tw.px + tw.d, h);
        }
      }
      for (const m of TARGETS) {
        row[`r${m}`] = settle(bars, j + 1, dir, entry, stop, long ? entry + m * dist : entry - m * dist);
        for (const a of ARMS) {
          const tw = twins[a];
          row[`${a}r${m}`] = settle(bars, tw.k + 1, dir, tw.px, long ? tw.px - tw.d : tw.px + tw.d, long ? tw.px + m * tw.d : tw.px - m * tw.d);
        }
      }
      rows.push(row);
    }
  }
  const days = (bars.at(-1).t - bars[0].t) / 86400;
  console.log(`  ${key.padEnd(7)} ${days.toFixed(0).padStart(5)} days of 4H candles  ->  ${n} double sweeps`);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const paired = (a, b) => { const d = a.map((x, i) => x - b[i]); const m = mean(d), se = sd(d) / Math.sqrt(d.length); return { m, z: se > 0 ? m / se : 0 }; };
const sg = (x, p = 3) => (x >= 0 ? "+" : "") + x.toFixed(p);
const verdict = (z, betterIfNegative) => {
  if (Math.abs(z) < 2) return "";
  return (betterIfNegative ? z < 0 : z > 0) ? "  <- BETTER than same-weather random" : "  <- WORSE than same-weather random";
};

function report(title, subset) {
  if (subset.length < 20) return;
  console.log(`\n${title}  (${subset.length} trades)`);
  console.log(`  1. HOLD: how often the stop was touched`);
  for (const h of HOLD) {
    const a = subset.map((r) => r[`hit${h}`]);
    const t = subset.map((r) => r[`thit${h}`]), m = subset.map((r) => r[`mhit${h}`]);
    const pt = paired(a, t), pm = paired(a, m);
    console.log(`     within ${h === 6 ? "1 day " : "5 days"}   setup ${(mean(a) * 100).toFixed(1).padStart(5)}%   any time ${(mean(t) * 100).toFixed(1).padStart(5)}% (${Math.abs(pt.z).toFixed(1)}s)   same weather ${(mean(m) * 100).toFixed(1).padStart(5)}% (${sg(pm.m * 100, 1)} pts, ${Math.abs(pm.z).toFixed(1)}s)${verdict(pm.z, true)}`);
  }
  console.log(`  2. PAY: average result per trade`);
  for (const k of TARGETS) {
    const idx = subset.map((r, i) => i).filter((i) => subset[i][`r${k}`] != null && subset[i][`tr${k}`] != null && subset[i][`mr${k}`] != null);
    if (!idx.length) continue;
    const a = idx.map((i) => subset[i][`r${k}`]);
    const t = idx.map((i) => subset[i][`tr${k}`]), m = idx.map((i) => subset[i][`mr${k}`]);
    const pt = paired(a, t), pm = paired(a, m);
    console.log(`     target ${k}R     setup ${(sg(mean(a)) + "R").padStart(8)}   any time ${(sg(mean(t)) + "R").padStart(8)} (${Math.abs(pt.z).toFixed(1)}s)   same weather ${(sg(mean(m)) + "R").padStart(8)} (${sg(pm.m)}R, ${Math.abs(pm.z).toFixed(1)}s)${verdict(pm.z, false)}`);
  }
}

console.log(`\n${"=".repeat(110)}`);
for (const stop of Object.keys(STOPS)) report(`STOP: ${stop.toUpperCase()}  |  all pairs`, rows.filter((r) => r.stop === stop));
console.log(`\n${"=".repeat(110)}\nWICK STOP, split by pair, direction and strength`);
for (const key of KEYS) report(key, rows.filter((r) => r.stop === "wick" && r.key === key));
report(`LONG (bullish close) only`, rows.filter((r) => r.stop === "wick" && r.dir === "LONG"));
report(`SHORT (bearish close) only`, rows.filter((r) => r.stop === "wick" && r.dir === "SHORT"));
report(`STRONG sweeps only`, rows.filter((r) => r.stop === "wick" && r.strength === "STRONG"));
report(`NORMAL sweeps only`, rows.filter((r) => r.stop === "wick" && r.strength === "NORMAL"));

if (!KEYS.includes("SIM")) {
  console.log(`\n${"=".repeat(110)}\n3. FIT: the wick stop in real money ($500 account, 1% = $5 risk)`);
  for (const [key, list] of fit) {
    const d = [...list].sort((a, b) => a - b);
    const med = d[Math.floor(d.length / 2)], p90 = d[Math.floor(d.length * 0.9)];
    const unit = key === "XAUUSD" ? (x) => `$${x.toFixed(2)}` : key === "NAS100" ? (x) => `${x.toFixed(0)} pts` : (x) => `${(x * 100).toFixed(0)} pips`;
    let extra = "";
    if (key === "XAUUSD") {
      const below = d.filter((x) => 5 / x < 1).length / d.length;
      extra = `   size at median: ${(5 / med).toFixed(2)} oz   below 0.01 lot: ${(below * 100).toFixed(0)}% of trades`;
    }
    console.log(`  ${key.padEnd(7)} median stop ${unit(med).padStart(9)}   1 in 10 trades wider than ${unit(p90)}${extra}`);
  }
}
console.log(`\n"s" = standard errors. Under 2 means no different from that random twin. Verdicts use the same-weather twin.\n`);
