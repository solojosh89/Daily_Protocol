// ─────────────────────────────────────────────────────────────────────────
// HOURLY VOLATILITY STUDY — "V-pairs move aggressively at a certain time
// (some say ~midnight Nigeria)". Nigeria = WAT = UTC+1, so midnight NGN = 23:00 UTC.
//
// Synthetics are RNG with CONSTANT volatility by construction → the null
// hypothesis is a FLAT hourly profile (no time matters). Real pairs are the
// control that SHOULD show London/NY peaks — if the method finds those, it's
// trustworthy, and a flat synthetic profile is then a real verdict, not a miss.
//
// Method: 1H candles (~200+ days), bucket by UTC hour, median range per hour,
// shown as % of that instrument's all-hours median. >100% = livelier hour.
// ─────────────────────────────────────────────────────────────────────────
import { fetchCandles } from "./deriv.mjs";

const REALI = [
  { key: "Gold", sym: "frxXAUUSD" }, { key: "EURUSD", sym: "frxEURUSD" },
  { key: "GBPUSD", sym: "frxGBPUSD" }, { key: "GBPJPY", sym: "frxGBPJPY" },
];
const SYNTHI = [
  { key: "V25", sym: "R_25" }, { key: "V25S", sym: "1HZ25V" },
  { key: "V75", sym: "R_75" }, { key: "V100", sym: "R_100" }, { key: "V100S", sym: "1HZ100V" },
];
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function hourly(sym) {
  const c = await fetchCandles(sym, 5000, 3600); // ~208 days of 1H
  const byHour = Array.from({ length: 24 }, () => []);
  for (const b of c) byHour[new Date(b.t * 1000).getUTCHours()].push(b.high - b.low);
  const medHour = byHour.map(median);
  const overall = median(c.map((b) => b.high - b.low));
  return { medHour, overall, n: c.length };
}

// NGN (UTC+1) label for a UTC hour
const ngn = (utc) => String((utc + 1) % 24).padStart(2, "0") + ":00";

const run = async () => {
  for (const [label, insts] of [["SYNTH / RNG (should be FLAT)", SYNTHI], ["REAL (control — should peak London/NY)", REALI]]) {
    console.log(`\n═══ ${label} ═══`);
    // pool: average each instrument's hour-as-%-of-own-median, so pairs of very
    // different price scales combine fairly
    const pooled = Array.from({ length: 24 }, () => []);
    for (const inst of insts) {
      try {
        const h = await hourly(inst.sym);
        for (let u = 0; u < 24; u++) pooled[u].push(100 * h.medHour[u] / h.overall);
      } catch (e) { console.log(`${inst.key}: ${e.message}`); }
    }
    const prof = pooled.map((a) => a.reduce((x, y) => x + y, 0) / (a.length || 1));
    const max = Math.max(...prof), min = Math.min(...prof);
    for (let u = 0; u < 24; u++) {
      const v = prof[u];
      const bar = "█".repeat(Math.round(v / 5));
      const tag = u === 23 ? "  ← midnight NGN (23:00 UTC)" : (u >= 7 && u <= 15 ? "  (London/NY)" : "");
      console.log(`  ${String(u).padStart(2)}:00 UTC / ${ngn(u)} NGN  ${String(Math.round(v)).padStart(3)}%  ${bar}${tag}`);
    }
    console.log(`  spread: quietest ${Math.round(min)}%  →  liveliest ${Math.round(max)}%  (flat ≈ all near 100%)`);
  }
  console.log(`\nRead: synthetics near 100% every hour = constant vol, no "aggressive time" (RNG truth).`);
  console.log(`Reals peaking ~07–16 UTC (London/NY) = method works, so a flat synth line is a real verdict.`);
};
run().catch((e) => { console.error(e); process.exit(1); });
