// ─────────────────────────────────────────────────────────────────────────
// EXTREME-SOL STUDY — user's refinement: "look for the SOL at the LOWEST LOW
// / HIGHEST HIGH of the recent range, not at any minor swing."
//
// TEST 1 (primary): the validated OTE backtest, with each setup classified by
//   the DEPTH of the swept swing low:
//     DEEP    = the swing low was also the minimum of the prior 30 candles
//               (~5 days) — the extreme of the visible range
//     SHALLOW = just a 3-candle fractal, not a range extreme
//   If the user is right, DEEP setups should win more. RNG control included.
//
// TEST 2 (secondary): raw extreme-reclaim — a candle dips below the N=30
//   lowest low and closes back above it. Follow-through (next 3 candles, in
//   median-range units) vs the same for ANY low-sweep reclaim. Both sides
//   pooled (mirrored). Real vs RNG.
// ─────────────────────────────────────────────────────────────────────────
import { fetch4H } from "./source.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
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
  { key: "V25S", sym: "1HZ25V", dataSrc: "deriv", offset: 0 },
  { key: "V50", sym: "R_50", dataSrc: "deriv", offset: 0 },
  { key: "V75", sym: "R_75", dataSrc: "deriv", offset: 0 },
  { key: "V100", sym: "R_100", dataSrc: "deriv", offset: 0 },
  { key: "V75S", sym: "1HZ75V", dataSrc: "deriv", offset: 0 },
];
const K = 3, SWEEP_WIN = 20, ENTRY_WIN = 24, OUT_WIN = 24, EXT = 30;
const FIB = 0.618, DISP = 2.5; // strong-displacement params (the live detector's)
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ── TEST 1: OTE split by depth of the swept swing low ───────────────────────
function oteByDepth(c, scale) {
  const minDisp = DISP * scale;
  const out = { DEEP: { w: 0, l: 0 }, SHALLOW: { w: 0, l: 0 } };
  for (let i = Math.max(K, EXT); i < c.length - K - 2; i++) {
    let isLow = true;
    for (let d = 1; d <= K; d++) if (c[i - d].low <= c[i].low || c[i + d].low <= c[i].low) { isLow = false; break; }
    if (!isLow) continue;
    const Lswing = c[i].low;
    // depth: was this swing low ALSO the minimum of the prior EXT candles?
    let priorMin = Infinity;
    for (let m = i - EXT; m < i; m++) priorMin = Math.min(priorMin, c[m].low);
    const depth = Lswing <= priorMin ? "DEEP" : "SHALLOW";

    let j = -1;
    for (let m = i + K + 1; m <= Math.min(i + K + SWEEP_WIN, c.length - 1); m++) {
      if (c[m].low < Lswing && c[m].close > Lswing) { j = m; break; }
      if (c[m].close < Lswing) break;
    }
    if (j < 0) continue;
    const sweepLow = c[j].low;
    let H = c[j].high, entryIdx = -1, Hentry = 0;
    for (let m = j + 1; m <= Math.min(j + ENTRY_WIN, c.length - 1); m++) {
      if (H - sweepLow >= minDisp) {
        const lvl = H - FIB * (H - sweepLow);
        if (c[m].low <= sweepLow) break;
        if (c[m].low <= lvl) { entryIdx = m; Hentry = H; break; }
      }
      H = Math.max(H, c[m].high);
    }
    if (entryIdx < 0) continue;
    for (let m = entryIdx + 1; m <= Math.min(entryIdx + OUT_WIN, c.length - 1); m++) {
      if (c[m].low <= sweepLow) { out[depth].l++; break; }
      if (c[m].high >= Hentry) { out[depth].w++; break; }
    }
  }
  return out;
}

// ── TEST 2: raw extreme-reclaim follow-through (mirrored, both sides) ───────
function reclaim(c, scale) {
  const out = { EXTREME: [], ANY: [] };
  for (let i = EXT + 1; i < c.length - 3; i++) {
    const A = c[i - 1], B = c[i];
    const nxt = c.slice(i + 1, i + 4);
    // lows
    let priorMin = Infinity, priorMax = -Infinity;
    for (let m = i - EXT; m < i; m++) { priorMin = Math.min(priorMin, c[m].low); priorMax = Math.max(priorMax, c[m].high); }
    if (B.low < A.low && B.close > A.low) { // any low-sweep reclaim (vs prior candle)
      const move = (Math.max(...nxt.map((x) => x.high)) - B.close) / scale;
      out.ANY.push(move);
      if (B.low < priorMin && B.close > priorMin) out.EXTREME.push(move); // took the RANGE extreme and reclaimed
    }
    if (B.high > A.high && B.close < A.high) { // mirror
      const move = (B.close - Math.min(...nxt.map((x) => x.low))) / scale;
      out.ANY.push(move);
      if (B.high > priorMax && B.close < priorMax) out.EXTREME.push(move);
    }
  }
  return out;
}

const run = async () => {
  const data = {};
  for (const inst of [...REALI, ...SYNTHI]) {
    try {
      const c = await fetch4H(inst, 600, inst.offset ?? cfg.bucketOffsetHours);
      const scale = median(c.map((x) => x.high - x.low)) || 1;
      data[inst.key] = { c, scale };
    } catch (e) { console.log(`${inst.key}: ${e.message}`); data[inst.key] = { c: [], scale: 1 }; }
  }
  const pool1 = (list) => list.reduce((a, i) => {
    const r = oteByDepth(data[i.key].c, data[i.key].scale);
    for (const k of ["DEEP", "SHALLOW"]) { a[k].w += r[k].w; a[k].l += r[k].l; }
    return a;
  }, { DEEP: { w: 0, l: 0 }, SHALLOW: { w: 0, l: 0 } });
  const pool2 = (list) => list.reduce((a, i) => {
    const r = reclaim(data[i.key].c, data[i.key].scale);
    a.EXTREME = a.EXTREME.concat(r.EXTREME); a.ANY = a.ANY.concat(r.ANY);
    return a;
  }, { EXTREME: [], ANY: [] });

  console.log("TEST 1 — OTE (0.618, disp 2.5x) split by DEPTH of the swept low. Break-even 38%.\n");
  for (const [label, insts] of [["REAL", REALI], ["SYNTH (RNG)", SYNTHI]]) {
    const p = pool1(insts);
    const line = (k) => {
      const n = p[k].w + p[k].l;
      const exp = n ? (p[k].w * 1.62 - p[k].l) / n : 0;
      return `  ${k.padEnd(8)} win ${String(pct(p[k].w, n)).padStart(3)}%  exp ${(exp >= 0 ? "+" : "") + exp.toFixed(2)}R  (n=${n})`;
    };
    console.log(`${label}:\n${line("DEEP")}\n${line("SHALLOW")}\n`);
  }

  console.log("TEST 2 — reclaim follow-through, next 3 candles (median-range units):\n");
  for (const [label, insts] of [["REAL", REALI], ["SYNTH (RNG)", SYNTHI]]) {
    const p = pool2(insts);
    console.log(`${label}:`);
    console.log(`  RANGE-EXTREME sweep+reclaim: median ${median(p.EXTREME).toFixed(2)}x (n=${p.EXTREME.length})`);
    console.log(`  ANY sweep+reclaim:           median ${median(p.ANY).toFixed(2)}x (n=${p.ANY.length})\n`);
  }
};
run().catch((e) => { console.error(e); process.exit(1); });
