// ─────────────────────────────────────────────────────────────────────────
// SWEEP TIMING STUDY — for 4H candles that swept BOTH sides of the prior
// candle: WHEN does sweep 1 happen, WHEN does sweep 2 happen, and what is
// the gap between them? Measured on 15m bars (resolution ±15 min), on each
// instrument's verified grid (reals +1h, synthetics UTC). ~52 days of 15m.
// ─────────────────────────────────────────────────────────────────────────
import { fetchCandles } from "./deriv.mjs";

const G4 = 14400, M15 = 900;
const REALI = [
  { key: "Gold", sym: "frxXAUUSD", off: 3600 },
  { key: "EURUSD", sym: "frxEURUSD", off: 3600 },
  { key: "GBPUSD", sym: "frxGBPUSD", off: 3600 },
  { key: "USDJPY", sym: "frxUSDJPY", off: 3600 },
  { key: "GBPJPY", sym: "frxGBPJPY", off: 3600 },
  { key: "AUDUSD", sym: "frxAUDUSD", off: 3600 },
];
const SYNTHI = [
  { key: "V25", sym: "R_25", off: 0 },
  { key: "V25S", sym: "1HZ25V", off: 0 },
  { key: "V50", sym: "R_50", off: 0 },
  { key: "V75", sym: "R_75", off: 0 },
  { key: "V100", sym: "R_100", off: 0 },
  { key: "V100S", sym: "1HZ100V", off: 0 },
];
const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);

async function collect(inst) {
  const c15 = await fetchCandles(inst.sym, 5000, M15);
  const buckets = new Map();
  for (const b of c15) {
    const bs = Math.floor((b.t - inst.off) / G4) * G4 + inst.off;
    if (!buckets.has(bs)) buckets.set(bs, []);
    buckets.get(bs).push(b);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b).filter((k) => buckets.get(k).length === 16);
  const agg = (bars) => ({ high: Math.max(...bars.map((x) => x.high)), low: Math.min(...bars.map((x) => x.low)) });
  const out = { total: 0, both: 0, t1: [], t2: [], gap: [], gapBySweep1Hour: [[], [], [], []] };
  for (let k = 1; k < keys.length; k++) {
    const prev = agg(buckets.get(keys[k - 1]));
    const bars = buckets.get(keys[k]);
    out.total++;
    let tH = null, tL = null;
    for (const b of bars) {
      if (tH === null && b.high > prev.high) tH = b.t;
      if (tL === null && b.low < prev.low) tL = b.t;
    }
    if (tH === null || tL === null) continue;
    out.both++;
    const t1 = Math.min(tH, tL), t2 = Math.max(tH, tL);
    const m1 = (t1 - keys[k]) / 60, m2 = (t2 - keys[k]) / 60, g = (t2 - t1) / 60;
    out.t1.push(m1); out.t2.push(m2); out.gap.push(g);
    out.gapBySweep1Hour[Math.min(3, Math.floor(m1 / 60))].push(g);
  }
  return out;
}

const run = async () => {
  for (const [label, insts] of [["REAL (6 FX/metals)", REALI], ["SYNTH / RNG (6 V-pairs)", SYNTHI]]) {
    const P = { total: 0, both: 0, t1: [], t2: [], gap: [], gapBySweep1Hour: [[], [], [], []] };
    for (const inst of insts) {
      try {
        const r = await collect(inst);
        P.total += r.total; P.both += r.both;
        P.t1 = P.t1.concat(r.t1); P.t2 = P.t2.concat(r.t2); P.gap = P.gap.concat(r.gap);
        for (let h = 0; h < 4; h++) P.gapBySweep1Hour[h] = P.gapBySweep1Hour[h].concat(r.gapBySweep1Hour[h]);
      } catch (e) { console.log(`${inst.key}: ${e.message}`); }
    }
    const f = (x) => isNaN(x) ? "—" : Math.round(x) + "m";
    console.log(`\n═══ ${label} — ${P.both} both-side candles out of ${P.total} (${pct(P.both, P.total)}%) ═══`);
    console.log(`sweep 1 lands:   25% by ${f(q(P.t1, .25))} · median ${f(q(P.t1, .5))} · 75% by ${f(q(P.t1, .75))} into the candle`);
    console.log(`sweep 2 lands:   25% by ${f(q(P.t2, .25))} · median ${f(q(P.t2, .5))} · 75% by ${f(q(P.t2, .75))} into the candle`);
    console.log(`GAP sweep1→2:    25% ≤ ${f(q(P.gap, .25))} · median ${f(q(P.gap, .5))} · 75% ≤ ${f(q(P.gap, .75))} · 90% ≤ ${f(q(P.gap, .9))}`);
    const buckets = [[0, 30], [30, 60], [60, 120], [120, 180], [180, 241]];
    console.log(`gap distribution: ` + buckets.map(([a, b]) => `${a}-${b === 241 ? "240" : b}m: ${pct(P.gap.filter((g) => g >= a && g < b).length, P.gap.length)}%`).join("  "));
    console.log(`gap by WHEN sweep1 landed:`);
    for (let h = 0; h < 4; h++) {
      const a = P.gapBySweep1Hour[h];
      console.log(`  sweep1 in hour ${h + 1}: n=${String(a.length).padStart(3)} · median gap ${f(q(a, .5))} · 75% ≤ ${f(q(a, .75))}`);
    }
  }
  console.log(`\nResolution note: times are 15m-bar opens, so every number is ±15 minutes.`);
};
run().catch((e) => { console.error(e); process.exit(1); });
