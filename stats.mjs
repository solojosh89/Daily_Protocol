// ─────────────────────────────────────────────────────────────────────────
// STATS — query the accumulated event log (events.jsonl)
//
// The payoff of logging every event: after weeks of running, ask
//   • which SESSION produces the most sweeps / the highest protocol-valid rate
//   • which H4 CANDLE (time of day) is worth your attention
// Reads events.jsonl and tallies. Starts empty; grows as the monitor runs.
//   node stats.mjs
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const LOG = join(dirname(fileURLToPath(import.meta.url)), "events.jsonl");
if (!existsSync(LOG)) { console.log("No events yet — run the monitor for a while, then check back."); process.exit(0); }

const events = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (!events.length) { console.log("Event log is empty."); process.exit(0); }

const h4Time = (e) => (e.h4Open ? e.h4Open.replace(/^\d{4}-\d{2}-\d{2}\s/, "") : "?"); // "HH:MM NY"
const firstSweeps = events.filter((e) => e.event === "first_sweep");
const closes = events.filter((e) => e.event === "confirmed" || e.event === "fizzled");

function tally(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function validRate(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); const e = m.get(k) || { v: 0, n: 0 }; e.n++; if (r.event === "confirmed") e.v++; m.set(k, e); }
  return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
}

console.log(`Event log: ${events.length} events  (${firstSweeps.length} first-sweeps, ${closes.length} H4 closes)\n`);

console.log("First sweeps by session:");
for (const [k, n] of tally(firstSweeps, (e) => e.session)) console.log(`   ${String(k).padEnd(20)} ${n}`);

console.log("\nFirst sweeps by H4 candle (time of day):");
for (const [k, n] of tally(firstSweeps, h4Time)) console.log(`   ${String(k).padEnd(12)} ${n}`);

if (closes.length) {
  console.log("\nProtocol-VALID rate by session (confirmed vs fizzled at close):");
  for (const [k, e] of validRate(closes, (e) => e.session)) console.log(`   ${String(k).padEnd(20)} ${Math.round(100 * e.v / e.n)}%  (${e.v}/${e.n})`);
  console.log("\nProtocol-VALID rate by H4 candle:");
  for (const [k, e] of validRate(closes, h4Time)) console.log(`   ${String(k).padEnd(12)} ${Math.round(100 * e.v / e.n)}%  (${e.v}/${e.n})`);
} else {
  console.log("\n(No H4 closes logged yet — protocol-valid rates appear once double-sweeps complete.)");
}

console.log("\nThe more the monitor runs, the more these mean. This is your research database.");
