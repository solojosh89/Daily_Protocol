// ─────────────────────────────────────────────────────────────────────────
// NEAR-MISS / DISPLACEMENT STUDY — the user's chart observation:
// candles that sweep ONE side of A, come close to (or don't touch) the other,
// yet move hugely afterward. Is that a real edge on real markets, or just
// volatility (which is all it can be on the RNG synthetics)?
//
// Three candle types compared, each measured by the MOVE that follows —
// max favourable excursion in the reversal/close direction over the next 3
// candles, in units of A's range:
//   FULL     = swept both sides of A, closed reversal (the current detector)
//   NEARMISS = swept ONE side, reached >=70% toward the other (didn't touch),
//              closed in the reversal direction
//   ONESIDE  = swept one side, closed CONTINUATION (momentum, e.g. the rally)
//   (baseline = every candle, for reference)
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS } from "./deriv.mjs";
import { fetch4H } from "./source.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const REAL = ["XAUUSD", "NAS100", "GBPJPY"];
const SYNTH = ["V25", "V50", "V75", "V100"];
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function classify(inst) {
  const c = await fetch4H(inst, 600, inst.offset ?? cfg.bucketOffsetHours);
  const out = { FULL: [], NEARMISS: [], ONESIDE: [], BASE: [] };
  for (let i = 1; i < c.length - 3; i++) {
    const A = c[i - 1], B = c[i];
    const range = A.high - A.low; if (range <= 0) continue;
    const nxt = c.slice(i + 1, i + 4);
    const bull = B.close > B.open;
    // move in the close/reversal direction, in A-range units
    const move = bull ? (Math.max(...nxt.map((x) => x.high)) - B.close) / range
                      : (B.close - Math.min(...nxt.map((x) => x.low))) / range;
    out.BASE.push(move);

    const sH = B.high > A.high, sL = B.low < A.low;
    if (sH && sL) { out.FULL.push(move); continue; }
    if (!sH && !sL) continue;
    if (sL && !sH) {                       // swept low; how far toward the high?
      const towardHigh = 100 * (B.high - A.low) / range;
      if (bull && towardHigh >= 70) out.NEARMISS.push(move);      // reached >=70% up, closed up
      if (!bull) out.ONESIDE.push(move);                          // closed down = continuation of the low sweep
    } else if (sH && !sL) {                // swept high; how far toward the low?
      const towardLow = 100 * (A.high - B.low) / range;
      if (!bull && towardLow >= 70) out.NEARMISS.push(move);      // reached >=70% down, closed down
      if (bull) out.ONESIDE.push(move);                           // closed up = continuation of the high sweep
    }
  }
  return out;
}

function report(label, groups) {
  console.log(`\n${label}:`);
  for (const k of ["FULL", "NEARMISS", "ONESIDE", "BASE"]) {
    const a = groups[k];
    console.log(`   ${k.padEnd(9)} n=${String(a.length).padStart(4)}   median follow-move ${isNaN(median(a)) ? "—" : median(a).toFixed(2)}x A-range`);
  }
}

const run = async () => {
  const merge = (keys) => keys.map((k) => byI[k]).reduce((acc, g) => { for (const t of Object.keys(acc)) acc[t] = acc[t].concat(g[t]); return acc; }, { FULL: [], NEARMISS: [], ONESIDE: [], BASE: [] });
  const byI = {};
  for (const inst of INSTRUMENTS.filter((i) => [...REAL, ...SYNTH].includes(i.key))) {
    try { byI[inst.key] = await classify(inst); } catch (e) { console.log(`${inst.key}: ${e.message}`); byI[inst.key] = { FULL: [], NEARMISS: [], ONESIDE: [], BASE: [] }; }
  }
  console.log("Median move (in A-range units) that FOLLOWS each candle type:");
  report("REAL (Gold+Nasdaq+GBPJPY)", merge(REAL));
  report("SYNTHETIC (RNG control)", merge(SYNTH));
  console.log(`\nRead: if NEARMISS/ONESIDE ≈ FULL ≈ BASE, the setup doesn't pick bigger moves than a coin flip.`);
  console.log(`If REAL ≈ SYNTHETIC too, it's volatility, not liquidity/structure.`);
};
run().catch((e) => { console.error(e); process.exit(1); });
