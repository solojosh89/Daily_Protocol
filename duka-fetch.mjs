// ─────────────────────────────────────────────────────────────────────────
// 1-MINUTE BARS FROM DUKASCOPY, LONDON WINDOW ONLY
//
// The London Open rule only needs 05:00 to 17:00 UTC, so we fetch two pages
// per weekday (1000 bars ending 12:00 UTC, 400 bars ending 16:30 UTC) instead
// of dragging down whole days. Bid side; the spread is added later, in the test.
//
// Resumable: one file per instrument-month, skipped if already on disk.
//   node duka-fetch.mjs            2019-01 .. today
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync, existsSync, mkdirSync } from "fs";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128 Safari/537.36", Referer: "https://freeserv.dukascopy.com/" };
const ALL = [["XAU/USD", "XAUUSD"], ["GBP/USD", "GBPUSD"]];
const INST = process.env.ONLY ? ALL.filter(([, k]) => k === process.env.ONLY) : ALL;
const FROM = [+(process.env.FROM_YEAR || 2019), 1], TO = [2026, 9];
const DIR = process.env.DATA_DIR || "data/m1";
mkdirSync(DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(inst, tsMs, limit) {
  const u = `https://freeserv.dukascopy.com/2.0/index.php?path=chart/json3&instrument=${encodeURIComponent(inst)}` +
    `&offer_side=B&interval=1MIN&splits=true&stocks=true&jsonp=cb&time_direction=P&timestamp=${tsMs}&limit=${limit}`;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(u, { headers: UA });
      const t = await r.text();
      const j = t.slice(t.indexOf("(") + 1, t.lastIndexOf(")"));
      const arr = JSON.parse(j);
      if (Array.isArray(arr)) return arr;
    } catch {}
    await sleep(400 * (a + 1));
  }
  return [];
}

// every weekday in a month, as "YYYY-MM-DD"
function weekdays(y, m) {
  const out = [];
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) break;
    const w = dt.getUTCDay();
    if (w !== 0 && w !== 6) out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const months = [];
for (let y = FROM[0]; y <= TO[0]; y++)
  for (let m = 1; m <= 12; m++) {
    if (y === FROM[0] && m < FROM[1]) continue;
    if (y === TO[0] && m > TO[1]) continue;
    months.push([y, m]);
  }

for (const [inst, key] of INST) {
  for (const [y, m] of months) {
    const file = `${DIR}/${key}-${y}-${String(m).padStart(2, "0")}.json`;
    if (existsSync(file)) continue;
    const days = weekdays(y, m).filter((d) => Date.parse(d + "T00:00:00Z") < Date.now());
    const day = {};
    await pool(days, +(process.env.CONC || 4), async (d) => {
      const base = Date.parse(d + "T00:00:00Z");
      const [a, b] = await Promise.all([page(inst, base + 12 * 3600e3, 1000), page(inst, base + 16.5 * 3600e3, 400)]);
      const seen = new Map();
      for (const x of [...a, ...b]) {
        const tSec = Math.floor(x[0] / 1000);
        if (tSec < base / 1000 + 5 * 3600 || tSec >= base / 1000 + 17 * 3600) continue;
        seen.set(tSec, [tSec, x[1], x[2], x[3], x[4]]);
      }
      if (seen.size > 60) day[d] = [...seen.values()].sort((p, q) => p[0] - q[0]);
    });
    const n = Object.keys(day).length;
    // An empty month means the feed throttled us, not that the month has no
    // data. Writing it would poison the cache, so back off and try again.
    if (n < Math.max(5, days.length * 0.5)) {
      console.log(`${key} ${y}-${String(m).padStart(2, "0")}: only ${n}/${days.length} days, backing off 60s and retrying`);
      await sleep(60000);
      const retry = {};
      await pool(days, 2, async (d) => {
        const base = Date.parse(d + "T00:00:00Z");
        const a = await page(inst, base + 12 * 3600e3, 1000);
        const b = await page(inst, base + 16.5 * 3600e3, 400);
        const seen = new Map();
        for (const x of [...a, ...b]) {
          const tSec = Math.floor(x[0] / 1000);
          if (tSec < base / 1000 + 5 * 3600 || tSec >= base / 1000 + 17 * 3600) continue;
          seen.set(tSec, [tSec, x[1], x[2], x[3], x[4]]);
        }
        if (seen.size > 60) retry[d] = [...seen.values()].sort((p, q) => p[0] - q[0]);
      });
      if (Object.keys(retry).length > n) { for (const [k2, v] of Object.entries(retry)) day[k2] = v; }
      if (Object.keys(day).length < 5) { console.log(`${key} ${y}-${String(m).padStart(2, "0")}: still empty, leaving it unwritten`); continue; }
    }
    writeFileSync(file, JSON.stringify(day));
    console.log(`${key} ${y}-${String(m).padStart(2, "0")}: ${Object.keys(day).length} days, ${Object.values(day).reduce((s, v) => s + v.length, 0)} bars`);
  }
}
console.log("DUKASCOPY FETCH DONE");
