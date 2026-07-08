// ─────────────────────────────────────────────────────────────────────────
// FULL-RULE BACKTEST — runs the bot's exact logic across history, 4H + 15m.
//
// Per setup, exactly what the live bot does:
//   1. 4H: a double-sweep confirms bias (BULL/BEAR) at close  (detector.mjs)
//   2. 15m: AFTER the 4H closes (no look-ahead), find the SOL entry — a 15m
//      candle that takes the FORMER 4H candle's high (BEAR) / low (BULL) then
//      closes back the other way, within the next 8h  (ltf.mjs logic)
//   3. Trade: ENTER at that SOL candle's close
//             STOP  at the SOL candle's swept extreme (structure stop)
//             TARGET at 2R (reward:risk 2:1)
//      then walk 15m forward until target or stop is hit.
//
// Real markets AND synthetics are both run — synthetics are the CONTROL: RNG
// random walks with no real liquidity. If the rule scores the same on them as
// on real markets, it's volatility, not edge. Break-even at 2:1 is 33.3% wins.
//
// Honest limit: 15m history is feed-capped (~50-90 days), so trade counts are
// modest. Read this as a first rule-based read, not a multi-year verdict.
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS, sessionOf, fmtTime } from "./deriv.mjs";
import { fetch4H, fetch15m } from "./source.mjs";
import { detectSweep } from "./detector.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const G4 = 14400, G15 = 900, BUFFER = 3600;
const FWD = 48;        // forward 15m bars to resolve a trade (~12h)
const RR = 2;          // reward:risk

const REAL = ["XAUUSD", "NAS100", "GBPJPY"];
const SYNTH = ["V25", "V25S", "V50", "V50S", "V75", "V75S", "V100", "V100S"];
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);

async function tradesFor(inst) {
  const c4 = await fetch4H(inst, 600, cfg.bucketOffsetHours);
  const c15 = await fetch15m(inst, 20000);
  const start15 = c15[0].t;
  const trades = [];

  for (let i = 1; i < c4.length - 1; i++) {
    const s = detectSweep(c4[i - 1], c4[i]);
    if (!s) continue;
    const cur = c4[i], prev = c4[i - 1];
    if (cur.t - BUFFER < start15) continue;

    // find the 15m SOL entry — ONLY after the 4H closes (no look-ahead: you don't
    // know the double-sweep is valid until the 4H candle actually confirms it).
    const scanStart = cur.t + G4, scanEnd = cur.t + G4 + 8 * 3600;
    const liquidity = s.dir === "BEAR" ? prev.high : prev.low;
    let solIdx = -1;
    for (let k = 0; k < c15.length; k++) {
      const b = c15[k];
      if (b.t < scanStart || b.t >= scanEnd) continue;
      const hit = s.dir === "BEAR" ? (b.high > liquidity && b.close < b.open) : (b.low < liquidity && b.close > b.open);
      if (hit) { solIdx = k; break; }
    }
    if (solIdx === -1) continue; // no entry per the rules → no trade

    const sol = c15[solIdx];
    const entry = sol.close;
    const stop = s.dir === "BEAR" ? sol.high : sol.low;
    const R = Math.abs(stop - entry);
    if (R <= 0) continue;
    const target = s.dir === "BEAR" ? entry - RR * R : entry + RR * R;

    let outcome = null; // 1 win, 0 loss, null unresolved
    for (let k = solIdx + 1; k <= Math.min(solIdx + FWD, c15.length - 1); k++) {
      const b = c15[k];
      if (s.dir === "BEAR") {
        if (b.high >= stop) { outcome = 0; break; }
        if (b.low <= target) { outcome = 1; break; }
      } else {
        if (b.low <= stop) { outcome = 0; break; }
        if (b.high >= target) { outcome = 1; break; }
      }
    }
    if (outcome === null) continue;
    trades.push({ inst: inst.key, dir: s.dir, strength: s.strength, session: sessionOf(cur.t),
      h4: fmtTime(cur.t, cfg.displayTzOffset, cfg.displayTzLabel).replace(/^\d{4}-\d{2}-\d{2}\s/, ""), outcome });
  }
  return trades;
}

function line(label, t) {
  const w = t.filter((x) => x.outcome === 1).length, n = t.length;
  const expR = n ? (w * RR - (n - w)) / n : 0;
  return `  ${label.padEnd(9)} ${String(n).padStart(3)} trades   win ${String(pct(w, n)).padStart(3)}%   exp ${(expR >= 0 ? "+" : "") + expR.toFixed(2)}R`;
}

const run = async () => {
  const byInst = {};
  for (const inst of INSTRUMENTS.filter((i) => [...REAL, ...SYNTH].includes(i.key))) {
    try { byInst[inst.key] = await tradesFor(inst); } catch (e) { console.log(`${inst.key}: ${e.message}`); byInst[inst.key] = []; }
  }
  const realT = REAL.flatMap((k) => byInst[k] || []);
  const synT = SYNTH.flatMap((k) => byInst[k] || []);

  console.log(`Bot rules backtested — enter at 15m SOL, stop at SOL extreme, target ${RR}R. Break-even win rate: ${Math.round(100 / (1 + RR))}%.\n`);
  console.log("REAL MARKETS (the ones the manipulation model is meant for):");
  for (const k of REAL) console.log(line(byInst[k]?.[0]?.inst || k, byInst[k] || []));
  console.log(line("→ REAL", realT));
  console.log("\nSYNTHETICS (RNG control — should be a coin flip if the model needs real liquidity):");
  for (const k of SYNTH) console.log(line(k, byInst[k] || []));
  console.log(line("→ SYNTH", synT));

  console.log("\nREAL breakdown by strength / session / H4 candle:");
  for (const g of ["STRONG", "NORMAL"]) console.log(line(g, realT.filter((t) => t.strength === g)));
  for (const s of [...new Set(realT.map((t) => t.session))]) console.log(line(s.slice(0, 9), realT.filter((t) => t.session === s)));
  for (const h of [...new Set(realT.map((t) => t.h4))].sort()) console.log(line(h, realT.filter((t) => t.h4 === h)));

  const rw = pct(realT.filter((t) => t.outcome === 1).length, realT.length);
  const sw = pct(synT.filter((t) => t.outcome === 1).length, synT.length);
  console.log(`\nVERDICT: real win ${rw}% vs synthetic win ${sw}% (break-even ${Math.round(100 / (1 + RR))}%).`);
  console.log(`If real ≈ synthetic and both near break-even, the rule has no demonstrated edge yet — it's`);
  console.log(`measuring volatility. Trade counts are small (feed-capped history); this is a first read.`);
};
run().catch((e) => { console.error(e); process.exit(1); });
