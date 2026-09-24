// ─────────────────────────────────────────────────────────────────────────
// HOURLY BARS FROM DUKASCOPY, BACK TO 2015
//
// Hourly rather than 4H on purpose: the 4H grid is a choice, not a fact. Some
// brokers open 4H candles at 00/04/08 UTC, others an hour later. Building the
// 4H candles ourselves means the same test can be re-run on a shifted grid to
// prove the result does not depend on whose chart you happen to use.
//
// One file per instrument, resumable, ONE process at a time (two trips the
// rate limit, which returns the literal text "Rate limited").
//   node duka-h1.mjs
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128 Safari/537.36", Referer: "https://freeserv.dukascopy.com/" };
const DIR = process.env.H1_DIR || "C:/Users/hp/Documents/Smart ToDo List/h1-data";
const FROM = Date.parse((process.env.FROM || "2015-01-01") + "T00:00:00Z");
const INST = [
  ["XAU/USD", "XAUUSD", 0.25], ["XAG/USD", "XAGUSD", 0.02],
  ["EUR/USD", "EURUSD", 0.00008], ["GBP/USD", "GBPUSD", 0.00008],
  ["USD/JPY", "USDJPY", 0.008], ["USD/CHF", "USDCHF", 0.00010],
  ["USD/CAD", "USDCAD", 0.00012], ["AUD/USD", "AUDUSD", 0.00010],
  ["GBP/JPY", "GBPJPY", 0.016], ["EUR/JPY", "EURJPY", 0.012],
  ["USA500.IDX/USD", "SP500", 0.5], ["USATECH.IDX/USD", "NAS100", 1.5],
];
mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(inst, tsMs) {
  const u = `https://freeserv.dukascopy.com/2.0/index.php?path=chart/json3&instrument=${encodeURIComponent(inst)}` +
    `&offer_side=B&interval=1HOUR&splits=true&stocks=true&jsonp=cb&time_direction=P&timestamp=${tsMs}&limit=1000`;
  for (let a = 0; a < 5; a++) {
    try {
      const t = await (await fetch(u, { headers: UA })).text();
      if (!t.includes("Rate limited")) {
        const arr = JSON.parse(t.slice(t.indexOf("(") + 1, t.lastIndexOf(")")));
        if (Array.isArray(arr)) return arr;
      }
    } catch {}
    await sleep(1500 * (a + 1));
  }
  return null;
}

for (const [inst, key, spread] of INST) {
  const file = `${DIR}/${key}-H1.json`;
  const have = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { key, inst, spread, bars: [] };
  const byT = new Map(have.bars.map((b) => [b[0], b]));
  let cursor = Date.now();
  let stall = 0;
  while (cursor > FROM && stall < 3) {
    const rows = await page(inst, cursor);
    if (!rows || !rows.length) { stall++; await sleep(4000); continue; }
    const before = byT.size;
    let oldest = Infinity;
    for (const r of rows) {
      const t = Math.floor(r[0] / 1000);
      if (r[0] < oldest) oldest = r[0];
      byT.set(t, [t, r[1], r[2], r[3], r[4]]);
    }
    if (byT.size === before) stall++; else stall = 0;
    if (!Number.isFinite(oldest)) break;
    cursor = oldest - 3600e3;
    await sleep(120);
  }
  const bars = [...byT.values()].sort((a, b) => a[0] - b[0]);
  writeFileSync(file, JSON.stringify({ key, inst, spread, bars }));
  const d = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  console.log(`${key.padEnd(8)} ${String(bars.length).padStart(6)} hourly bars, ${d(bars[0][0])} -> ${d(bars[bars.length - 1][0])}`);
}
console.log("H1 FETCH DONE");
