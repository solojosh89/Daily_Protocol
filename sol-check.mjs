// ─────────────────────────────────────────────────────────────────────────
// SOL CHECK — is the swept level real, given all the history we can get?
//
// Earlier tests used 100 to 300 days on 3 pairs. This one uses 20 to 29 years
// of DAILY candles on 16 markets, plus about 3.5 years of 4H candles on Gold,
// Nasdaq and GBPJPY.
//
// Three versions of "price grabbed liquidity, now trade the other way". Each is
// decided on a CLOSED candle and entered at that close:
//   double sweep     candle takes the previous candle's high AND low (the bot's
//                    own detectSweep); trade the way it closed
//   reclaim          candle takes ONE side of the previous candle and closes
//                    back inside it; trade back the other way (the classic SOL)
//   20-bar reclaim   candle takes the highest high (lowest low) of the last 20
//                    candles and closes back under (over) it; trade the other way
//
// Every trade is paired with a random entry in the SAME market, SAME direction
// and SAME weather (normal candle size). Stop and target sit half a normal
// candle away. Standard errors are clustered by market and quarter, because
// signals close together share the same price moves.
//
// Verdict rule, fixed before running: an edge must reach 3 standard errors,
// point the same way in the older and newer half of history, and the fake
// random-walk market (SIM) must show nothing.
//
//   node sol-check.mjs                    downloads candles
//   DATA_DIR=folder node sol-check.mjs    uses cached candles
//   OUT=sol.json node sol-check.mjs       also writes the summary as JSON
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "fs";
import { detectSweep } from "./detector.mjs";
import { MARKETS, loadBars } from "./research-markets.mjs";

const VOLN = 20;   // normal candle = average % size of the 20 candles before
const RACE = 10;   // stop or target must be hit within 10 candles, else it counts as half
const PATS = ["double sweep", "double sweep STRONG", "reclaim", "20-bar reclaim"];

let seed = 20260912;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 777;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };
function simBars(n, stepSec) {
  const out = []; let p = 1000;
  for (let i = 0; i < n; i++) {
    const o = p; let h = p, l = p;
    for (let k = 0; k < 24; k++) { p *= 1 + (0.01 / Math.sqrt(24)) * gauss(); if (p > h) h = p; if (p < l) l = p; }
    out.push({ t: 946684800 + i * stepSec, open: o, high: h, low: l, close: p });
  }
  return out;
}

// every signal known at the close of candle j, as [pattern, direction]
export function signals(bars, j) {
  const A = bars[j - 1], B = bars[j], out = [];
  const s = detectSweep(A, B);
  if (s) {
    const dir = s.dir === "BULL" ? "LONG" : "SHORT";
    out.push(["double sweep", dir]);
    if (s.strength === "STRONG") out.push(["double sweep STRONG", dir]);
  } else {
    if (B.high > A.high && B.close < A.high && B.low >= A.low) out.push(["reclaim", "SHORT"]);
    if (B.low < A.low && B.close > A.low && B.high <= A.high) out.push(["reclaim", "LONG"]);
  }
  let hi = -Infinity, lo = Infinity;
  for (let k = j - VOLN; k < j; k++) { if (bars[k].high > hi) hi = bars[k].high; if (bars[k].low < lo) lo = bars[k].low; }
  if (B.high > hi && B.close < hi && B.low >= lo) out.push(["20-bar reclaim", "SHORT"]);
  if (B.low < lo && B.close > lo && B.high <= hi) out.push(["20-bar reclaim", "LONG"]);
  return out;
}

function study(bars, tf, key, cls, rows) {
  const n = bars.length;
  if (n < VOLN + RACE + 100) return 0;
  const vol = new Float64Array(n).fill(NaN);
  for (let j = VOLN; j < n; j++) {
    let a = 0;
    for (let k = j - VOLN; k < j; k++) a += (bars[k].high - bars[k].low) / bars[k].close;
    vol[j] = a / VOLN;
  }
  const last = n - 1 - RACE;
  const pool = [];
  for (let j = VOLN; j <= last; j++) pool.push([vol[j], j]);
  pool.sort((a, b) => a[0] - b[0]);
  const W = Math.max(20, Math.floor(pool.length * 0.02));
  const twin = (v, not) => {
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid][0] < v) lo = mid + 1; else hi = mid; }
    const a = Math.max(0, lo - W), b = Math.min(pool.length - 1, lo + W);
    for (;;) { const q = pool[a + Math.floor(rnd() * (b - a + 1))][1]; if (q !== not) return q; }
  };
  const score = (q, dir) => {
    const e = bars[q].close, d = 0.5 * vol[q] * e, long = dir === "LONG";
    let race = 0.5;
    for (let k = q + 1; k <= q + RACE; k++) {
      const c = bars[k];
      if (long ? c.low <= e - d : c.high >= e + d) { race = 0; break; }   // stop first, or both in one candle
      if (long ? c.high >= e + d : c.low <= e - d) { race = 1; break; }
    }
    const f = (h) => ((bars[q + h].close - e) / d) * (long ? 1 : -1);
    return { race, f3: f(3), f10: f(10) };
  };
  const midT = bars[Math.floor(n / 2)].t;
  const clusterOf = (t) => {
    const d = new Date(t * 1000);
    return tf === "daily" ? `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3)}` : `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  };
  let count = 0;
  for (let j = VOLN; j <= last; j++) {
    for (const [pat, dir] of signals(bars, j)) {
      const s = score(j, dir), t = score(twin(vol[j], j), dir);
      rows.push({
        tf, key, cls, pat, dir, half: bars[j].t < midT ? "older" : "newer", cluster: `${tf}|${key}|${clusterOf(bars[j].t)}`,
        race: s.race, f3: s.f3, f10: s.f10, tRace: t.race, tF3: t.f3, tF10: t.f10,
      });
      count++;
    }
  }
  return count;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
// paired difference (pattern minus random) with a cluster-robust standard error
function cz(rs, f) {
  const n = rs.length;
  if (!n) return { m: 0, z: 0 };
  const d = rs.map(f), m = mean(d), cl = new Map();
  rs.forEach((r, i) => cl.set(r.cluster, (cl.get(r.cluster) || 0) + d[i] - m));
  let v = 0;
  for (const x of cl.values()) v += x * x;
  const se = Math.sqrt(v) / n;
  return { m, se, z: se > 0 ? m / se : 0 };
}
const sg = (x, p = 2) => (x >= 0 ? "+" : "") + x.toFixed(p);
const flag = (z) => (Math.abs(z) >= 3 ? (z > 0 ? " ▲" : " ▼") : "  ");
function summary(rs) {
  const race = cz(rs, (r) => r.race - r.tRace), f3 = cz(rs, (r) => r.f3 - r.tF3), f10 = cz(rs, (r) => r.f10 - r.tF10);
  return { n: rs.length, win: mean(rs.map((r) => r.race)), twin: mean(rs.map((r) => r.tRace)), race, f3, f10 };
}
function line(label, rs) {
  if (rs.length < 30) return `  ${label.padEnd(24)} ${String(rs.length).padStart(6)}  (too few)`;
  const s = summary(rs);
  return `  ${label.padEnd(24)} ${String(s.n).padStart(6)}  ${(s.win * 100).toFixed(1).padStart(5)}%  ${(s.twin * 100).toFixed(1).padStart(5)}%  ` +
    `${(sg(s.race.m * 100, 1) + " (" + sg(s.race.z, 1) + ")").padStart(14)}${flag(s.race.z)}  ` +
    `${(sg(s.f3.m) + " (" + sg(s.f3.z, 1) + ")").padStart(14)}${flag(s.f3.z)}  ${(sg(s.f10.m) + " (" + sg(s.f10.z, 1) + ")").padStart(14)}${flag(s.f10.z)}`;
}
const header = `  ${"".padEnd(24)} ${"trades".padStart(6)}  ${"won".padStart(6)}  ${"random".padStart(6)}  ${"win diff (z)".padStart(14)}    ${"3-candle move (z)".padStart(14)}    ${"10-candle move (z)".padStart(14)}`;

const rows = [];
const year = (t) => new Date(t * 1000).getUTCFullYear();
console.log("Candles");
for (const [key, sym, cls] of MARKETS) {
  try {
    const { bars, dropped } = await loadBars(sym, "1D", 8000);
    const n = study(bars, "daily", key, cls, rows);
    console.log(`  ${key.padEnd(7)} daily ${String(bars.length).padStart(5)} candles from ${year(bars[0].t)}  ${String(n).padStart(5)} signals${dropped ? `  (${dropped} bad tick${dropped > 1 ? "s" : ""} fixed)` : ""}`);
  } catch (e) { console.log(`  ${key}: ${e.message}`); }
}
for (const key of ["XAUUSD", "NAS100", "GBPJPY"]) {
  const [, sym, cls] = MARKETS.find((m) => m[0] === key);
  try {
    const { bars, dropped } = await loadBars(sym, "240", 20000);
    const n = study(bars, "4H", key, cls, rows);
    console.log(`  ${key.padEnd(7)} 4H    ${String(bars.length).padStart(5)} candles from ${year(bars[0].t)}  ${String(n).padStart(5)} signals${dropped ? `  (${dropped} bad ticks fixed)` : ""}`);
  } catch (e) { console.log(`  ${key} 4H: ${e.message}`); }
}
for (let s = 0; s < 4; s++) study(simBars(6000, 86400), "SIM", `SIM${s}`, "sim", rows);

const out = {};
for (const tf of ["daily", "4H", "SIM"]) {
  const T = rows.filter((r) => r.tf === tf);
  console.log(`\n${"=".repeat(118)}\n${tf === "daily" ? "DAILY candles, 16 markets" : tf === "4H" ? "4H candles, Gold + Nasdaq + GBPJPY" : "SIM: fake random-walk markets (must show nothing)"}\n${header}`);
  out[tf] = {};
  for (const pat of PATS) {
    const P = T.filter((r) => r.pat === pat);
    console.log(line(pat, P));
    const s = summary(P);
    out[tf][pat] = { n: s.n, win: s.win, twin: s.twin, diff: s.race.m, se: s.race.se, z: s.race.z, f10: s.f10.m, zf10: s.f10.z };
    if (tf === "SIM") continue;
    for (const h of ["older", "newer"]) console.log(line(`   ${h} half`, P.filter((r) => r.half === h)));
    for (const d of ["LONG", "SHORT"]) console.log(line(`   ${d}`, P.filter((r) => r.dir === d)));
    if (tf === "daily") for (const c of ["metal", "index", "fx"]) console.log(line(`   ${c}`, P.filter((r) => r.cls === c)));
    const o = summary(P.filter((r) => r.half === "older")), nw = summary(P.filter((r) => r.half === "newer"));
    Object.assign(out[tf][pat], { diffOlder: o.race.m, zOlder: o.race.z, diffNewer: nw.race.m, zNewer: nw.race.z });
  }
  if (tf === "daily") {
    console.log("\n  by market, all patterns together");
    for (const [key] of MARKETS) console.log(line(`   ${key}`, T.filter((r) => r.key === key && r.pat !== "double sweep STRONG")));
  }
}
console.log(`\n"won": target (half a normal candle away) hit before a same-size stop, within 10 candles. Coin toss = 50%.`);
console.log(`"move": distance travelled your way after 3 and 10 candles, in stop units. z = standard errors vs the random entries; ▲▼ = 3 or more.`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out, null, 2));
