// Binance monthly 1m CSVs -> the same monthly JSON shape as the Dukascopy files.
// Keeps 05:00 to 17:00 UTC only. Handles both millisecond and microsecond
// timestamps (Binance switched units in 2025) and the header row newer files carry.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";

const SRC = process.env.SRC_DIR || "data/btccsv", OUT = process.env.DATA_DIR || "data/m1";
mkdirSync(OUT, { recursive: true });
let files = readdirSync(SRC).filter((f) => f.endsWith(".csv")).sort();
let written = 0;

for (const f of files) {
  const tag = f.match(/(\d{4}-\d{2})\.csv$/)?.[1];
  if (!tag) continue;
  const out = `${OUT}/BTCUSD-${tag}.json`;
  if (existsSync(out)) continue;
  const day = {};
  for (const lineRaw of readFileSync(`${SRC}/${f}`, "utf8").split("\n")) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("open_time")) continue;
    const p = line.split(",");
    let t = Number(p[0]);
    if (!Number.isFinite(t)) continue;
    t = t > 1e14 ? Math.floor(t / 1e6) : Math.floor(t / 1e3);
    const h = Math.floor((t % 86400) / 3600);
    if (h < 5 || h >= 17) continue;
    const d = new Date(t * 1000).toISOString().slice(0, 10);
    (day[d] ||= []).push([t, +p[1], +p[2], +p[3], +p[4]]);
  }
  for (const d of Object.keys(day)) day[d].sort((a, b) => a[0] - b[0]);
  writeFileSync(out, JSON.stringify(day));
  written++;
}
console.log(`BTC converted: ${written} months written, ${readdirSync(OUT).filter((f) => f.startsWith("BTCUSD-")).length} on disk`);
