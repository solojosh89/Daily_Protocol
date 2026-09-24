// ─────────────────────────────────────────────────────────────────────────
// THE INVERTED FAIR VALUE GAP RETEST
//
// From the user's own chart. Candle B clears candle A and closes the other
// way. The move away from B closes THROUGH a gap left by the leg into A, so
// that gap flips polarity: a bullish gap becomes resistance. Price pulls back
// into the inverted gap and that retest is the entry.
//
//   stop    B's manipulation wick, exactly as drawn
//   entry   a limit inside the inverted gap, three depths tested
//   target  2R, 3R, or the last swing the move came from
//
// The point of the test is the COMPARISON, on the very same setups:
//   close entry   sell B's close, the version every earlier test used
//   retest entry  wait for the pullback into the inverted gap
// The retest sits far closer to the stop, so the same target is worth more R.
// It also means a smaller stop, which the spread punishes harder. Which of
// those two wins is an arithmetic question, not a matter of taste.
//
// Controls: a same-weather twin that uses the SAME limit-order mechanics
// (matching order type is essential; comparing a limit fill with a market
// fill invents an edge that is not there), both 4H grids, random-walk
// markets, halves, and errors clustered by market and quarter.
//
//   node ifvg-retest.mjs            writes ifvg.json
//   GRID=1 node ifvg-retest.mjs     4H candles cut one hour later
//   LOOSE=1 node ifvg-retest.mjs    B only has to clear one side of A
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { detectSweep } from "./detector.mjs";

const DIR = process.env.H1_DIR || "C:/Users/hp/Documents/Smart ToDo List/h1-data";
const GRID = +(process.env.GRID || 0);
const LOOSE = !!process.env.LOOSE;      // B only needs to clear one side of A
const ATR_N = 14;
const FVG_LOOK = 10;      // the gap must have formed within this many candles of B
const INV_WIN = 6;        // price must close through the gap within this many candles of B
const RETEST_WIN = 12;    // and pull back into it within this many candles of that
const HORIZON = 60;       // candles allowed to resolve
const DEPTHS = { edge: 0, mid: 0.5, far: 1 };   // how deep into the zone the limit sits

let seed = 424242;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 987654321;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };

function toTF(h1, hours, offset = 0) {
  const out = []; let cur = null, bucket = null;
  for (const b of h1) {
    const k = Math.floor((b.t / 3600 - offset) / hours);
    if (k !== bucket) { if (cur) out.push(cur); bucket = k; cur = { t: b.t, open: b.open, high: b.high, low: b.low, close: b.close }; }
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; }
  }
  if (cur) out.push(cur);
  return out;
}
function atrSeries(bars) {
  const a = new Float64Array(bars.length).fill(NaN); let s = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], p = i ? bars[i - 1] : b;
    s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    if (i >= ATR_N) {
      const q = bars[i - ATR_N], qp = bars[i - ATR_N - 1] || q;
      s -= Math.max(q.high - q.low, Math.abs(q.high - qp.close), Math.abs(q.low - qp.close));
      a[i] = s / ATR_N;
    }
  }
  return a;
}
// every fair value gap, with where it formed. dir 1 = bullish gap (support until inverted)
function allFvg(bars) {
  const out = [];
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2], c = bars[i];
    if (c.low > a.high) out.push({ lo: a.high, hi: c.low, dir: 1, at: i });
    if (c.high < a.low) out.push({ lo: c.high, hi: a.low, dir: -1, at: i });
  }
  return out;
}

function race(bars, from, short, entry, stop, tgt) {
  const end = Math.min(bars.length, from + HORIZON);
  for (let k = from; k < end; k++) {
    const b = bars[k];
    if (short ? b.high >= stop : b.low <= stop) return { r: -1, done: 1 };
    if (short ? b.low <= tgt : b.high >= tgt) return { r: Math.abs(tgt - entry) / Math.abs(entry - stop), done: 1 };
  }
  if (end <= from) return null;
  const last = bars[end - 1].close, risk = Math.abs(entry - stop);
  const open = (short ? entry - last : last - entry) / risk;
  return { r: Math.max(-1, Math.min(Math.abs(tgt - entry) / risk, open)), done: 0 };
}

function runBook(key, bars4, spread, label) {
  const atr = atrSeries(bars4);
  const fvgs = allFvg(bars4);
  const rows = [];
  // Setup-level book: one record per manipulation candle, whether or not a
  // retest ever arrives. Without this, "wait for the retest" is measured only
  // on the days it worked out, which is the oldest mistake in backtesting.
  const setups = [];
  // same-weather pool for the twins
  const pool = [];
  for (let i = ATR_N + 2; i < bars4.length - HORIZON - RETEST_WIN - 2; i++) if (Number.isFinite(atr[i])) pool.push([atr[i] / bars4[i].close, i]);
  pool.sort((a, b) => a[0] - b[0]);
  const W = Math.max(25, Math.floor(pool.length * 0.02));
  const pick = (w) => {
    let lo = 0, hi = pool.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pool[m][0] < w) lo = m + 1; else hi = m; }
    const a = Math.max(0, lo - W), b = Math.min(pool.length - 1, lo + W);
    return pool[a + Math.floor(rnd() * (b - a + 1))][1];
  };

  for (let i = ATR_N + 3; i < bars4.length - HORIZON - RETEST_WIN - 2; i++) {
    if (!Number.isFinite(atr[i])) continue;
    const A = bars4[i - 1], B = bars4[i];
    let dir = null;
    const sig = detectSweep(A, B);
    if (sig) dir = sig.dir === "BULL" ? "LONG" : "SHORT";
    else if (LOOSE) {
      if (B.high > A.high && B.close < B.open && B.close < A.close) dir = "SHORT";
      else if (B.low < A.low && B.close > B.open && B.close > A.close) dir = "LONG";
    }
    if (!dir) continue;
    const short = dir === "SHORT";
    const stop = short ? B.high : B.low;                 // the manipulation wick, as drawn

    // the old way, recorded for every setup: enter at B's close, same stop
    const setupRisk = Math.abs(B.close - stop);
    const setupRec = { key, label, t: B.t, dir, strong: !!(sig && sig.strength === "STRONG"), closeR: null, retestR: null, waited: null };
    if (setupRisk > 2 * spread) {
      const sc = spread / setupRisk;
      const st = short ? B.close - 2 * setupRisk : B.close + 2 * setupRisk;
      const res = race(bars4, i + 1, short, B.close, stop, st);
      if (res) setupRec.closeR = res.r - sc;
    }
    setups.push(setupRec);

    // the gap that gets inverted is the OPPOSITE polarity to the trade:
    // a short inverts a bullish gap, a long inverts a bearish one
    const want = short ? 1 : -1;
    const cands = fvgs.filter((z) => z.dir === want && z.at <= i && z.at >= i - FVG_LOOK);
    if (!cands.length) continue;

    for (const z of cands) {
      // inversion: a close beyond the far side of the gap, within INV_WIN of B
      let inv = -1;
      for (let m = i; m <= Math.min(bars4.length - 1, i + INV_WIN); m++) {
        if (short ? bars4[m].close < z.lo : bars4[m].close > z.hi) { inv = m; break; }
      }
      if (inv < 0) continue;

      for (const [dname, depth] of Object.entries(DEPTHS)) {
        // limit inside the inverted zone: edge = nearest side, far = the other side
        const limit = short ? z.lo + depth * (z.hi - z.lo) : z.hi - depth * (z.hi - z.lo);
        if (short ? limit >= stop : limit <= stop) continue;      // entry must sit inside the stop
        const risk = Math.abs(stop - limit);
        if (!(risk > 0) || risk < 2 * spread) continue;

        // Does the retest happen INSIDE the manipulation candle, the way the
        // chart draws it? That is what makes the stop tighter than entering
        // at B's close. Recorded rather than assumed, so both can be compared.
        const inside = short ? limit > B.close && limit < B.high : limit < B.close && limit > B.low;

        // the retest: price trades back into the zone within RETEST_WIN candles
        let fi = -1;
        for (let k = inv + 1; k <= Math.min(bars4.length - 1, inv + RETEST_WIN); k++) {
          if (short ? bars4[k].high >= limit : bars4[k].low <= limit) { fi = k; break; }
          if (short ? bars4[k].high >= stop : bars4[k].low <= stop) break;   // stop taken before the fill
        }
        if (fi < 0) continue;
        const cost = spread / risk;

        for (const rr of [2, 3]) {
          const tgt = short ? limit - rr * risk : limit + rr * risk;
          const real = race(bars4, fi, short, limit, stop, tgt);
          if (!real) continue;

          // Twin: a random candle is treated as if it were the manipulation
          // candle. Structural stop at ITS extreme, limit at the same relative
          // spot between its close and that extreme, and the same requirement
          // that price must come back to the limit before the stop. Same order
          // type, same shape of trade, only the candle is unremarkable.
          const q = pick(atr[i] / B.close);
          const Q = bars4[q];
          const tStop = short ? Q.high : Q.low;
          const span = Math.abs(tStop - Q.close);
          if (!(span > 0)) continue;
          const frac = Math.abs(limit - B.close) / Math.max(1e-12, Math.abs(stop - B.close));
          const tLimit = short ? Q.close + frac * span : Q.close - frac * span;
          const tRisk = Math.abs(tStop - tLimit);
          if (!(tRisk > 0) || tRisk < 2 * spread) continue;
          let tfi = -1;
          for (let k = q + 1; k <= Math.min(bars4.length - 1, q + RETEST_WIN); k++) {
            if (short ? bars4[k].high >= tLimit : bars4[k].low <= tLimit) { tfi = k; break; }
            if (short ? bars4[k].high >= tStop : bars4[k].low <= tStop) break;
          }
          if (tfi < 0) continue;
          const tTgt = short ? tLimit - rr * tRisk : tLimit + rr * tRisk;
          const twin = race(bars4, tfi, short, tLimit, tStop, tTgt);
          if (!twin) continue;
          const tCost = spread / tRisk;

          // the same setup taken the old way: at B's close, stop at the same wick
          const cRisk = Math.abs(B.close - stop);
          const cCost = cRisk > 0 ? spread / cRisk : NaN;
          const cTgt = short ? B.close - rr * cRisk : B.close + rr * cRisk;
          const close = cRisk > 2 * spread ? race(bars4, i + 1, short, B.close, stop, cTgt) : null;

          // the canonical retest for the setup-level comparison: deepest limit,
          // inside the manipulation candle, 2R target, first one that fills
          if (rr === 2 && dname === "far" && inside && setupRec.retestR === null) {
            setupRec.retestR = real.r - cost;
            setupRec.waited = fi - i;
          }
          rows.push({
            key, label, t: B.t, dir, rr, depth: dname, inside, strong: !!(sig && sig.strength === "STRONG"),
            retestR: real.r - cost, twinR: twin.r - tCost, closeR: close ? close.r - cCost : null,
            risk, closeRisk: cRisk, cost, closeCost: cCost, waited: fi - i, done: real.done,
          });
        }
      }
    }
  }
  return { rows, setups };
}

// ── run ──────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const quarter = (t) => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3)}`; };
function clusterZ(rows, f) {
  if (rows.length < 30) return NaN;
  const ds = rows.map(f), m = mean(ds), n = ds.length;
  const cl = new Map();
  rows.forEach((r, i) => { const k = r.key + quarter(r.t); cl.set(k, (cl.get(k) || 0) + (ds[i] - m) / n); });
  const v = [...cl.values()].reduce((s, x) => s + x * x, 0);
  return v > 0 ? m / Math.sqrt(v) : NaN;
}

const all = [];
const allSetups = [];
const perMarket = {};
for (const f of readdirSync(DIR).filter((x) => x.endsWith("-H1.json"))) {
  const j = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
  const h1 = j.bars.map((b) => ({ t: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }));
  if (h1.length < 5000) continue;
  const bars4 = toTF(h1, 4, GRID);
  const { rows, setups } = runBook(j.key, bars4, j.spread, "real");
  perMarket[j.key] = { candles: bars4.length, entries: rows.filter((r) => r.rr === 3 && r.depth === "edge").length, setups: setups.length };
  all.push(...rows);
  allSetups.push(...setups);

  let p = 100;
  const fake = bars4.map((b) => {
    const o = p; let hi = p, lo = p;
    for (let k = 0; k < 16; k++) { p *= 1 + 0.0025 * gauss(); if (p > hi) hi = p; if (p < lo) lo = p; }
    return { t: b.t, open: o, high: hi, low: lo, close: p };
  });
  all.push(...runBook(j.key, fake, j.spread * (100 / bars4[0].close), "sim").rows);
  console.log(`${j.key.padEnd(8)} ${bars4.length} 4H candles, ${perMarket[j.key].entries} inverted-gap retests`);
}

const pct = (x) => (x * 100).toFixed(1) + "%";
const sg = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const z2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
const line = "=".repeat(128);
const real = all.filter((r) => r.label === "real");
const sim = all.filter((r) => r.label === "sim");
const mid = real.length ? [...real].sort((a, b) => a.t - b.t)[Math.floor(real.length / 2)].t : 0;

console.log(`\n${line}\nINVERTED GAP RETEST. 4H grid offset ${GRID}h. ${LOOSE ? "B only has to clear one side of A." : "B must take both sides of A."}`);
console.log(`${real.length} real entries, ${sim.length} on fake markets.\n`);
console.log(`  ${"depth".padEnd(6)} ${"target".padStart(6)} ${"entries".padStart(8)} ${"win".padStart(7)} ${"need".padStart(6)} ${"stop".padStart(8)} ${"cost".padStart(6)} ${"RETEST".padStart(8)} ${"twin".padStart(8)} ${"z".padStart(6)} ${"z vs 0".padStart(7)} ${"old".padStart(8)} ${"new".padStart(8)} | ${"FAKE R".padStart(8)} ${"cost".padStart(5)} ${"z vs 0".padStart(7)} | ${"at B close".padStart(12)}`);
const results = [];
for (const [posName, posFn] of [["inside B", (r) => r.inside], ["below B", (r) => !r.inside]]) {
  console.log(`\n  --- retest ${posName === "inside B" ? "INSIDE the manipulation candle, the way the chart draws it" : "below the manipulation candle's close"} ---`);
for (const depth of Object.keys(DEPTHS)) {
  for (const rr of [2, 3]) {
    const G = real.filter((r) => r.depth === depth && r.rr === rr && posFn(r));
    if (G.length < 40) continue;
    const S = sim.filter((r) => r.depth === depth && r.rr === rr && posFn(r));
    const withClose = G.filter((r) => r.closeR != null);
    const row = {
      pos: posName, depth, rr, n: G.length,
      win: G.filter((r) => r.retestR > 0).length / G.length,
      need: 1 / (1 + rr),
      medStop: [...G.map((r) => r.risk / r.closeRisk)].sort((a, b) => a - b)[Math.floor(G.length / 2)],
      cost: mean(G.map((r) => r.cost)),
      retest: mean(G.map((r) => r.retestR)),
      twin: mean(G.map((r) => r.twinR)),
      z: clusterZ(G, (r) => r.retestR - r.twinR),
      // the direct question: is this book's return above zero, with errors
      // clustered by market and quarter so a good year cannot fake it?
      z0: clusterZ(G, (r) => r.retestR),
      simCost: S.length > 30 ? mean(S.map((r) => r.cost)) : NaN,
      simZ0: S.length > 30 ? clusterZ(S, (r) => r.retestR) : NaN,
      old: mean(G.filter((r) => r.t < mid).map((r) => r.retestR)),
      new: mean(G.filter((r) => r.t >= mid).map((r) => r.retestR)),
      simR: S.length > 30 ? mean(S.map((r) => r.retestR - r.twinR)) : NaN,
      // the number that settles it: what the SAME rule earns on a random walk,
      // where no edge can exist. If the real book matches it, the result is mechanics.
      simAbs: S.length > 30 ? mean(S.map((r) => r.retestR)) : NaN,
      simWin: S.length > 30 ? S.filter((r) => r.retestR > 0).length / S.length : NaN,
      nSim: S.length,
      closeR: withClose.length ? mean(withClose.map((r) => r.closeR)) : NaN,
      nClose: withClose.length,
      vsClose: withClose.length > 30 ? clusterZ(withClose, (r) => r.retestR - r.closeR) : NaN,
    };
    results.push(row);
    console.log(`  ${depth.padEnd(6)} ${(rr + "R").padStart(6)} ${String(row.n).padStart(8)} ${pct(row.win).padStart(7)} ${pct(row.need).padStart(6)} ${(row.medStop.toFixed(2) + "x").padStart(8)} ${row.cost.toFixed(2).padStart(6)} ${sg(row.retest).padStart(8)} ${sg(row.twin).padStart(8)} ${z2(row.z).padStart(6)} ${z2(row.z0).padStart(7)} ${sg(row.old).padStart(8)} ${sg(row.new).padStart(8)} | ${sg(row.simAbs).padStart(8)} ${(Number.isFinite(row.simCost) ? row.simCost.toFixed(2) : "n/a").padStart(5)} ${z2(row.simZ0).padStart(7)} | ${sg(row.closeR).padStart(12)}`);
  }
}
}

// ── the decision: take B's close, or wait for the retest? ────────────────
// Counted per SETUP. Waiting and never getting filled is a zero, not a gap
// in the record. Both routes use a 2R target and the same stop.
const S2 = allSetups.filter((s) => s.closeR != null);
const filled = S2.filter((s) => s.retestR != null);
const waitBook = S2.map((s) => (s.retestR != null ? s.retestR : 0));
const closeBook = S2.map((s) => s.closeR);
const hybrid = S2.map((s) => (s.retestR != null ? s.retestR : s.closeR));
console.log(`\n${line}\nTAKE B'S CLOSE, OR WAIT FOR THE RETEST? ${S2.length} setups, 2R target, same stop on both routes`);
console.log(`  ${"route".padEnd(34)} ${"trades".padStart(7)} ${"per setup".padStart(10)} ${"per trade".padStart(10)} ${"z vs 0".padStart(7)}`);
console.log(`  ${"enter at B's close, always".padEnd(34)} ${String(S2.length).padStart(7)} ${sg(mean(closeBook)).padStart(10)} ${sg(mean(closeBook)).padStart(10)} ${z2(clusterZ(S2, (s) => s.closeR)).padStart(7)}`);
console.log(`  ${"wait for the retest only".padEnd(34)} ${String(filled.length).padStart(7)} ${sg(mean(waitBook)).padStart(10)} ${sg(mean(filled.map((s) => s.retestR))).padStart(10)} ${z2(clusterZ(filled, (s) => s.retestR)).padStart(7)}`);
console.log(`  ${"retest if it comes, else the close".padEnd(34)} ${String(S2.length).padStart(7)} ${sg(mean(hybrid)).padStart(10)} ${sg(mean(hybrid)).padStart(10)} ${z2(clusterZ(S2, (s) => (s.retestR != null ? s.retestR : s.closeR))).padStart(7)}`);
console.log(`  the retest arrives on ${pct(filled.length / S2.length)} of setups, after a median of ${[...filled.map((s) => s.waited)].sort((a, b) => a - b)[Math.floor(filled.length / 2)]} candles`);
console.log(`  on the setups where it DOES arrive: close ${sg(mean(filled.map((s) => s.closeR)))}R against retest ${sg(mean(filled.map((s) => s.retestR)))}R, z ${z2(clusterZ(filled, (s) => s.retestR - s.closeR))}`);

// market by market, so one lucky instrument cannot carry the result
console.log(`\n  ${"market".padEnd(9)} ${"setups".padStart(7)} ${"retests".padStart(8)} ${"fires".padStart(6)} ${"close entry".padStart(12)} ${"retest entry".padStart(13)}`);
const byMarket = [];
for (const k of [...new Set(S2.map((s) => s.key))].sort()) {
  const M = S2.filter((s) => s.key === k), F = M.filter((s) => s.retestR != null);
  if (F.length < 40) continue;
  const row = { key: k, setups: M.length, fills: F.length, rate: F.length / M.length, close: mean(M.map((s) => s.closeR)), retest: mean(F.map((s) => s.retestR)) };
  byMarket.push(row);
  console.log(`  ${k.padEnd(9)} ${String(row.setups).padStart(7)} ${String(row.fills).padStart(8)} ${pct(row.rate).padStart(6)} ${sg(row.close).padStart(12)} ${sg(row.retest).padStart(13)}`);
}
console.log(`  markets where the retest beats the close: ${byMarket.filter((m) => m.retest > m.close).length} of ${byMarket.length}`);
console.log(`  markets where the retest is above zero:   ${byMarket.filter((m) => m.retest > 0).length} of ${byMarket.length}`);

const strong = real.filter((r) => r.strong && r.rr === 3 && r.depth === "edge");
if (strong.length > 40)
  console.log(`\n  strong candles only, edge entry, 3R: ${strong.length} entries, ${sg(mean(strong.map((r) => r.retestR)))}R against twin ${sg(mean(strong.map((r) => r.twinR)))}R, z ${z2(clusterZ(strong, (r) => r.retestR - r.twinR))}`);

writeFileSync(process.env.OUT || "ifvg.json", JSON.stringify({
  built: new Date().toISOString(), grid: GRID, loose: LOOSE,
  fvgLook: FVG_LOOK, invWin: INV_WIN, retestWin: RETEST_WIN, horizon: HORIZON,
  entries: real.length, simEntries: sim.length, perMarket, results,
  decision: {
    setups: S2.length, filledPct: filled.length / S2.length,
    closePerSetup: mean(closeBook), closeZ: clusterZ(S2, (s) => s.closeR),
    waitPerSetup: mean(waitBook), waitPerTrade: mean(filled.map((s) => s.retestR)), waitZ: clusterZ(filled, (s) => s.retestR),
    hybridPerSetup: mean(hybrid), hybridZ: clusterZ(S2, (s) => (s.retestR != null ? s.retestR : s.closeR)),
    onFilledClose: mean(filled.map((s) => s.closeR)), onFilledRetest: mean(filled.map((s) => s.retestR)),
    onFilledZ: clusterZ(filled, (s) => s.retestR - s.closeR),
    medianWait: [...filled.map((s) => s.waited)].sort((a, b) => a - b)[Math.floor(filled.length / 2)],
    byMarket,
    marketsRetestBeatsClose: byMarket.filter((m) => m.retest > m.close).length,
    marketsRetestPositive: byMarket.filter((m) => m.retest > 0).length,
    marketsTotal: byMarket.length,
  },
  strong: strong.length > 40 ? { n: strong.length, r: mean(strong.map((r) => r.retestR)), twin: mean(strong.map((r) => r.twinR)), z: clusterZ(strong, (r) => r.retestR - r.twinR) } : null,
}, null, 1));
console.log(`\nstop = the retest stop as a multiple of the stop you would carry entering at B's close. Under 1 means a tighter stop.`);
console.log(`cost = spread as a share of that stop. RETEST = per trade R after cost. twin = same limit mechanics at a random moment.`);
console.log(`the last pair of columns is the SAME setups taken the old way, at B's close, and z is retest minus close.`);
console.log(`\nwrote ${process.env.OUT || "ifvg.json"}`);
