// ---------------------------------------------------------------------------
// VOLATILITY FORECAST TEST: can we predict HOW BIG the next few hours will be?
//
//   node vol-forecast.mjs [TF_MINUTES] [BARS] [HORIZON_BARS] [INSTRUMENTS]
//   e.g. node vol-forecast.mjs 60 5000 4            (next 4 hours, 1H candles)
//        node vol-forecast.mjs 15 5000 16 XAUUSD,SIM
//
// Every study so far showed that chart shapes do not predict DIRECTION. The
// coin-toss check found one strong real effect instead: wild candles come in
// bunches, and real markets have busy and quiet hours. That should make the
// SIZE of upcoming candles predictable, even though their direction is not.
// This measures it, honestly, against a naive guess.
//
// The forecast itself lives in weather.mjs, shared with the live /weather
// command, so the thing being tested here is the thing the bot shows you.
//
// At every bar, using only candles already closed, four forecasts are made of
// the average candle size over the next HORIZON bars:
//
//   naive     the average size of the last 200 bars ("it'll be normal")
//   recent    the average size of the last 20 bars ("like lately")
//   clock     for each upcoming bar, the average size at that same time of
//             day over the previous 20 days ("like this hour usually is")
//   combined  clock, scaled by how lively the last 20 bars were compared with
//             the last 200 ("this hour, in today's weather")
//
// Scored by how far off each forecast was (log error, so being half or double
// count the same). "better than naive" = how much smaller the error was.
//
// Candle size is a PERCENT of price. The first run used price points, so the
// 20-day clock looked back across price drift and "failed" even on the random
// walk (78% worse on 15m), which is impossible for a fixed-volatility series.
//
// SIM is a random walk with fixed volatility and no clock. Nothing should beat
// naive there. If something does, the test is broken.
// ---------------------------------------------------------------------------
import { INSTRUMENTS } from "./deriv.mjs";
import { fetchGran } from "./source.mjs";
import { forecastWalk, pctRange, SLOW, CLOCK_DAYS } from "./weather.mjs";

const TF = Number(process.argv[2] || 60);
const BARS = Number(process.argv[3] || 5000);
const H = Number(process.argv[4] || 4);
const KEYS = (process.argv[5] || "XAUUSD,NAS100,GBPJPY,SIM").split(",").map((s) => s.trim().toUpperCase());
const perDay = Math.round(1440 / TF);

let simSeed = 55555;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };
function simBars(n, step) {
  const out = []; let p = 1000;
  for (let i = 0; i < n; i++) {
    const o = p; let hi = p, lo = p;
    for (let k = 0; k < 30; k++) { p *= 1 + 0.0009 * gauss(); if (p > hi) hi = p; if (p < lo) lo = p; }
    out.push({ t: 1700000000 + i * step, open: o, high: hi, low: lo, close: p });
  }
  return out;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const hl = TF >= 60 ? `${(H * TF) / 60} hour${(H * TF) / 60 === 1 ? "" : "s"}` : `${H * TF} minutes`;

console.log(`\nVolatility forecast test  |  ${TF}m candles  |  predicting the next ${hl}  |  ${KEYS.join(", ")}\n`);
console.log(`  ${"".padEnd(7)} ${"how far off, on average (lower is better)".padEnd(46)} ${"better than naive".padEnd(30)} ${"when it says calm / wild, next " + hl + " moved"}`);
console.log(`  ${"".padEnd(7)} ${"naive".padStart(8)} ${"recent".padStart(8)} ${"clock".padStart(8)} ${"combined".padStart(9)}          ${"recent".padStart(7)} ${"clock".padStart(7)} ${"combined".padStart(9)}      ${"calm".padStart(7)} ${"wild".padStart(7)}  ${"wild vs calm"}`);

for (const key of KEYS) {
  let bars;
  if (key === "SIM") bars = simBars(BARS, TF * 60);
  else {
    const inst = INSTRUMENTS.find((i) => i.key === key);
    if (!inst) { console.log(`  ${key}: unknown instrument`); continue; }
    try { bars = await fetchGran(inst, BARS, TF * 60); }
    catch (e) { console.log(`  ${key.padEnd(7)} fetch failed (${e.message})`); continue; }
  }
  if (!bars || bars.length < SLOW + CLOCK_DAYS * perDay + H + 50) { console.log(`  ${key.padEnd(7)} too little data`); continue; }

  const size = bars.map(pctRange);
  const err = { naive: [], recent: [], clock: [], combined: [] };
  const buckets = [];                  // [forecast ratio, actual / naive]

  forecastWalk(bars, TF, H, (j, f) => {
    if (j + H >= bars.length) return;  // outcome not known yet
    let actual = 0;
    for (let k = 1; k <= H; k++) actual += size[j + k];
    actual /= H;
    if (!(actual > 0)) return;
    const le = (x) => Math.abs(Math.log(x / actual));
    err.naive.push(le(f.naive)); err.recent.push(le(f.recent)); err.clock.push(le(f.clock)); err.combined.push(le(f.combined));
    buckets.push([f.combined / f.naive, actual / f.naive]);
  });
  if (!err.naive.length) { console.log(`  ${key.padEnd(7)} not enough history for the clock forecast`); continue; }

  const e = Object.fromEntries(Object.entries(err).map(([k, v]) => [k, mean(v)]));
  const better = (k) => `${((1 - e[k] / e.naive) * 100).toFixed(0)}%`;
  const sorted = [...buckets].sort((a, b) => a[0] - b[0]);
  const third = Math.floor(sorted.length / 3);
  const calm = mean(sorted.slice(0, third).map((x) => x[1]));
  const wild = mean(sorted.slice(-third).map((x) => x[1]));
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  console.log(`  ${key.padEnd(7)} ${e.naive.toFixed(3).padStart(8)} ${e.recent.toFixed(3).padStart(8)} ${e.clock.toFixed(3).padStart(8)} ${e.combined.toFixed(3).padStart(9)}          ${better("recent").padStart(7)} ${better("clock").padStart(7)} ${better("combined").padStart(9)}      ${pct(calm).padStart(7)} ${pct(wild).padStart(7)}  ${(wild / calm).toFixed(2)}x`);
}
console.log(`\n  calm / wild columns: the actual size of the next ${hl}, as % of a normal-sized stretch,`);
console.log(`  when the combined forecast was in its quietest third vs its liveliest third.\n`);
