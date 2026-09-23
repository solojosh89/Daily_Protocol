// ─────────────────────────────────────────────────────────────────────────
// MANIPULATION CANDLE — WIN RATE BY TARGET DISTANCE
//
// Answers one question: what win rate does the user's rule actually produce,
// and what win rate does it NEED to break even at that target?
//
//   entry   candle B's close (B took both sides of A, then closed one way)
//   stop    exactly B's low (long) or B's high (short)
//   target  several versions, each scored separately
//
// No time limit here: every trade is walked until the stop or the target is
// hit (up to 500 candles). Trades still open at the end of the data are
// reported separately and left out of the win rate, so nothing is guessed.
//
// Break-even win rate for a target of R is 100 / (1 + R). A 68% win rate at a
// 0.5R target and a 25% win rate at 3R are the same thing: nothing.
//
//   DATA_DIR=folder node manip-winrate.mjs            daily + 4H, 16 markets
//   VERIFY=XAUUSD node manip-winrate.mjs              also print real trades to check on a chart
// ─────────────────────────────────────────────────────────────────────────
import { detectSweep } from "./detector.mjs";
import { MARKETS, loadBars } from "./research-markets.mjs";

const WALK = 500, SWING_LOOK = 60, ATR_N = 14;
const FIXED = [0.5, 1, 2, 3];
let seed = 8675309;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// walk until stop or target; returns "win", "loss" or "open"
function settle(bars, from, dir, entry, stop, target) {
  const short = dir === "SHORT";
  for (let k = from; k < Math.min(bars.length, from + WALK); k++) {
    const b = bars[k];
    const hitStop = short ? b.high >= stop : b.low <= stop;
    const hitTgt = short ? b.low <= target : b.high >= target;
    if (hitStop && hitTgt) return { r: "loss", at: k };     // same candle: the conservative call
    if (hitStop) return { r: "loss", at: k };
    if (hitTgt) return { r: "win", at: k };
  }
  return { r: "open", at: -1 };
}

const rows = [];
const verify = process.env.VERIFY ? process.env.VERIFY.toUpperCase() : null;
const examples = [];

for (const tf of ["1D", "240"]) {
  for (const [key, sym] of MARKETS) {
    let bars;
    try { ({ bars } = await loadBars(sym, tf, 20000)); } catch { continue; }
    const n = bars.length;
    const pool = [];                                        // same-weather random partners
    const atr = new Float64Array(n).fill(NaN);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const tr = i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low;
      if (i >= ATR_N) atr[i] = s / ATR_N;
      s += tr;
      if (i >= ATR_N) {
        const p = bars[i - ATR_N], pp = i - ATR_N ? bars[i - ATR_N - 1] : null;
        s -= pp ? Math.max(p.high - p.low, Math.abs(p.high - pp.close), Math.abs(p.low - pp.close)) : p.high - p.low;
      }
    }
    for (let q = ATR_N + 1; q < n - 1; q++) if (Number.isFinite(atr[q])) pool.push([atr[q] / bars[q].close, q]);
    pool.sort((a, b) => a[0] - b[0]);
    const W = Math.max(25, Math.floor(pool.length * 0.02));
    const pick = (w) => {
      let lo = 0, hi = pool.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid][0] < w) lo = mid + 1; else hi = mid; }
      const a = Math.max(0, lo - W), b = Math.min(pool.length - 1, lo + W);
      return pool[a + Math.floor(rnd() * (b - a + 1))][1];
    };

    for (let j = ATR_N + 2; j < n - 2; j++) {
      if (!Number.isFinite(atr[j])) continue;
      const sig = detectSweep(bars[j - 1], bars[j]);
      if (!sig) continue;
      const dir = sig.dir === "BULL" ? "LONG" : "SHORT";
      const entry = bars[j].close, stop = dir === "LONG" ? bars[j].low : bars[j].high;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) continue;
      const price = (R) => (dir === "LONG" ? entry + R * risk : entry - R * risk);

      const targets = FIXED.map((R) => [`${R}R`, R, price(R)]);
      // the nearest swing high above (swing low below), confirmed before this candle
      let best = null;
      for (let i = Math.max(1, j - SWING_LOOK); i <= j - 2; i++) {
        const a = bars[i - 1], m = bars[i], c = bars[i + 1];
        if (dir === "LONG") { if (m.high > a.high && m.high > c.high && m.high > entry && (best === null || m.high < best)) best = m.high; }
        else if (m.low < a.low && m.low < c.low && m.low < entry && (best === null || m.low > best)) best = m.low;
      }
      if (best != null) targets.push(["nearest high/low", Math.abs(best - entry) / risk, best]);

      const q = pick(atr[j] / bars[j].close), te = bars[q].close;
      for (const [name, R, tp] of targets) {
        if (!(R > 0.05) || R > 20) continue;
        const res = settle(bars, j + 1, dir, entry, stop, tp);
        const ts = dir === "SHORT" ? te * (1 + risk / entry) : te * (1 - risk / entry);
        const tt = dir === "SHORT" ? te - R * Math.abs(te - ts) : te + R * Math.abs(te - ts);
        const tr = settle(bars, q + 1, dir, te, ts, tt);
        rows.push({ tf, key, name, R, res: res.r, tRes: tr.r, dir, strength: sig.strength });
        if (verify && key === verify && tf === "1D" && name === "nearest high/low" && res.r !== "open") {
          examples.push({ date: new Date(bars[j].t * 1000).toISOString().slice(0, 10), dir, entry, stop, tp, R, out: res.r, days: res.at - j });
        }
      }
    }
  }
}

const pct = (x) => (x * 100).toFixed(1) + "%";
const sg = (x) => (x >= 0 ? "+" : "") + x.toFixed(3);
function report(tf, label) {
  const T = rows.filter((r) => r.tf === tf);
  console.log(`\n${"=".repeat(112)}\n${label}`);
  console.log(`  ${"target".padEnd(20)} ${"trades".padStart(6)}  ${"avg R".padStart(6)}  ${"WIN RATE".padStart(9)}  ${"needed".padStart(7)}  ${"random win".padStart(12)}  ${"still open".padStart(10)}  ${"per trade".padStart(9)}  ${"random".padStart(10)}`);
  // Every trade is scored with ITS OWN reward: a win pays that trade's R, a loss
  // pays -1. Multiplying one win rate by an average reward is wrong here, because
  // the near targets win far more often than the far ones.
  const score = (rs, pick) => {
    const done = rs.filter((r) => pick(r) !== "open");
    if (!done.length) return null;
    const wins = done.filter((r) => pick(r) === "win");
    const exp = done.reduce((a, r) => a + (pick(r) === "win" ? r.R : -1), 0) / done.length;
    const avgWin = wins.length ? wins.reduce((a, r) => a + r.R, 0) / wins.length : 0;
    return { n: done.length, win: wins.length / done.length, avgWin, need: avgWin > 0 ? 1 / (1 + avgWin) : NaN, exp, R: done.reduce((a, r) => a + r.R, 0) / done.length };
  };
  const show = (label, V) => {
    const s = score(V, (r) => r.res), t = score(V, (r) => r.tRes);
    if (!s || s.n < 30) return;
    console.log(`  ${label.padEnd(20)} ${String(s.n).padStart(6)}  ${s.R.toFixed(2).padStart(5)}R  ${pct(s.win).padStart(9)}  ${pct(s.need).padStart(7)}  ${pct(t ? t.win : 0).padStart(12)}  ${String(V.length - s.n).padStart(10)}  ${sg(s.exp).padStart(8)}R  ${sg(t ? t.exp : 0).padStart(9)}R`);
  };
  for (const name of [...FIXED.map((R) => `${R}R`), "nearest high/low"]) show(name, T.filter((r) => r.name === name));
  show("STRONG only, nearest", T.filter((r) => r.name === "nearest high/low" && r.strength === "STRONG"));
}
report("1D", "DAILY candles, 16 markets, every double-sweep candle, held until stop or target");
report("240", "4H candles, 16 markets, same rule");

if (verify && examples.length) {
  console.log(`\n${"=".repeat(112)}\nLast 12 ${verify} daily trades (nearest high/low target) — check these on your own chart`);
  console.log(`  ${"date".padEnd(12)} ${"side".padEnd(6)} ${"entry".padStart(10)} ${"stop".padStart(10)} ${"target".padStart(10)} ${"reward".padStart(7)} ${"result".padStart(7)} ${"candles".padStart(8)}`);
  for (const e of examples.slice(-12)) {
    console.log(`  ${e.date.padEnd(12)} ${e.dir.padEnd(6)} ${e.entry.toFixed(2).padStart(10)} ${e.stop.toFixed(2).padStart(10)} ${e.tp.toFixed(2).padStart(10)} ${(e.R.toFixed(2) + "R").padStart(7)} ${e.out.padStart(7)} ${String(e.days).padStart(8)}`);
  }
  const w = examples.filter((e) => e.out === "win").length;
  console.log(`  ${verify} daily, all ${examples.length} trades: ${w} wins, ${examples.length - w} losses (${pct(w / examples.length)})`);
}
console.log(`\n"needed" = the win rate that breaks even, using what the WINNERS actually paid: 100 / (1 + average winner).`);
console.log(`"per trade" = each trade scored with its own reward (a win pays its R, a loss pays -1), before costs.`);
console.log(`"random" = the same trade taken at a random moment in the same market and weather, same stop and same target.`);
