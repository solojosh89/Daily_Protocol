// Theory test: after a confirmed 4H double sweep (candle B), wait for the first hour
// of the next candle (C) to move in the bias direction, then enter at the end of that hour.
//
// Every trade is compared with two same-weather random entries:
//   random    any moment, same direction, same stop and target distance
//   momentum  a moment whose previous hour ALSO moved your way by the same rule
// If the setup only matches "momentum", the last hour's move is doing the work, not the sweep.
//
//   node c-first-hour.mjs [BARS] [INSTRUMENTS] [CANDLE_MINUTES]
//   e.g. node c-first-hour.mjs 5000 XAUUSD,NAS100,GBPJPY 60   (1H view, ~300 days)
//        node c-first-hour.mjs 20000 XAUUSD,NAS100,GBPJPY 15  (15m view, ~102 days)
//        node c-first-hour.mjs 5000 SIM 60                    (fake random prices: should show nothing)
//   HALF=old or HALF=new keeps only the older or newer half of the history.
import { INSTRUMENTS } from "./deriv.mjs";
import { fetchGran } from "./source.mjs";

const NB = Number(process.argv[2] || 5000);
const KEYS = (process.argv[3] || "XAUUSD,NAS100,GBPJPY").split(",").map((s) => s.trim().toUpperCase());
const GRAN = Number(process.argv[4] || 60);
const G4 = 14400, GS = GRAN * 60;
const PER = G4 / GS;              // entry candles per 4H candle
const H = 60 / GRAN;              // entry candles per hour
const WALK = Math.round(86400 / GS);
const VOLN = 20;
const STRONG = 0.5;               // half of "half a normal 4H candle" = a quarter candle

let seed = 9127;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 4242;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };
function simSeries(n) {
  const bs = []; let p = 1000;
  const t0 = 1700006400;
  for (let i = 0; i < n; i++) {
    const o = p; let h = p, l = p;
    for (let k = 0; k < GRAN; k++) { p *= 1 + 0.0006 * gauss(); if (p > h) h = p; if (p < l) l = p; }
    bs.push({ t: t0 + i * GS, open: o, high: h, low: l, close: p });
  }
  const b4 = [];
  for (let i = 0; i + PER <= n; i += PER) {
    const g = bs.slice(i, i + PER);
    b4.push({ t: g[0].t, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[PER - 1].close });
  }
  return { b4, bs };
}

const GROUPS = [
  ["all", "C + 60 min, no filter"],
  ["your", "first hour moved your way"],
  ["strong", "moved your way strongly"],
  ["against", "first hour moved against you"],
];
const inGroup = (g, move) => g === "all" || (g === "your" && move > 0) || (g === "strong" && move >= STRONG) || (g === "against" && move < 0);

const rows = [];
let missingTwin = 0;

for (const key of KEYS) {
  let b4, bs;
  if (key === "SIM") ({ b4, bs } = simSeries(NB));
  else {
    const inst = INSTRUMENTS.find((i) => i.key === key);
    if (!inst) { console.log(`  ${key}: unknown instrument`); continue; }
    try {
      bs = await fetchGran(inst, NB, GS);
      b4 = await fetchGran(inst, Math.ceil(NB / PER) + 60, G4);
    } catch (e) { console.log(`  ${key}: fetch failed (${e.message})`); continue; }
  }
  if (!bs?.length || !b4?.length) { console.log(`  ${key}: no data`); continue; }

  const inside = new Map();
  let p = 0;
  for (let j = 0; j < b4.length; j++) {
    const lo = b4[j].t, hi = lo + G4;
    while (p < bs.length && bs[p].t < lo) p++;
    const list = [];
    for (let q = p; q < bs.length && bs[q].t < hi; q++) list.push(q);
    if (list.length) inside.set(j, list);
  }

  const vol4 = new Array(b4.length).fill(null);
  for (let j = VOLN; j < b4.length; j++) {
    let s = 0;
    for (let k = j - VOLN; k < j; k++) s += (b4[k].high - b4[k].low) / b4[k].close;
    vol4[j] = s / VOLN;
  }
  const volS = new Array(bs.length).fill(null);
  for (const [j, list] of inside) for (const q of list) volS[q] = vol4[j];

  const lastEntry = bs.length - 2 - WALK;
  const pool = [];
  for (let q = H; q <= lastEntry; q++) if (volS[q] != null) pool.push([volS[q], q]);
  pool.sort((a, b) => a[0] - b[0]);
  const W = Math.max(40, Math.floor(pool.length * 0.02));
  const near = (v) => {
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid][0] < v) lo = mid + 1; else hi = mid; }
    return [Math.max(0, lo - W), Math.min(pool.length - 1, lo + W)];
  };
  // signed move of the hour ending at q, in units of half a normal 4H candle
  const hourMove = (q, dir, frac) => {
    const o = bs[q - H + 1].open, c = bs[q].close;
    return ((c - o) / (frac * o)) * (dir === "LONG" ? 1 : -1);
  };
  const randomTwin = (v) => { const [a, b] = near(v); return pool[a + Math.floor(rnd() * (b - a + 1))][1]; };
  const momentumTwin = (v, dir, g, frac) => {
    const [a, b] = near(v);
    for (let tries = 0; tries < 400; tries++) {
      const q = pool[a + Math.floor(rnd() * (b - a + 1))][1];
      if (bs[q].t - bs[q - H + 1].t !== (H - 1) * GS) continue;   // skip hours with a gap
      if (inGroup(g, hourMove(q, dir, frac))) return q;
    }
    return null;
  };

  const score = (q, dir, frac) => {
    const entry = bs[q].close, d = frac * entry, long = dir === "LONG";
    let race = 0.5;
    for (let k = q + 1; k <= q + WALK && k < bs.length; k++) {
      const c = bs[k];
      const stop = long ? c.low <= entry - d : c.high >= entry + d;
      const tgt = long ? c.high >= entry + d : c.low <= entry - d;
      if (stop) { race = 0; break; }
      if (tgt) { race = 1; break; }
    }
    const k8 = q + Math.round(28800 / GS);
    const f8 = k8 < bs.length ? ((bs[k8].close - entry) / d) * (long ? 1 : -1) : null;
    return { race, f8 };
  };

  const midT = (bs[0].t + bs[bs.length - 1].t) / 2;
  let setups = 0;
  for (let j = VOLN + 1; j < b4.length - 1; j++) {
    const A = b4[j - 1], B = b4[j];
    const listB = inside.get(j);
    if (!listB || listB.length < Math.ceil(0.75 * PER) || vol4[j] == null) continue;
    if (!(B.high > A.high && B.low < A.low && B.close !== B.open)) continue;
    const dir = B.close > B.open ? "LONG" : "SHORT";
    const frac = 0.5 * vol4[j];
    const listC = inside.get(j + 1);
    if (!listC) continue;
    const Ct = b4[j + 1].t;
    const q = listC.find((x) => bs[x].t + GS - Ct === 3600);
    if (q == null || bs[q - H + 1].t !== Ct || q > lastEntry) continue;   // need the full first hour
    if (process.env.HALF && (bs[q].t < midT) !== (process.env.HALF === "old")) continue;
    setups++;
    const move = hourMove(q, dir, frac);
    const s = score(q, dir, frac);
    if (s.f8 == null) continue;
    for (const [g] of GROUPS) {
      if (!inGroup(g, move)) continue;
      const t = score(randomTwin(volS[q]), dir, frac);
      const mq = momentumTwin(volS[q], dir, g, frac);
      if (mq == null) { missingTwin++; continue; }
      const m = score(mq, dir, frac);
      if (t.f8 == null || m.f8 == null) continue;
      rows.push({ key, g, move, ...s, tRace: t.race, tF8: t.f8, mRace: m.race, mF8: m.f8 });
    }
  }
  const days = (bs.at(-1).t - bs[0].t) / 86400;
  console.log(`  ${key.padEnd(7)} ${String(bs.length).padStart(6)} ${GRAN}m candles over ${days.toFixed(0)} days  |  ${setups} confirmed sweeps with a full first hour of C`);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const paired = (a, b) => { const d = a.map((x, i) => x - b[i]); const m = mean(d), se = sd(d) / Math.sqrt(d.length); return { m, z: se > 0 ? m / se : 0 }; };
const pct = (x) => (x * 100).toFixed(1) + "%";
const sg = (x, p = 1) => (x >= 0 ? "+" : "") + x.toFixed(p);
const cell = (r) => `${sg(r.m * 100)} (${Math.abs(r.z).toFixed(1)}s)${Math.abs(r.z) >= 2 ? (r.z > 0 ? " better" : " worse") : ""}`;

function table(title, subset) {
  if (!subset.length) return;
  const all = subset.filter((r) => r.g === "all").length;
  console.log(`\n${title}`);
  console.log(`  ${"entry at C + 60 min when".padEnd(30)} ${"trades".padStart(7)}  ${"won".padStart(6)}  ${"random".padStart(6)}  ${"vs random".padStart(18)}  ${"momentum".padStart(8)}  ${"vs momentum".padStart(18)}  ${"8h move vs random".padStart(18)}`);
  for (const [g, label] of GROUPS) {
    const rs = subset.filter((r) => r.g === g);
    if (rs.length < 15) { console.log(`  ${label.padEnd(30)} ${String(rs.length).padStart(7)}  (too few)`); continue; }
    const share = g === "all" ? "" : ` ${Math.round((100 * rs.length) / all)}%`;
    const vr = paired(rs.map((r) => r.race), rs.map((r) => r.tRace));
    const vm = paired(rs.map((r) => r.race), rs.map((r) => r.mRace));
    const v8 = paired(rs.map((r) => r.f8), rs.map((r) => r.tF8));
    console.log(`  ${label.padEnd(30)} ${(String(rs.length) + share).padStart(7)}  ${pct(mean(rs.map((r) => r.race))).padStart(6)}  ${pct(mean(rs.map((r) => r.tRace))).padStart(6)}  ${cell(vr).padStart(18)}  ${pct(mean(rs.map((r) => r.mRace))).padStart(8)}  ${cell(vm).padStart(18)}  ${(sg(v8.m, 2) + ` (${Math.abs(v8.z).toFixed(1)}s)`).padStart(18)}`);
  }
  // your way vs against: two separate groups of setups
  const y = subset.filter((r) => r.g === "your").map((r) => r.race), a = subset.filter((r) => r.g === "against").map((r) => r.race);
  if (y.length >= 15 && a.length >= 15) {
    const diff = mean(y) - mean(a), se = Math.sqrt(sd(y) ** 2 / y.length + sd(a) ** 2 / a.length);
    console.log(`  your way minus against: ${sg(diff * 100)} points (${Math.abs(diff / se).toFixed(1)}s)`);
  }
}

console.log(`\n${"=".repeat(126)}`);
table("ALL PAIRS", rows);
if (KEYS.length > 1) for (const k of KEYS) table(k, rows.filter((r) => r.key === k));
if (missingTwin) console.log(`\n  (${missingTwin} trades skipped: no same-weather momentum twin found)`);
console.log(`\n"won": target half a normal 4H candle away hit before a stop the same distance away. Coin toss = 50%.`);
console.log(`"momentum": a random same-weather moment whose previous hour moved the same way. Beating random but not momentum means the sweep adds nothing.`);
console.log(`"strongly": first hour moved at least a quarter of a normal 4H candle your way.`);
console.log(`"s" = standard errors. Under 2 = could easily be luck.\n`);
