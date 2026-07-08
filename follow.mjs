// ─────────────────────────────────────────────────────────────────────────
// SIMPLE FOLLOW-THROUGH — after a manipulation candle closes, do the NEXT
// 4H candles go the same way?
//
// For every 4H double-sweep (manipulation) candle B with a bias (BEAR/BULL):
//   • Next candle continued?  did the NEXT 4H candle CLOSE further in the bias
//     direction than B closed (BEAR = closed lower, BULL = closed higher)?
//   • Next candle same colour?  was the next candle itself bearish/bullish?
//   • And the same over the next 2 and 3 candles.
//
// 50% = coin flip (no follow-through). Synthetics (RNG) are the control — they
// SHOULD sit at 50%. If real markets beat that consistently, the bias means
// something; if they're also ~50%, the manipulation close doesn't predict the
// next candle.
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS } from "./deriv.mjs";
import { fetch4H } from "./source.mjs";
import { detectSweep } from "./detector.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const REAL = ["XAUUSD", "NAS100", "GBPJPY"];
const SYNTH = ["V25", "V25S", "V50", "V50S", "V75", "V75S", "V100", "V100S"];
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);

async function rowsFor(inst) {
  const c = await fetch4H(inst, 600, cfg.bucketOffsetHours);
  const out = [];
  for (let i = 1; i < c.length - 4; i++) {
    const s = detectSweep(c[i - 1], c[i]);
    if (!s) continue;
    const B = c[i], down = s.dir === "BEAR";
    // did price continue in the bias direction by the close of candle i+k?
    const cont = (k) => (down ? c[i + k].close < B.close : c[i + k].close > B.close);
    // was candle i+1 itself the same colour as the bias?
    const sameColour = down ? c[i + 1].close < c[i + 1].open : c[i + 1].close > c[i + 1].open;
    out.push({ strength: s.strength, cont1: cont(1), cont2: cont(2), cont3: cont(3), sameColour });
  }
  return out;
}

function line(label, r) {
  const n = r.length;
  return `  ${label.padEnd(9)} n=${String(n).padStart(3)}   next candle same dir ${String(pct(r.filter(x => x.cont1).length, n)).padStart(3)}%   same colour ${String(pct(r.filter(x => x.sameColour).length, n)).padStart(3)}%   still going after 2c ${pct(r.filter(x => x.cont2).length, n)}%   after 3c ${pct(r.filter(x => x.cont3).length, n)}%`;
}

const run = async () => {
  const by = {};
  for (const inst of INSTRUMENTS.filter(i => [...REAL, ...SYNTH].includes(i.key))) {
    try { by[inst.key] = await rowsFor(inst); } catch (e) { console.log(`${inst.key}: ${e.message}`); by[inst.key] = []; }
  }
  console.log("After a manipulation candle CLOSES, does price keep going that way?  (50% = coin flip)\n");
  console.log("REAL MARKETS:");
  for (const k of REAL) console.log(line(k, by[k] || []));
  const realAll = REAL.flatMap(k => by[k] || []);
  console.log(line("→ REAL", realAll));

  console.log("\nSYNTHETICS (RNG control — should be ~50%):");
  const synAll = SYNTH.flatMap(k => by[k] || []);
  for (const k of SYNTH) console.log(line(k, by[k] || []));
  console.log(line("→ SYNTH", synAll));

  console.log("\nREAL, strong setups only (full-body engulf, bigger than prior):");
  console.log(line("STRONG", realAll.filter(x => x.strength === "STRONG")));

  console.log(`\nPlain readout: "next candle same dir" = of all manipulation closes, how often the very`);
  console.log(`next 4H candle closed further in the bias direction. Real ${pct(realAll.filter(x=>x.cont1).length, realAll.length)}% vs coin-flip 50% vs RNG ${pct(synAll.filter(x=>x.cont1).length, synAll.length)}%.`);
};
run().catch((e) => { console.error(e); process.exit(1); });
