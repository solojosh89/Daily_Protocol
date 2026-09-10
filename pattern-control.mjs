// ---------------------------------------------------------------------------
// PATTERN CONTROL STUDY: two chart-reading rules put on trial.
//
//   node pattern-control.mjs [BARS] [K] [INSTRUMENTS]
//   e.g. node pattern-control.mjs 5000 5
//        node pattern-control.mjs 5000 5 SIM          (pure random walk)
//        node pattern-control.mjs 5000 3 V25,V75,V100
//
// RULE 1  HEAD AND SHOULDERS TOP (and its mirror, the inverse H&S bottom)
//   Three swing highs: left, a higher head, then a right shoulder LOWER than
//   the left. When a candle CLOSES through the neckline (the line joining the
//   two lows between the peaks), enter in the break direction.
//   Stop: beyond the right shoulder.
//   Target: the textbook measured move (head-to-neckline height, projected
//   from the break).
//
// RULE 2  SHRINKING LEGS
//   A down leg that is SMALLER than the down leg before it reads as sellers
//   tiring. Once the low of that smaller leg is confirmed, go long.
//   Stop: below that low. Target: the top the smaller leg started from.
//   The mirror (a smaller up leg) goes short.
//
// FAIRNESS RULES (every one of these was learned by getting it wrong):
//   * A swing point only EXISTS once K bars have closed after it.
//   * The swing list is rebuilt IN TIME ORDER. The first version of this file
//     built it from the whole chart at once, which let a later, lower low
//     silently replace an earlier one. The trade you really would have taken
//     at the first low (and been stopped out on) vanished from the record.
//     That deleted losers by hindsight and made a pure random walk "beat
//     chance" at 3.2 sigma.
//   * Entry is the close of the signal bar. The walk starts on the NEXT bar.
//   * Every trade and every random twin gets a full walk window, so neither
//     arm is cut short by the end of the data.
//   * Every trade gets a random twin: same direction, same stop distance,
//     same target distance, entered at the close of a random bar in the same
//     series. If the pattern cannot beat its twin, it found nothing.
//   * Stop and target in the same candle counts as a loss (both arms).
//   * Pass SIM as an instrument to run on a generated random walk, where no
//     rule can have an edge. The OVERALL rows must sit near zero there; if
//     they do not, the study is broken, not the market. Small single cells
//     (a few dozen trades) WILL sometimes print "beats chance" on SIM. That is
//     what a false positive looks like, and exactly why one cell proves
//     nothing. Pass a 5th argument to change the SIM seed and see it happen.
// ---------------------------------------------------------------------------
import { INSTRUMENTS, fmtTime } from "./deriv.mjs";
import { fetchGran } from "./source.mjs";

const BARS = Number(process.argv[2] || 5000);
const K = Number(process.argv[3] || 5);
const KEYS = (process.argv[4] || "V50,V50S").split(",").map((s) => s.trim().toUpperCase());
const TFS = [15, 60];
const MAX_BARS = 300;

const SIM_SEED = Number(process.argv[5] || 97531);
let seed = 13579 + SIM_SEED;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// Independent generator for SIM prices, so the price series and the random
// twins never share a random stream.
let simSeed = SIM_SEED;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let u = 0; while (u === 0) u = simU(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * simU()); };
function simBars(n, stepSeconds) {
  const out = [];
  let p = 1000;
  const t0 = 1700000000;
  for (let i = 0; i < n; i++) {
    const open = p;
    let hi = p, lo = p;
    for (let s = 0; s < 30; s++) { p *= 1 + 0.0009 * gauss(); if (p > hi) hi = p; if (p < lo) lo = p; }
    out.push({ t: t0 + i * stepSeconds, open, high: hi, low: lo, close: p });
  }
  return out;
}

// Raw fractal swing points, in order of the bar where each becomes knowable
// (c = i + k). A bar can be both a swing high and a swing low.
function rawPivots(bars, k) {
  const raw = [];
  for (let i = k; i < bars.length - k; i++) {
    let hi = true, lo = true;
    for (let d = 1; d <= k; d++) {
      if (bars[i - d].high >= bars[i].high || bars[i + d].high > bars[i].high) hi = false;
      if (bars[i - d].low <= bars[i].low || bars[i + d].low < bars[i].low) lo = false;
    }
    if (hi) raw.push({ t: "H", i, p: bars[i].high, c: i + k });
    if (lo) raw.push({ t: "L", i, p: bars[i].low, c: i + k });
  }
  return raw;
}

// Walk forward from `from` (the first bar AFTER entry).
function settle(bars, from, dir, entry, stop, target) {
  const long = dir === "LONG";
  const risk = long ? entry - stop : stop - entry;
  const reward = long ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0)) return null;
  const rr = reward / risk;
  const end = Math.min(from + MAX_BARS, bars.length);
  if (from >= end) return null;
  for (let i = from; i < end; i++) {
    const b = bars[i];
    if (long ? b.low <= stop : b.high >= stop) return { R: -1, win: 0, rr };
    if (long ? b.high >= target : b.low <= target) return { R: rr, win: 1, rr };
  }
  const last = bars[end - 1];
  return { R: (long ? last.close - entry : entry - last.close) / risk, win: 0, rr };
}

// Last bar a signal (or twin) may enter on, so the walk always has MAX_BARS.
const lastEntry = (bars) => bars.length - 2 - MAX_BARS;

function twin(bars, dir, stopDist, tgtDist) {
  const hi = lastEntry(bars);
  if (hi <= 60) return null;
  for (let t = 0; t < 10; t++) {
    const j = 60 + Math.floor(rnd() * (hi - 60));
    const px = bars[j].close;
    const long = dir === "LONG";
    const r = settle(bars, j + 1, dir, px, long ? px - stopDist : px + stopDist, long ? px + tgtDist : px - tgtDist);
    if (r) return r;
  }
  return null;
}

const rows = [];
const examples = [];

// Evaluated only at the moment the newest swing becomes knowable.
function shrinkingLegs(key, tf, bars, out, now) {
  if (out.length < 4) return 0;
  const [x0, x1, x2, x3] = out.slice(-4);
  if (x3.c !== now) return 0;
  const down = x0.t === "H" && x1.t === "L" && x2.t === "H" && x3.t === "L";
  const up = x0.t === "L" && x1.t === "H" && x2.t === "L" && x3.t === "H";
  if (!down && !up) return 0;
  const leg1 = Math.abs(x0.p - x1.p);
  const leg2 = Math.abs(x2.p - x3.p);
  if (!(leg2 < leg1)) return 0;
  const j = now;
  if (j > lastEntry(bars)) return 0;
  if ([x0, x1, x2, x3].some((x) => x.c > j)) throw new Error("look-ahead: swing used before it was confirmed");
  const dir = down ? "LONG" : "SHORT";
  const entry = bars[j].close;
  const stop = x3.p;
  const target = x2.p;
  const r = settle(bars, j + 1, dir, entry, stop, target);
  if (!r) return 0;
  const tw = twin(bars, dir, Math.abs(stop - entry), Math.abs(target - entry));
  rows.push({ rule: "SHRINK", key, tf, dir, ratio: leg2 / leg1, R: r.R, win: r.win, rr: r.rr, tR: tw ? tw.R : null, tWin: tw ? tw.win : null });
  return 1;
}

function headAndShoulders(key, tf, bars, out, now) {
  if (out.length < 5) return 0;
  const [p1, n1, p2, n2, p3] = out.slice(-5);
  if (p3.c !== now) return 0;
  const shape = [p1, n1, p2, n2, p3].map((x) => x.t).join("");
  const top = shape === "HLHLH";
  const bot = shape === "LHLHL";
  if (!top && !bot) return 0;
  if (top && !(p2.p > p1.p && p2.p > p3.p && p3.p < p1.p)) return 0;
  if (bot && !(p2.p < p1.p && p2.p < p3.p && p3.p > p1.p)) return 0;
  const dir = top ? "SHORT" : "LONG";
  const neckAt = (j) => n1.p + ((n2.p - n1.p) * (j - n1.i)) / (n2.i - n1.i);
  const limit = Math.min(lastEntry(bars), now + 3 * (p3.i - p1.i));
  for (let j = now; j <= limit; j++) {
    const b = bars[j];
    // void if price takes out the right shoulder before breaking the neck
    if (top ? b.high > p3.p : b.low < p3.p) return 0;
    const broke = top ? b.close < neckAt(j) : b.close > neckAt(j);
    if (!broke) continue;
    const height = Math.abs(p2.p - neckAt(p2.i));
    const entry = b.close;
    const stop = p3.p;
    const target = top ? neckAt(j) - height : neckAt(j) + height;
    const r = settle(bars, j + 1, dir, entry, stop, target);
    if (!r) return 0;
    const tw = twin(bars, dir, Math.abs(stop - entry), Math.abs(target - entry));
    rows.push({ rule: "H&S", key, tf, dir, R: r.R, win: r.win, rr: r.rr, tR: tw ? tw.R : null, tWin: tw ? tw.win : null });
    examples.push({ key, tf, dir, t: b.t, entry, stop, target, R: r.R });
    return 1;
  }
  return 0;
}

// Replay swings in the order they become knowable. `out` is the alternating
// swing list exactly as a trader watching live would have it at that bar.
function study(key, tf, bars) {
  const out = [];
  let hs = 0, sh = 0;
  for (const pv of rawPivots(bars, K)) {
    const last = out[out.length - 1];
    if (last && last.t === pv.t) {
      const moreExtreme = (pv.t === "H" && pv.p > last.p) || (pv.t === "L" && pv.p < last.p);
      if (!moreExtreme) continue;              // structure unchanged
      out[out.length - 1] = pv;                // the swing extends; trades already taken stay taken
    } else out.push(pv);
    sh += shrinkingLegs(key, tf, bars, out, pv.c);
    hs += headAndShoulders(key, tf, bars, out, pv.c);
  }
  return { hs, sh, swings: out.length };
}

console.log(`\nPattern control study  |  ${BARS} bars  |  swing size K=${K}  |  ${KEYS.join(", ")}\n`);
for (const key of KEYS) {
  const inst = INSTRUMENTS.find((i) => i.key === key);
  if (key !== "SIM" && !inst) { console.log(`  ${key}: unknown instrument`); continue; }
  for (const tf of TFS) {
    let bars;
    if (key === "SIM") bars = simBars(BARS, tf * 60);
    else {
      try { bars = await fetchGran(inst, BARS, tf * 60); }
      catch (e) { console.log(`  ${key} ${tf}m: fetch failed (${e.message})`); continue; }
    }
    if (!bars || bars.length < MAX_BARS + 200) { console.log(`  ${key} ${tf}m: too little data`); continue; }
    const r = study(key, tf, bars);
    const days = (bars.at(-1).t - bars[0].t) / 86400;
    console.log(`  ${key.padEnd(5)} ${String(tf).padStart(2)}m  ${days.toFixed(0).padStart(4)} days  ${String(r.swings).padStart(5)} swings  ->  ${String(r.hs).padStart(4)} head&shoulders   ${String(r.sh).padStart(5)} shrinking legs`);
  }
}

const stat = (vals) => {
  const n = vals.length;
  if (!n) return { n: 0, mean: 0, se: 0 };
  const m = vals.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean: m, se: sd / Math.sqrt(n) };
};
const sg = (x) => (x >= 0 ? "+" : "") + x.toFixed(3);

function table(title, subset, keyFn, minN = 15) {
  const g = new Map();
  for (const r of subset) {
    const k = keyFn(r);
    if (k == null || r.tR == null) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const out = [];
  for (const [label, rs] of g) {
    if (rs.length < minN) continue;
    const P = stat(rs.map((r) => r.R));
    const T = stat(rs.map((r) => r.tR));
    const D = stat(rs.map((r) => r.R - r.tR));   // paired difference
    const win = (100 * rs.reduce((a, r) => a + r.win, 0)) / rs.length;
    // The fair win-rate benchmark is the twin's: identical stop and target.
    const twinWin = (100 * rs.reduce((a, r) => a + (r.tWin || 0), 0)) / rs.length;
    const rrs = rs.map((r) => r.rr).sort((a, b) => a - b);
    out.push({ label, n: rs.length, win, twinWin, medRR: rrs[Math.floor(rrs.length / 2)], P, T, D, z: D.se > 0 ? D.mean / D.se : 0 });
  }
  if (!out.length) return;
  console.log(`\n${title}`);
  console.log(`  ${"bucket".padEnd(20)} ${"n".padStart(5)}  ${"win".padStart(6)}  ${"twin win".padStart(8)}  ${"med R:R".padStart(7)}  ${"pattern".padStart(9)}  ${"random".padStart(9)}  ${"difference".padStart(16)}`);
  for (const o of out) {
    const verdict = Math.abs(o.z) < 2 ? "" : o.z > 0 ? "  <- BEATS CHANCE" : "  <- worse than chance";
    console.log(`  ${o.label.padEnd(20)} ${String(o.n).padStart(5)}  ${(o.win.toFixed(1) + "%").padStart(6)}  ${(o.twinWin.toFixed(1) + "%").padStart(8)}  ${o.medRR.toFixed(2).padStart(7)}  ${(sg(o.P.mean) + "R").padStart(9)}  ${(sg(o.T.mean) + "R").padStart(9)}  ${(sg(o.D.mean) + ` (${Math.abs(o.z).toFixed(1)}s)`).padStart(16)}${verdict}`);
  }
}

const hs = rows.filter((r) => r.rule === "H&S");
const sh = rows.filter((r) => r.rule === "SHRINK");
const tfL = (tf) => (tf >= 60 ? tf / 60 + "H" : tf + "m");

console.log(`\n${"=".repeat(96)}\nRULE 1  HEAD AND SHOULDERS  (${hs.length} trades, each with a random twin)\n${"=".repeat(96)}`);
table("overall", hs, () => "all H&S", 5);
table("top (short) vs inverse bottom (long)", hs, (r) => (r.dir === "SHORT" ? "top -> short" : "bottom -> long"), 5);
table("by instrument and timeframe", hs, (r) => `${r.key} ${tfL(r.tf)}`, 5);

console.log(`\n${"=".repeat(96)}\nRULE 2  SHRINKING LEGS  (${sh.length} trades, each with a random twin)\n${"=".repeat(96)}`);
table("overall", sh, () => "all shrinking legs");
table("down legs shrinking (long) vs up legs shrinking (short)", sh, (r) => (r.dir === "LONG" ? "down shrank -> long" : "up shrank -> short"));
table("how much smaller was the second leg?", sh, (r) => (r.ratio < 0.5 ? "under half" : r.ratio < 0.8 ? "half to 80%" : "80% to 100%"));
table("by instrument and timeframe", sh, (r) => `${r.key} ${tfL(r.tf)}`);

if (!KEYS.includes("SIM")) {
  const recent = examples.filter((e) => e.tf === 15).sort((a, b) => b.t - a.t).slice(0, 4);
  if (recent.length) {
    console.log(`\nRecent head & shoulders the rule found on 15m (check them on your chart):`);
    for (const e of recent) {
      console.log(`  ${e.key.padEnd(5)} ${e.dir === "SHORT" ? "top   " : "bottom"}  break ${fmtTime(e.t, -4, "NY")}  entry ${e.entry.toFixed(2)}  stop ${e.stop.toFixed(2)}  target ${e.target.toFixed(2)}  result ${sg(e.R)}R`);
    }
  }
}
console.log(`\n"difference" compares each trade with its own random twin. Under 2s means the pattern`);
console.log(`did no better than entering the same trade at a random moment.\n`);
