// ---------------------------------------------------------------------------
// IS IT A COIN TOSS?  Four plain questions asked of every instrument.
//
//   node random-check.mjs [BARS] [TF_MINUTES]
//   e.g. node random-check.mjs 5000 15
//
// If price has NO memory, no chart pattern can ever work on it, because the
// past tells you nothing about the next candle. These four checks look for
// any memory at all:
//
//   1. COLOUR STREAK   After a green candle, is the next one green more than
//                      half the time? (A coin says 50%.)
//   2. FOLLOW-THROUGH  Does a candle's size-and-direction predict the next
//                      one? (lag-1 autocorrelation of returns; a coin says 0)
//   3. TREND OR SNAP   Do 4 candles in a row travel further than 4 separate
//      BACK            candles would? Above 1 = moves tend to continue,
//                      below 1 = moves tend to reverse. (variance ratio; a
//                      coin says 1.0)
//   4. CALM/WILD       Does a wild candle tend to be followed by another wild
//      CLUSTERING      one? Real markets do this strongly (news, sessions,
//                      panic). A random number generator with a fixed
//                      volatility setting should not.
//
// SIM is a generated random walk: the "known coin" to compare against.
// Each number comes with how many standard errors it sits from a coin.
// Under 2 = indistinguishable from a coin.
// ---------------------------------------------------------------------------
import { INSTRUMENTS } from "./deriv.mjs";
import { fetchGran } from "./source.mjs";

const BARS = Number(process.argv[2] || 5000);
const TF = Number(process.argv[3] || 15);
const KEYS = ["SIM", "V25", "V50", "V50S", "V75", "V100", "XAUUSD", "NAS100"];

let s = 424242;
const u = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
const g = () => { let a = 0; while (a === 0) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()); };
function sim(n) {
  const out = []; let p = 1000;
  for (let i = 0; i < n; i++) {
    const o = p; let h = p, l = p;
    for (let k = 0; k < 30; k++) { p *= 1 + 0.0009 * g(); if (p > h) h = p; if (p < l) l = p; }
    out.push({ t: i, open: o, high: h, low: l, close: p });
  }
  return out;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function autocorr(a, lag = 1) {
  const m = mean(a);
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) { den += (a[i] - m) ** 2; if (i >= lag) num += (a[i] - m) * (a[i - lag] - m); }
  return num / den;
}
function varianceRatio(r, q) {
  const n = r.length;
  const m = mean(r);
  const v1 = r.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1);
  const sums = [];
  for (let i = q; i <= n; i++) { let t = 0; for (let k = i - q; k < i; k++) t += r[k]; sums.push(t); }
  const vq = sums.reduce((x, y) => x + (y - q * m) ** 2, 0) / (sums.length - 1);
  const vr = vq / (q * v1);
  const se = Math.sqrt((2 * (2 * q - 1) * (q - 1)) / (3 * q * n));
  return { vr, z: (vr - 1) / se };
}

const f = (x, d = 3) => (x >= 0 ? "+" : "") + x.toFixed(d);
const flag = (z) => (Math.abs(z) >= 2 ? " *" : "  ");

console.log(`\nIs it a coin toss?  ${BARS} candles of ${TF}m each\n`);
console.log(`  ${"".padEnd(8)} ${"1. next same colour".padEnd(22)} ${"2. follow-through".padEnd(20)} ${"3. trend(>1) / snap back(<1)".padEnd(30)} ${"4. wild follows wild"}`);
console.log(`  ${"".padEnd(8)} ${"(coin = 50%)".padEnd(22)} ${"(coin = 0)".padEnd(20)} ${"(coin = 1.00)".padEnd(30)} ${"(coin = 0)"}`);

for (const key of KEYS) {
  let bars;
  if (key === "SIM") bars = sim(BARS);
  else {
    const inst = INSTRUMENTS.find((i) => i.key === key);
    if (!inst) continue;
    for (const n of [BARS, 3000, 2000]) {
      try { bars = await fetchGran(inst, n, TF * 60); if (bars && bars.length > 500) break; } catch { bars = null; }
    }
    if (!bars || bars.length < 500) { console.log(`  ${key.padEnd(8)} fetch failed`); continue; }
  }
  const r = [];
  for (let i = 1; i < bars.length; i++) r.push(Math.log(bars[i].close / bars[i - 1].close));
  const n = r.length;

  let same = 0, pairs = 0;
  for (let i = 1; i < bars.length; i++) {
    const a = Math.sign(bars[i - 1].close - bars[i - 1].open), b = Math.sign(bars[i].close - bars[i].open);
    if (a === 0 || b === 0) continue;
    pairs++; if (a === b) same++;
  }
  const pSame = same / pairs, zSame = (pSame - 0.5) / Math.sqrt(0.25 / pairs);

  const ac = autocorr(r), zAc = ac * Math.sqrt(n);
  const v4 = varianceRatio(r, 4);
  const absR = r.map(Math.abs);
  const cl = autocorr(absR), zCl = cl * Math.sqrt(n);

  const c1 = `${(pSame * 100).toFixed(1)}% (${Math.abs(zSame).toFixed(1)}s)${flag(zSame)}`;
  const c2 = `${f(ac)} (${Math.abs(zAc).toFixed(1)}s)${flag(zAc)}`;
  const c3 = `${v4.vr.toFixed(2)} (${Math.abs(v4.z).toFixed(1)}s)${flag(v4.z)}`;
  const c4 = `${f(cl)} (${Math.abs(zCl).toFixed(1)}s)${flag(zCl)}`;
  console.log(`  ${key.padEnd(8)} ${c1.padEnd(22)} ${c2.padEnd(20)} ${c3.padEnd(30)} ${c4}`);
}
console.log(`\n  * = 2 or more standard errors away from a coin toss. (s = standard errors)\n`);
