// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// SOL -> BOS 1 -> BOS 2 -> 0.886, AS THE USER DRAWS IT
//
// The first version of this test used a loose SOL and the wrong BOS. This one
// follows the user's drawing and the bot's own ict.mjs definitions:
//
//   swing    a 3 candle pivot, only real once the candle after it has closed
//   SOL      two untaken relative highs, the LEFT one higher by at most half
//            an ATR and at least 3 candles apart. One candle trades above
//            both and closes back below the left one. (ict.mjs "pair" pool.)
//   BOS 1    a close below the most recent swing low that existed before SOL
//   BOS 2    a swing low that forms AFTER BOS 1, then a close below it
//   fib      1 = the SOL high, 0 = the lowest low since, redrawn as new lows print
//   entry    limit at 0.886. A candle that reaches the stop has passed through
//            the entry first, so that is a filled-and-stopped loss.
//   stop     the SOL high, the fib 1
//   target   back to the leg's low, or 3R
//
// Every level is causal: only what had closed by that candle is used.
// PRINT=XAUUSD prints recent setups with dates and prices to check by hand.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
import { readFileSync, writeFileSync, readdirSync } from "fs";

const DIR = process.env.H1_DIR || "C:/Users/hp/Documents/Smart ToDo List/h1-data";
const FIB = +(process.env.FIB || 0.886);
const PAIR_TOL = 0.5, PAIR_GAP = 3, LOOK = 120;
const BOS_WIN = 30, FILL_WIN = 60, WALK = 120;
const PRINT = process.env.PRINT ? process.env.PRINT.toUpperCase() : null;
const NEED_BOS2 = process.env.ONE_BOS ? false : true;

let seed = 5150; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let ss = 24601; const su = () => (ss = (ss * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = su(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * su()); };

function toTF(h1, hours, offset = 0) {
  const out = []; let cur = null, bk = null;
  for (const b of h1) {
    const k = Math.floor((b.t / 3600 - offset) / hours);
    if (k !== bk) { if (cur) out.push(cur); bk = k; cur = { t: b.t, open: b.open, high: b.high, low: b.low, close: b.close }; }
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; }
  }
  if (cur) out.push(cur);
  return out;
}
function atrOf(bars) {
  const a = new Float64Array(bars.length).fill(NaN); let s = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], p = i ? bars[i - 1] : b;
    s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    if (i >= 14) { const q = bars[i - 14], qp = bars[i - 15] || q; s -= Math.max(q.high - q.low, Math.abs(q.high - qp.close), Math.abs(q.low - qp.close)); a[i] = s / 14; }
  }
  return a;
}
// swing at m is known only once m+1 has closed, i.e. from candle m+2 onward
function swings(bars) {
  const H = [], L = [];
  for (let m = 1; m < bars.length - 1; m++) {
    if (bars[m].high > bars[m - 1].high && bars[m].high > bars[m + 1].high) H.push({ idx: m, known: m + 2, price: bars[m].high });
    if (bars[m].low < bars[m - 1].low && bars[m].low < bars[m + 1].low) L.push({ idx: m, known: m + 2, price: bars[m].low });
  }
  return { H, L };
}
function race(bars, from, short, entry, stop, tgt) {
  const end = Math.min(bars.length, from + WALK);
  for (let k = from; k < end; k++) {
    const b = bars[k];
    if (short ? b.high >= stop : b.low <= stop) return -1;
    if (short ? b.low <= tgt : b.high >= tgt) return Math.abs(tgt - entry) / Math.abs(entry - stop);
  }
  if (end <= from) return null;
  const last = bars[end - 1].close, risk = Math.abs(entry - stop);
  return Math.max(-1, Math.min(Math.abs(tgt - entry) / risk, (short ? entry - last : last - entry) / risk));
}

function runBook(key, bars, spread, label, examples) {
  const atr = atrOf(bars);
  const sw = swings(bars);
  const rows = [];
  const pool = [];
  for (let i = 20; i < bars.length - WALK - 2; i++) if (Number.isFinite(atr[i])) pool.push([atr[i] / bars[i].close, i]);
  pool.sort((a, b) => a[0] - b[0]);
  const PW = Math.max(25, Math.floor(pool.length * 0.02));
  const pick = (w) => {
    let a = 0, b = pool.length;
    while (a < b) { const m = (a + b) >> 1; if (pool[m][0] < w) a = m + 1; else b = m; }
    const x = Math.max(0, a - PW), y = Math.min(pool.length - 1, a + PW);
    return pool[x + Math.floor(rnd() * (y - x + 1))][1];
  };

  for (const dir of ["SHORT", "LONG"]) {
    const short = dir === "SHORT";
    const tops = short ? sw.H : sw.L;           // the pair that gets swept
    const floors = short ? sw.L : sw.H;         // the swings whose break is a BOS
    const beyond = (a, b) => (short ? a - b : b - a);   // how far a sticks out past b
    let ti = 0;
    const live = [];                            // untaken tops, known so far

    for (let j = 20; j < bars.length - BOS_WIN - FILL_WIN - WALK; j++) {
      while (ti < tops.length && tops[ti].known <= j) { live.push(tops[ti]); ti++; }
      // drop anything already taken before this candle, and anything too old
      for (let k = live.length - 1; k >= 0; k--) {
        if (live[k].idx < j - LOOK || live[k].taken) live.splice(k, 1);
      }
      if (live.length < 2 || !Number.isFinite(atr[j])) continue;
      const B = bars[j];

      // SOL: find a left/right pair, left sticking out a little further, swept together
      let sol = null;
      for (let a = live.length - 1; a >= 1 && !sol; a--) {
        const right = live[a];
        for (let b = a - 1; b >= 0; b--) {
          const left = live[b];
          if (right.idx - left.idx < PAIR_GAP) continue;
          const d = beyond(left.price, right.price);
          if (!(d > 0 && d <= PAIR_TOL * atr[j])) continue;
          const tookBoth = short ? B.high > left.price : B.low < left.price;
          const closedBack = short ? B.close < left.price : B.close > left.price;
          if (tookBoth && closedBack) { sol = { left, right }; break; }
        }
      }
      // mark tops this candle took out, whatever happened
      for (const t of live) if (short ? B.high > t.price : B.low < t.price) t.taken = true;
      if (!sol) continue;

      const H = short ? B.high : B.low;         // fib 1 and the stop

      // BOS 1: most recent swing on the other side, known before the SOL candle
      const prior = floors.filter((f) => f.known <= j && f.idx < j);
      if (!prior.length) continue;
      const bos1Lvl = prior[prior.length - 1].price;
      let bos1 = -1, dead = false;
      for (let k = j + 1; k <= j + BOS_WIN && k < bars.length; k++) {
        if (short ? bars[k].high > H : bars[k].low < H) { dead = true; break; }
        if (short ? bars[k].close < bos1Lvl : bars[k].close > bos1Lvl) { bos1 = k; break; }
      }
      if (dead || bos1 < 0) continue;

      // BOS 2: a swing that forms after BOS 1, confirmed, then closed through
      let bos2 = -1, bos2Lvl = null;
      if (!NEED_BOS2) { bos2 = bos1; bos2Lvl = bos1Lvl; }
      else
      for (let k = bos1 + 1; k <= j + BOS_WIN && k < bars.length; k++) {
        if (short ? bars[k].high > H : bars[k].low < H) { dead = true; break; }
        const after = floors.filter((f) => f.idx > bos1 && f.known <= k);
        if (!after.length) continue;
        const lvl = after[after.length - 1].price;
        if (short ? bars[k].close < lvl : bars[k].close > lvl) { bos2 = k; bos2Lvl = lvl; break; }
      }
      if (dead || bos2 < 0) continue;

      // fib from the SOL high to the lowest low since, redrawn as new lows print
      let L = short ? Infinity : -Infinity;
      for (let k = j; k <= bos2; k++) L = short ? Math.min(L, bars[k].low) : Math.max(L, bars[k].high);
      let filled = -1, entry = 0, sameBarStop = false;
      for (let k = bos2 + 1; k <= bos2 + FILL_WIN && k < bars.length; k++) {
        const b = bars[k];
        const lvl = short ? L + FIB * (H - L) : L - FIB * (L - H);
        if (short ? b.high >= lvl : b.low <= lvl) { filled = k; entry = lvl; sameBarStop = short ? b.high >= H : b.low <= H; break; }
        L = short ? Math.min(L, b.low) : Math.max(L, b.high);
      }
      if (filled < 0) continue;
      const risk = Math.abs(H - entry);
      if (!(risk > 0) || risk < 2 * spread) continue;
      const cost = spread / risk;

      for (const [tname, tgt] of [["full leg", L], ["3R", short ? entry - 3 * risk : entry + 3 * risk]]) {
        const rr = Math.abs(tgt - entry) / risk;
        const r = sameBarStop ? -1 : race(bars, filled + 1, short, entry, H, tgt);
        if (r == null) continue;
        const q = pick(atr[filled] / bars[filled].close);
        const tE = bars[q].close, tS = short ? tE * (1 + risk / entry) : tE * (1 - risk / entry);
        const tT = short ? tE - rr * Math.abs(tS - tE) : tE + rr * Math.abs(tS - tE);
        const tr = race(bars, q + 1, short, tE, tS, tT);
        if (tr == null) continue;
        rows.push({ key, label, t: bars[filled].t, dir, target: tname, rr, r: r - cost, twin: tr - cost, cost });
        if (examples && tname === "full leg") {
          const d = (i) => new Date(bars[i].t * 1000).toISOString().slice(0, 16).replace("T", " ");
          examples.push({ dir, sol: d(j), left: sol.left.price, right: sol.right.price, H, bos1: d(bos1), bos1Lvl, bos2: d(bos2), bos2Lvl, L, entry, fill: d(filled), out: r > 0 ? "WIN" : r <= -1 ? "stopped" : "open " + r.toFixed(2) });
        }
      }
    }
  }
  return rows;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const quarter = (t) => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3)}`; };
function clusterZ(rows, f) {
  if (rows.length < 30) return NaN;
  const ds = rows.map(f), m = mean(ds), n = ds.length, cl = new Map();
  rows.forEach((r, i) => { const k = r.key + quarter(r.t); cl.set(k, (cl.get(k) || 0) + (ds[i] - m) / n); });
  const v = [...cl.values()].reduce((s, x) => s + x * x, 0);
  return v > 0 ? m / Math.sqrt(v) : NaN;
}
const pct = (x) => (x * 100).toFixed(1) + "%";
const sg = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const z2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");

const all = [];
const examples = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith("-H1.json"))) {
  const j = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
  const h1 = j.bars.map((b) => ({ t: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }));
  if (h1.length < 5000) continue;
  for (const [tf, hours, grid] of [["1H", 1, 0], ["4H", 4, 0], ["4H+2", 4, 2]]) {
    const bars = toTF(h1, hours, grid);
    const ex = PRINT === j.key && tf === "4H" ? examples : null;
    for (const r of runBook(j.key, bars, j.spread, "real", ex)) all.push({ ...r, tf });
    let p = 100;
    const fake = bars.map((b) => { const o = p; let hi = p, lo = p; for (let k = 0; k < 12; k++) { p *= 1 + 0.0035 * gauss(); if (p > hi) hi = p; if (p < lo) lo = p; } return { t: b.t, open: o, high: hi, low: lo, close: p }; });
    for (const r of runBook(j.key, fake, j.spread * (100 / bars[0].close), "sim", null)) all.push({ ...r, tf });
  }
}

const real = all.filter((r) => r.label === "real"), sim = all.filter((r) => r.label === "sim");
const mid = real.length ? [...real].sort((a, b) => a.t - b.t)[Math.floor(real.length / 2)].t : 0;
console.log(`SOL (relative pair, left higher) -> BOS 1 -> BOS 2 -> limit at ${FIB}. ${real.length} real entries, ${sim.length} on random-walk markets.\n`);
console.log(`  ${"tf".padEnd(6)} ${"target".padEnd(9)} ${"trades".padStart(7)} ${"win".padStart(7)} ${"need".padStart(7)} ${"reward".padStart(7)} ${"NET".padStart(8)} ${"twin".padStart(8)} ${"z vs 0".padStart(7)} ${"old".padStart(8)} ${"new".padStart(8)} ${"RANDOM".padStart(8)}`);
const out = [];
for (const tf of ["1H", "4H", "4H+2"]) for (const tname of ["full leg", "3R"]) {
  const G = real.filter((r) => r.tf === tf && r.target === tname);
  if (G.length < 20) { console.log(`  ${tf.padEnd(6)} ${tname.padEnd(9)} ${String(G.length).padStart(7)}  too few to measure`); continue; }
  const S = sim.filter((r) => r.tf === tf && r.target === tname);
  const rr = mean(G.map((r) => r.rr));
  const row = { tf, target: tname, n: G.length, rr, win: G.filter((r) => r.r > 0).length / G.length, need: 1 / (1 + rr),
    net: mean(G.map((r) => r.r)), twin: mean(G.map((r) => r.twin)), z0: clusterZ(G, (r) => r.r),
    old: mean(G.filter((r) => r.t < mid).map((r) => r.r)), new: mean(G.filter((r) => r.t >= mid).map((r) => r.r)),
    simNet: S.length > 20 ? mean(S.map((r) => r.r)) : NaN };
  out.push(row);
  console.log(`  ${tf.padEnd(6)} ${tname.padEnd(9)} ${String(row.n).padStart(7)} ${pct(row.win).padStart(7)} ${pct(row.need).padStart(7)} ${(row.rr.toFixed(1) + "R").padStart(7)} ${sg(row.net).padStart(8)} ${sg(row.twin).padStart(8)} ${z2(row.z0).padStart(7)} ${sg(row.old).padStart(8)} ${sg(row.new).padStart(8)} ${sg(row.simNet).padStart(8)}`);
}
if (examples.length) {
  console.log(`\nLAST 8 ${PRINT} 4H SETUPS, times in UTC. Check these on your own chart:`);
  for (const e of examples.slice(-8)) {
    console.log(`  ${e.dir.padEnd(5)} SOL ${e.sol} took ${e.left.toFixed(2)} and ${e.right.toFixed(2)}, high ${e.H.toFixed(2)} | BOS1 ${e.bos1} through ${e.bos1Lvl.toFixed(2)} | BOS2 ${e.bos2} through ${e.bos2Lvl.toFixed(2)} | low ${e.L.toFixed(2)} | entry ${e.entry.toFixed(2)} on ${e.fill} | ${e.out}`);
  }
}
writeFileSync(process.env.OUT || "solbos2.json", JSON.stringify({ built: new Date().toISOString(), fib: FIB, rows: out, examples }, null, 1));
console.log(`\nwrote ${process.env.OUT || "solbos2.json"}`);

