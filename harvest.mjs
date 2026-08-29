// ─────────────────────────────────────────────────────────────────────────
// HARVEST — the full /perf breakdown, rebuilt from history with the corrected
// measurement, and with a matched random control beside every cell.
//
//   node harvest.mjs [bars]
//
// This is what /perf will eventually show from live alerts, except:
//   • the sample is 10-100x larger (months of replay, not days of waiting)
//   • entry is the price available at alert time, and the bar the trade opens
//     inside is walked — the two biases that faked the earlier +232R
//   • every cell is paired with the SAME trade placed at a random moment, so
//     you can see whether the setup beat chance or just rode the market
//
// Read the CONTROL column, not the win rate. A cell that makes +0.4R while its
// random twin makes +0.5R found nothing.
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS } from "./deriv.mjs";
import { fetchGran } from "./source.mjs";
import { detectSOLFib } from "./solfib.mjs";

const BARS = Number(process.argv[2] || 1000);
const TFS = [15, 60];
const KEYS = ["XAUUSD", "NAS100", "GBPJPY", "V25", "V75", "V75S"];
const MAX_BARS = 200;

let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

function settle(bars, from, dir, entry, stop, target) {
  const long = dir === "LONG";
  const risk = long ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;
  const rr = Math.abs(target - entry) / risk;
  const end = Math.min(from + MAX_BARS, bars.length);
  for (let i = from; i < end; i++) {
    const b = bars[i];
    if (long ? b.low <= stop : b.high >= stop) return { R: -1, win: 0 };
    if (long ? b.high >= target : b.low <= target) return { R: rr, win: 1 };
  }
  const last = bars[end - 1];
  if (!last) return null;
  return { R: (long ? last.close - entry : entry - last.close) / risk, win: 0 };
}

const rows = [];   // every harvested setup, real arm
const ctrls = [];  // its matched random twin

for (const key of KEYS) {
  const inst = INSTRUMENTS.find((i) => i.key === key);
  for (const tf of TFS) {
    let bars;
    try { bars = await fetchGran(inst, BARS, tf * 60); }
    catch (e) { console.log(`  ${key} ${tf}m: fetch failed (${e.message})`); continue; }
    if (!bars || bars.length < 200) { console.log(`  ${key} ${tf}m: too little data`); continue; }
    const seen = new Set();
    let n = 0;
    for (let k = 80; k <= bars.length; k++) {
      const win = bars.slice(0, k), nowIdx = k - 1;
      for (const s of detectSOLFib(win, { dispMult: 2, tfMin: tf, longAgeHours: 240 })) {
        for (const [lvl, tapped] of [[0.618, s.tap618], [0.786, s.tap786], [0.886, s.tap886]]) {
          if (!tapped) continue;
          const id = `${s.id}|${tf}|${lvl}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const entry = s.price, stop = s.solX, target = s.target;
          const r = settle(bars, nowIdx, s.dir, entry, stop, target);
          if (!r) continue;
          rows.push({ inst: key, real: !key.startsWith("V"), tf, level: lvl, dir: s.dir,
            aged: !!s.aged, R: r.R, win: r.win });
          n++;
          const sd = Math.abs(stop - entry), td = Math.abs(target - entry);
          for (let t = 0; t < 5; t++) {
            const j = 80 + Math.floor(rnd() * (bars.length - 120));
            const px = bars[j].close;
            const c = settle(bars, j, s.dir, px,
              s.dir === "LONG" ? px - sd : px + sd, s.dir === "LONG" ? px + td : px - td);
            if (c) { ctrls.push({ inst: key, real: !key.startsWith("V"), tf, level: lvl, dir: s.dir, aged: !!s.aged, R: c.R, win: c.win }); break; }
          }
        }
      }
    }
    console.log(`  ${key.padEnd(7)} ${String(tf).padStart(2)}m — ${String(n).padStart(4)} setups over ${((bars.at(-1).t - bars[0].t) / 86400).toFixed(0)}d`);
  }
}

const st = (a) => {
  const n = a.length;
  if (!n) return { n: 0 };
  const m = a.reduce((x, r) => x + r.R, 0) / n;
  const sd = Math.sqrt(a.reduce((x, r) => x + (r.R - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean: m, se: sd / Math.sqrt(n), winPct: (100 * a.reduce((x, r) => x + r.win, 0)) / n };
};
const sgn = (x) => (x >= 0 ? "+" : "") + x.toFixed(3);

function table(title, keyFn, minN = 15) {
  const groups = new Map();
  for (const r of rows) { const k = keyFn(r); if (k == null) continue; if (!groups.has(k)) groups.set(k, { r: [], c: [] }); groups.get(k).r.push(r); }
  for (const c of ctrls) { const k = keyFn(c); if (k == null) continue; if (groups.has(k)) groups.get(k).c.push(c); }
  const out = [];
  for (const [label, g] of groups) {
    const R = st(g.r), C = st(g.c);
    if (R.n < minN) continue;
    const diff = R.mean - (C.n ? C.mean : 0);
    const se = Math.sqrt(R.se ** 2 + (C.se || 0) ** 2);
    out.push({ label, R, C, diff, z: se > 0 ? diff / se : 0 });
  }
  out.sort((a, b) => b.diff - a.diff);
  if (!out.length) return;
  console.log(`\n${title}`);
  console.log(`  ${"bucket".padEnd(22)} ${"n".padStart(5)}  ${"win%".padStart(6)}  ${"setup".padStart(8)}  ${"random".padStart(8)}  ${"vs random".padStart(10)}`);
  for (const o of out) {
    const verdict = Math.abs(o.z) < 2 ? "" : o.z > 0 ? "  ← beats chance" : "  ← worse";
    console.log(`  ${o.label.padEnd(22)} ${String(o.R.n).padStart(5)}  ${o.R.winPct.toFixed(1).padStart(6)}  ${sgn(o.R.mean).padStart(8)}R ${sgn(o.C.n ? o.C.mean : 0).padStart(8)}R  ${(sgn(o.diff) + ` (${Math.abs(o.z).toFixed(1)}σ)`).padStart(16)}${verdict}`);
  }
}

console.log(`\nharvesting ${BARS} bars × ${KEYS.length} instruments × ${TFS.length} timeframes…\n`);
console.log(`\n${"═".repeat(78)}\nHARVEST — ${rows.length} setups, each with a matched random twin\n${"═".repeat(78)}`);
const A = st(rows), B = st(ctrls);
const d = A.mean - B.mean, e = Math.sqrt(A.se ** 2 + B.se ** 2);
console.log(`\nOVERALL   setup ${sgn(A.mean)}R ± ${A.se.toFixed(3)}  ·  random ${sgn(B.mean)}R ± ${B.se.toFixed(3)}  ·  difference ${sgn(d)} (${Math.abs(d / e).toFixed(1)}σ)`);

table("BY FIB LEVEL", (r) => String(r.level));
table("BY INSTRUMENT", (r) => r.inst);
table("BY TIMEFRAME", (r) => (r.tf >= 60 ? r.tf / 60 + "H" : r.tf + "m"));
table("REAL MARKETS vs SYNTHETICS", (r) => (r.real ? "real (XAU/NAS/GJ)" : "synthetic (RNG)"));
table("BY DIRECTION", (r) => r.dir);
table("AGED vs FRESH SOL", (r) => (r.aged ? "aged (>10d)" : "fresh"));
table("BY INSTRUMENT × TIMEFRAME × LEVEL", (r) => `${r.inst} ${r.tf >= 60 ? r.tf / 60 + "H" : r.tf + "m"} ${r.level}`, 20);

console.log(`\n${"─".repeat(78)}`);
console.log(`Read the "vs random" column. Under 2σ = the setup did not beat picking`);
console.log(`a random moment, however good its win rate looks.\n`);
