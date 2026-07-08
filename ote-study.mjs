// ─────────────────────────────────────────────────────────────────────────
// OTE / STRUCTURE BACKTEST — does "swing-low sweep → displacement → retrace
// to the 0.618 zone → long" have an edge on REAL markets, or is it just the
// retracement math of a random walk (RNG control)?
//
// Definitions (one reasonable, precise interpretation — the whole point is to
// pin them down so we're not curve-fitting):
//   • swing low   = fractal: low[i] is the lowest of low[i-3 .. i+3]
//   • SOL (sweep) = a later candle dips BELOW that swing low then CLOSES back
//                   above it (liquidity grab + rejection). sweepLow = its low.
//   • displacement= after the sweep, price rallies so leg (H − sweepLow) ≥ 2×
//                   the instrument's median candle range (a real move, not noise)
//   • entry       = price retraces to the 0.618 level of (H → sweepLow). Long.
//   • stop        = the sweepLow (the low that was grabbed);  target = H (leg high)
//     → risk 0.382·leg, reward 0.618·leg  ⇒  1.62:1,  break-even win rate 38%.
//
// NO look-ahead: H is the leg high from candles BEFORE the entry candle; the
// win/loss is measured only from AFTER entry. Bullish setups only (mirror image
// holds for shorts; one side is enough to judge the edge).
// ─────────────────────────────────────────────────────────────────────────
import { fetch4H } from "./source.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
// Broad REAL set to grow the sample (all Deriv frx, offset 1 = OANDA grid) +
// Nasdaq via IG. SYNTH = RNG control.
const REALI = [
  { key: "Gold", sym: "frxXAUUSD", dataSrc: "deriv", offset: 1 },
  { key: "Silver", sym: "frxXAGUSD", dataSrc: "deriv", offset: 1 },
  { key: "EURUSD", sym: "frxEURUSD", dataSrc: "deriv", offset: 1 },
  { key: "GBPUSD", sym: "frxGBPUSD", dataSrc: "deriv", offset: 1 },
  { key: "USDJPY", sym: "frxUSDJPY", dataSrc: "deriv", offset: 1 },
  { key: "GBPJPY", sym: "frxGBPJPY", dataSrc: "deriv", offset: 1 },
  { key: "EURJPY", sym: "frxEURJPY", dataSrc: "deriv", offset: 1 },
  { key: "AUDUSD", sym: "frxAUDUSD", dataSrc: "deriv", offset: 1 },
  { key: "USDCAD", sym: "frxUSDCAD", dataSrc: "deriv", offset: 1 },
  { key: "EURGBP", sym: "frxEURGBP", dataSrc: "deriv", offset: 1 },
  { key: "Nasdaq", sym: "OTC_NDX", tvSym: "IG:NASDAQ", dataSrc: "tv", offset: 0 },
];
const SYNTHI = [
  { key: "V25", sym: "R_25", dataSrc: "deriv", offset: 0 },
  { key: "V50", sym: "R_50", dataSrc: "deriv", offset: 0 },
  { key: "V75", sym: "R_75", dataSrc: "deriv", offset: 0 },
  { key: "V100", sym: "R_100", dataSrc: "deriv", offset: 0 },
  { key: "V25S", sym: "1HZ25V", dataSrc: "deriv", offset: 0 },
  { key: "V75S", sym: "1HZ75V", dataSrc: "deriv", offset: 0 },
];
const K = 3, SWEEP_WIN = 20, ENTRY_WIN = 24, OUT_WIN = 24;
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 1; };

// scan pre-fetched candles with a given (fib, dispMult) — no network, so the
// robustness sweep is cheap.
function scan(c, scale, FIB, DISP_MULT) {
  const minDisp = DISP_MULT * scale;
  let wins = 0, losses = 0, setups = 0;

  for (let i = K; i < c.length - K - 2; i++) {
    // fractal swing low
    let isLow = true;
    for (let d = 1; d <= K; d++) if (c[i - d].low <= c[i].low || c[i + d].low <= c[i].low) { isLow = false; break; }
    if (!isLow) continue;
    const Lswing = c[i].low;

    // first sweep after the fractal is confirmed (i+K)
    let j = -1;
    for (let m = i + K + 1; m <= Math.min(i + K + SWEEP_WIN, c.length - 1); m++) {
      if (c[m].low < Lswing && c[m].close > Lswing) { j = m; break; }
      if (c[m].close < Lswing) break; // broke and stayed below — not a sweep, structure gone
    }
    if (j < 0) continue;
    const sweepLow = c[j].low;

    // displacement + retrace entry (H = leg high from candles strictly before the entry candle)
    let H = c[j].high, entryIdx = -1, Hentry = 0;
    for (let m = j + 1; m <= Math.min(j + ENTRY_WIN, c.length - 1); m++) {
      if (H - sweepLow >= minDisp) {
        const entryLevel = H - FIB * (H - sweepLow);
        if (c[m].low <= sweepLow) break;            // invalidated: broke the swept low first
        if (c[m].low <= entryLevel) { entryIdx = m; Hentry = H; break; } // retraced into OTE → enter
      }
      H = Math.max(H, c[m].high);
    }
    if (entryIdx < 0) continue;
    setups++;

    // outcome from AFTER the entry candle
    const stop = sweepLow, target = Hentry;
    for (let m = entryIdx + 1; m <= Math.min(entryIdx + OUT_WIN, c.length - 1); m++) {
      if (c[m].low <= stop) { losses++; break; }
      if (c[m].high >= target) { wins++; break; }
    }
  }
  return { wins, losses, setups };
}

// fetch once, cache candles+scale per instrument
async function load(inst) {
  const c = await fetch4H(inst, 600, inst.offset ?? cfg.bucketOffsetHours);
  const scale = median(c.map((x) => x.high - x.low)) || 1;
  return { c, scale };
}

function line(label, r) {
  const decided = r.wins + r.losses;
  const win = pct(r.wins, decided);
  const expR = decided ? (r.wins * 1.62 - r.losses) / decided : 0;   // win=+1.62R, loss=-1R
  return `  ${label.padEnd(9)} setups ${String(r.setups).padStart(3)}   win ${String(win).padStart(3)}%   exp ${(expR >= 0 ? "+" : "") + expR.toFixed(2)}R   (break-even 38%)`;
}

const FIBS = [0.5, 0.618, 0.705, 0.786];
const DISPS = [1.5, 2, 2.5];

const run = async () => {
  // load candles once
  const data = {};
  for (const inst of [...REALI, ...SYNTHI]) {
    try { data[inst.key] = await load(inst); }
    catch (e) { console.log(`${inst.key}: ${e.message}`); data[inst.key] = { c: [], scale: 1 }; }
  }
  const agg = (list, fib, disp) => list.reduce((a, i) => {
    const r = scan(data[i.key].c, data[i.key].scale, fib, disp);
    return { wins: a.wins + r.wins, losses: a.losses + r.losses, setups: a.setups + r.setups };
  }, { wins: 0, losses: 0, setups: 0 });

  // ── baseline detailed run at the reference params (0.618, 2×) ──
  console.log("OTE backtest — sweep swing-low → displace → retrace to fib → target leg high (long)\n");
  console.log("Reference params: fib 0.618, displacement 2× median range:\n");
  for (const i of REALI) console.log(line(i.key, scan(data[i.key].c, data[i.key].scale, 0.618, 2)));
  console.log(line("→ REAL", agg(REALI, 0.618, 2)));
  console.log(line("→ SYNTH(RNG)", agg(SYNTHI, 0.618, 2)));

  // ── robustness sweep: does the real-vs-random gap survive param changes? ──
  console.log("\nROBUSTNESS SWEEP — REAL win% / RNG win% (n) per (fib × displacement). Break-even 38%.");
  console.log("If REAL stays > RNG across the grid, the edge is robust; if it flips around, it's noise.\n");
  const bcell = (fib, disp) => {
    const R = agg(REALI, fib, disp), S = agg(SYNTHI, fib, disp);
    const rw = pct(R.wins, R.wins + R.losses), sw = pct(S.wins, S.wins + S.losses);
    const gap = rw - sw;
    return `${String(rw).padStart(3)}/${String(sw).padStart(3)}% ${(gap >= 0 ? "+" : "") + gap}pp (nR${R.wins + R.losses})`.padEnd(24);
  };
  console.log("           " + DISPS.map((d) => ("disp " + d + "×").padEnd(24)).join(""));
  for (const fib of FIBS) {
    console.log(`fib ${fib.toFixed(3)}  ` + DISPS.map((d) => bcell(fib, d)).join(""));
  }
  console.log("\nRead: consistently positive 'pp' (REAL minus RNG) across the grid = a real structural");
  console.log("edge that isn't an artifact of one lucky parameter. Mixed signs = likely noise / small-n.");
};
run().catch((e) => { console.error(e); process.exit(1); });
