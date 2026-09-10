// ---------------------------------------------------------------------------
// ENTRY TIMING AROUND THE MANIPULATION CANDLE: when is the best moment?
//
//   node entry-timing.mjs [BARS] [INSTRUMENTS] [CANDLE_MINUTES]
//   e.g. node entry-timing.mjs 20000                          (15m view)
//        node entry-timing.mjs 20000 SIM
//        node entry-timing.mjs 5000 XAUUSD,NAS100,GBPJPY 60  (1H view: longer history, hourly moments only)
//
// Candle A = the candle before. Candle B = the manipulation candle, which takes
// BOTH A's high and A's low. Candle C = the next 4H candle. The question: at
// which moment does entering in the bias direction work best?
//
// ENTRY MOMENTS TESTED (each uses ONLY what a trader could see at that time):
//   during B    the moment B has taken both sides of A, then 1h, 2h, 3h in, and
//               15 minutes before B closes. Direction = the way B is closing so
//               far. Setups that later fizzle are INCLUDED, because at that
//               moment nobody knows yet.
//   at B close  confirmed double sweep (the live alert rule), bias from B's close.
//   during C    15, 30, 45, 60, 75, 90 minutes, 2h, 3h and 3h45 after C opens,
//               in B's confirmed bias direction.
//
// HOW EACH ENTRY IS SCORED (the same for every moment, so moments compare fairly):
//   race        a target and a stop the same distance away, half a normal 4H
//               candle (from the 20 candles before B). Did price reach the
//               target first? A coin toss wins 50%.
//   4h / 8h     how far price travelled your way over the next 4 and 8 hours,
//               in those same half-candle units.
//
// Every entry gets a random twin: same direction, same distance as a percent of
// price, entered at a random 15m close where the recent 4H candles were just as
// lively (same weather). "difference" = entry minus its twin.
//
// Many moments are tested at once, so expect about one to cross 2 standard
// errors by luck. Trust a pattern across neighbouring moments, not one cell.
// ---------------------------------------------------------------------------
import { INSTRUMENTS } from "./deriv.mjs";
import { fetchGran } from "./source.mjs";

const N15 = Number(process.argv[2] || 20000);
const KEYS = (process.argv[3] || "XAUUSD,NAS100,GBPJPY").split(",").map((s) => s.trim().toUpperCase());
const GRAN = Number(process.argv[4] || 15);   // entry candle size in minutes
const G4 = 14400, G15 = GRAN * 60;
const PER = G4 / G15;                          // entry candles per 4H candle
const WALK = Math.round(86400 / G15);          // settle within 24 hours
const VOLN = 20;

let seed = 7771;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 3131;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };
function simSeries(n) {
  const b15 = []; let p = 1000;
  const t0 = 1700006400; // a 4H boundary
  for (let i = 0; i < n; i++) {
    const o = p; let h = p, l = p;
    for (let k = 0; k < GRAN; k++) { p *= 1 + 0.0006 * gauss(); if (p > h) h = p; if (p < l) l = p; }
    b15.push({ t: t0 + i * G15, open: o, high: h, low: l, close: p });
  }
  const b4 = [];
  for (let i = 0; i + PER <= n; i += PER) {
    const g = b15.slice(i, i + PER);
    b4.push({ t: g[0].t, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[PER - 1].close });
  }
  return { b4, b15 };
}

const MOMENTS = [
  ["during B", "both sides just taken"],
  ["during B", "1h into B"],
  ["during B", "2h into B"],
  ["during B", "3h into B"],
  ["during B", "15 min before B closes"],
  ["close", "at B close (confirmed)"],
  ["during C", "C + 15 min"], ["during C", "C + 30 min"], ["during C", "C + 45 min"],
  ["during C", "C + 60 min"], ["during C", "C + 75 min"], ["during C", "C + 90 min"],
  ["during C", "C + 2h"], ["during C", "C + 3h"], ["during C", "C + 3h45"],
];
const IN_B = { 60: "1h into B", 120: "2h into B", 180: "3h into B", 225: "15 min before B closes" };
const IN_C = { 15: "C + 15 min", 30: "C + 30 min", 45: "C + 45 min", 60: "C + 60 min", 75: "C + 75 min", 90: "C + 90 min", 120: "C + 2h", 180: "C + 3h", 225: "C + 3h45" };

const rows = [];

for (const key of KEYS) {
  let b4, b15;
  if (key === "SIM") ({ b4, b15 } = simSeries(N15));
  else {
    const inst = INSTRUMENTS.find((i) => i.key === key);
    if (!inst) { console.log(`  ${key}: unknown instrument`); continue; }
    try {
      b15 = await fetchGran(inst, N15, G15);
      b4 = await fetchGran(inst, Math.ceil(N15 / PER) + 60, G4);
    } catch (e) { console.log(`  ${key}: fetch failed (${e.message})`); continue; }
  }
  if (!b15?.length || !b4?.length) { console.log(`  ${key}: no data`); continue; }

  // 15m candles inside each 4H candle
  const inside = new Map();
  let p = 0;
  for (let j = 0; j < b4.length; j++) {
    const lo = b4[j].t, hi = lo + G4;
    while (p < b15.length && b15[p].t < lo) p++;
    const list = [];
    for (let q = p; q < b15.length && b15[q].t < hi; q++) list.push(q);
    if (list.length) inside.set(j, list);
  }
  // alignment check: does each full 4H candle's high/low match its 15m candles?
  let full = 0, match = 0;
  for (const [j, list] of inside) {
    if (list.length < PER) continue;
    full++;
    const h = Math.max(...list.map((q) => b15[q].high)), l = Math.min(...list.map((q) => b15[q].low));
    const tol = 0.0005 * b4[j].close;
    if (Math.abs(h - b4[j].high) <= tol && Math.abs(l - b4[j].low) <= tol) match++;
  }

  // weather: average % size of the 20 4H candles BEFORE a given 4H candle
  const vol4 = new Array(b4.length).fill(null);
  for (let j = VOLN; j < b4.length; j++) {
    let s = 0;
    for (let k = j - VOLN; k < j; k++) s += (b4[k].high - b4[k].low) / b4[k].close;
    vol4[j] = s / VOLN;
  }
  // every 15m candle's weather, via the 4H candle it sits in
  const vol15 = new Array(b15.length).fill(null);
  for (const [j, list] of inside) for (const q of list) vol15[q] = vol4[j];
  const lastEntry = b15.length - 2 - WALK;
  const pool = [];
  for (let q = 0; q <= lastEntry; q++) if (vol15[q] != null) pool.push([vol15[q], q]);
  pool.sort((a, b) => a[0] - b[0]);
  const W = Math.max(40, Math.floor(pool.length * 0.02));
  const twinIndex = (v) => {
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid][0] < v) lo = mid + 1; else hi = mid; }
    const a = Math.max(0, lo - W), b = Math.min(pool.length - 1, lo + W);
    return pool[a + Math.floor(rnd() * (b - a + 1))][1];
  };

  const score = (q, dir, frac) => {
    const entry = b15[q].close, d = frac * entry, long = dir === "LONG";
    let race = 0.5; // unresolved inside 24h counts as a half, for both arms
    for (let k = q + 1; k <= q + WALK && k < b15.length; k++) {
      const c = b15[k];
      const stop = long ? c.low <= entry - d : c.high >= entry + d;
      const tgt = long ? c.high >= entry + d : c.low <= entry - d;
      if (stop) { race = 0; break; }   // stop first, or both in one candle, is a loss
      if (tgt) { race = 1; break; }
    }
    const fwd = (h) => { const k = q + h; if (k >= b15.length) return null; return ((b15[k].close - entry) / d) * (long ? 1 : -1); };
    return { race, f4: fwd(Math.round(14400 / G15)), f8: fwd(Math.round(28800 / G15)) };
  };

  // HALF=old or HALF=new keeps only setups from the older or newer half of the history (repeat check)
  const midT = (b15[0].t + b15[b15.length - 1].t) / 2;
  const record = (moment, q, dir, frac, extra = {}) => {
    if (q > lastEntry || !(frac > 0)) return;
    if (process.env.HALF && (b15[q].t < midT) !== (process.env.HALF === "old")) return;
    const s = score(q, dir, frac);
    const tq = twinIndex(vol15[q]);
    const t = score(tq, dir, frac);
    if (s.f8 == null || t.f8 == null) return;
    rows.push({ key, moment, dir, ...s, tRace: t.race, tF4: t.f4, tF8: t.f8, ...extra });
  };

  let setups = 0;
  for (let j = VOLN + 1; j < b4.length - 1; j++) {
    const A = b4[j - 1], B = b4[j];
    const listB = inside.get(j);
    if (!listB || listB.length < Math.ceil(0.75 * PER) || vol4[j] == null) continue;
    const frac = 0.5 * vol4[j];
    const final = B.high > A.high && B.low < A.low && B.close !== B.open
      ? (B.close > B.open ? "LONG" : "SHORT") : null;

    // during B: only what is known so far
    let hi = -Infinity, lo = Infinity, bothRecorded = false;
    for (const q of listB) {
      hi = Math.max(hi, b15[q].high); lo = Math.min(lo, b15[q].low);
      const both = hi > A.high && lo < A.low;
      const c = b15[q].close;
      const dirNow = c > B.open ? "LONG" : c < B.open ? "SHORT" : null;
      if (!both || !dirNow) continue;
      const heldTo = final === dirNow ? "confirmed" : "fizzled";
      if (!bothRecorded) { record("both sides just taken", q, dirNow, frac, { heldTo }); bothRecorded = true; }
      const mins = (b15[q].t + G15 - B.t) / 60;
      if (IN_B[mins]) record(IN_B[mins], q, dirNow, frac, { heldTo });
    }

    if (!final) continue;
    setups++;
    record("at B close (confirmed)", listB[listB.length - 1], final, frac);
    const listC = inside.get(j + 1);
    if (!listC) continue;
    const Ct = b4[j + 1].t;
    for (const q of listC) {
      const mins = (b15[q].t + G15 - Ct) / 60;
      if (IN_C[mins]) record(IN_C[mins], q, final, frac);
    }
  }
  const days = (b15.at(-1).t - b15[0].t) / 86400;
  console.log(`  ${key.padEnd(7)} ${String(b15.length).padStart(6)} ${GRAN}m candles over ${days.toFixed(0)} days  |  4H candles matching their 15m candles: ${full ? Math.round((100 * match) / full) : 0}%  |  ${setups} confirmed double sweeps`);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const paired = (a, b) => { const d = a.map((x, i) => x - b[i]); const m = mean(d), se = sd(d) / Math.sqrt(d.length); return { m, z: se > 0 ? m / se : 0 }; };
const sg = (x, p = 2) => (x >= 0 ? "+" : "") + x.toFixed(p);
const star = (z) => (Math.abs(z) >= 2 ? (z > 0 ? " <- better" : " <- worse") : "");

function table(title, subset) {
  if (!subset.length) return;
  console.log(`\n${title}`);
  console.log(`  ${"when you enter".padEnd(26)} ${"trades".padStart(6)}   ${"won the race".padStart(12)}  ${"random".padStart(6)}  ${"difference".padStart(15)}     ${"moved your way in 8h".padStart(20)}  ${"random".padStart(6)}  ${"difference".padStart(14)}`);
  let group = "";
  for (const [g, m] of MOMENTS) {
    const rs = subset.filter((r) => r.moment === m);
    if (rs.length < 15) continue;
    if (g !== group) { console.log(`  ${g === "during B" ? "-- during the manipulation candle" : g === "close" ? "-- at its close" : "-- during the next candle"}`); group = g; }
    const race = paired(rs.map((r) => r.race), rs.map((r) => r.tRace));
    const f8 = paired(rs.map((r) => r.f8), rs.map((r) => r.tF8));
    const held = rs[0].heldTo !== undefined ? `  (${Math.round((100 * rs.filter((r) => r.heldTo === "confirmed").length) / rs.length)}% closed as a confirmed sweep)` : "";
    console.log(`  ${m.padEnd(26)} ${String(rs.length).padStart(6)}   ${((mean(rs.map((r) => r.race)) * 100).toFixed(1) + "%").padStart(12)}  ${((mean(rs.map((r) => r.tRace)) * 100).toFixed(1) + "%").padStart(6)}  ${(sg(race.m * 100, 1) + ` (${Math.abs(race.z).toFixed(1)}s)`).padStart(15)}${star(race.z).padEnd(10)} ${sg(mean(rs.map((r) => r.f8))).padStart(20)}  ${sg(mean(rs.map((r) => r.tF8))).padStart(6)}  ${(sg(f8.m) + ` (${Math.abs(f8.z).toFixed(1)}s)`).padStart(14)}${star(f8.z)}${held}`);
  }
}

console.log(`\n${"=".repeat(132)}`);
table(`ALL PAIRS`, rows);
if (KEYS.length > 1) for (const k of KEYS) table(k, rows.filter((r) => r.key === k));
console.log(`\n"won the race": price reached a target half a normal 4H candle away before a stop the same distance away. A coin toss wins 50%.`);
console.log(`"moved your way": distance travelled in your direction over 8 hours, in those half-candle units.`);
console.log(`"s" = standard errors vs the same-weather random entry. Under 2 = no different from entering at a random moment.\n`);
