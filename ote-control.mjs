// ─────────────────────────────────────────────────────────────────────────
// OTE CONTROL STUDY — putting the one component with a prior claim on trial.
//
//   node ote-control.mjs [TF_MINUTES] [BARS]
//   e.g. node ote-control.mjs 240 2000     (the validated 4H version)
//        node ote-control.mjs 15 2000      (what the bot actually alerts on)
//
// ote-study.mjs claims the 4H OTE beat an RNG control in 11 of 12 parameter
// combinations on real markets. That claim predates the four measurement bugs
// found this week, so it is re-run here under the corrected rules:
//   • entry is the price available when the setup is detected (the close),
//     not the edge of the OTE zone
//   • the walk starts on the bar the trade opens inside
//   • every setup is paired with the SAME trade (same direction, same stop and
//     target distances) placed at a RANDOM bar in the same series
//
// Also splits A+ (swept level was the range extreme) from A, since that grade
// is the detector's own claim about which setups are better.
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS } from "./deriv.mjs";
import { fetchGran } from "./source.mjs";
import { detectOTE } from "./ote.mjs";

const TF = Number(process.argv[2] || 240);
const BARS = Number(process.argv[3] || 2000);
const KEYS = ["XAUUSD", "NAS100", "GBPJPY"];   // reals only: the OTE's own scope
const MAX_BARS = 200;

let seed = 24681357;
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
const st = (a) => {
  const n = a.length; if (!n) return { n: 0 };
  const m = a.reduce((x, r) => x + r.R, 0) / n;
  const sd = Math.sqrt(a.reduce((x, r) => x + (r.R - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean: m, se: sd / Math.sqrt(n), winPct: (100 * a.reduce((x, r) => x + r.win, 0)) / n };
};
const sgn = (x) => (x >= 0 ? "+" : "") + x.toFixed(3);

const rows = [], ctrls = [];
const tfLabel = TF >= 60 ? `${TF / 60}H` : `${TF}m`;
console.log(`\nOTE control study — ${tfLabel}, ${BARS} bars, real markets only\n`);

for (const key of KEYS) {
  const inst = INSTRUMENTS.find((i) => i.key === key);
  let bars;
  try { bars = await fetchGran(inst, BARS, TF * 60); }
  catch (e) { console.log(`  ${key}: fetch failed (${e.message})`); continue; }
  if (!bars || bars.length < 150) { console.log(`  ${key}: too little data`); continue; }
  const seen = new Set();
  let n = 0;
  for (let k = 80; k <= bars.length; k++) {
    const win = bars.slice(0, k), nowIdx = k - 1;
    const o = detectOTE(win, { dispMult: 2.5 });
    if (!o || seen.has(o.id)) continue;
    seen.add(o.id);
    const entry = o.price != null ? o.price : o.entryNear;
    const r = settle(bars, nowIdx, o.dir, entry, o.stop, o.target);
    if (!r) continue;
    rows.push({ inst: key, dir: o.dir, deep: !!o.deep, fvg: !!o.fvg, R: r.R, win: r.win });
    n++;
    const sd = Math.abs(o.stop - entry), td = Math.abs(o.target - entry);
    for (let t = 0; t < 5; t++) {
      const j = 80 + Math.floor(rnd() * (bars.length - 120));
      const px = bars[j].close;
      const c = settle(bars, j, o.dir, px,
        o.dir === "LONG" ? px - sd : px + sd, o.dir === "LONG" ? px + td : px - td);
      if (c) { ctrls.push({ inst: key, dir: o.dir, deep: !!o.deep, fvg: !!o.fvg, R: c.R, win: c.win }); break; }
    }
  }
  console.log(`  ${key.padEnd(7)} — ${String(n).padStart(4)} OTE setups over ${((bars.at(-1).t - bars[0].t) / 86400).toFixed(0)}d`);
}

function table(title, keyFn, minN = 10) {
  const g = new Map();
  for (const r of rows) { const k = keyFn(r); if (k == null) continue; if (!g.has(k)) g.set(k, { r: [], c: [] }); g.get(k).r.push(r); }
  for (const c of ctrls) { const k = keyFn(c); if (k == null) continue; if (g.has(k)) g.get(k).c.push(c); }
  const out = [];
  for (const [label, v] of g) {
    const R = st(v.r), C = st(v.c);
    if (R.n < minN) continue;
    const diff = R.mean - (C.n ? C.mean : 0);
    const se = Math.sqrt(R.se ** 2 + (C.se || 0) ** 2);
    out.push({ label, R, C, diff, z: se > 0 ? diff / se : 0 });
  }
  out.sort((a, b) => b.diff - a.diff);
  if (!out.length) return;
  console.log(`\n${title}`);
  console.log(`  ${"bucket".padEnd(18)} ${"n".padStart(5)}  ${"win%".padStart(6)}  ${"OTE".padStart(8)}  ${"random".padStart(8)}  ${"vs random".padStart(14)}`);
  for (const o of out) {
    const v = Math.abs(o.z) < 2 ? "" : o.z > 0 ? "  ← BEATS CHANCE" : "  ← worse";
    console.log(`  ${o.label.padEnd(18)} ${String(o.R.n).padStart(5)}  ${o.R.winPct.toFixed(1).padStart(6)}  ${sgn(o.R.mean).padStart(8)}R ${sgn(o.C.n ? o.C.mean : 0).padStart(8)}R  ${(sgn(o.diff) + ` (${Math.abs(o.z).toFixed(1)}σ)`).padStart(14)}${v}`);
  }
}

const A = st(rows), B = st(ctrls);
if (!A.n) { console.log("\nno setups found — try more bars or a different timeframe\n"); process.exit(0); }
const d = A.mean - B.mean, e = Math.sqrt(A.se ** 2 + B.se ** 2);
console.log(`\n${"═".repeat(72)}`);
console.log(`OVERALL   OTE ${sgn(A.mean)}R ± ${A.se.toFixed(3)}  ·  random ${sgn(B.mean)}R ± ${B.se.toFixed(3)}`);
console.log(`          win ${A.winPct.toFixed(1)}% vs ${B.winPct.toFixed(1)}%  ·  difference ${sgn(d)} (${Math.abs(d / e).toFixed(1)}σ)`);
console.log(`${"═".repeat(72)}`);
table("BY INSTRUMENT", (r) => r.inst);
table("A+ (range extreme) vs A", (r) => (r.deep ? "A+ deep sweep" : "A minor swing"));
table("WITH FVG vs WITHOUT", (r) => (r.fvg ? "FVG in zone" : "no FVG"));
table("BY DIRECTION", (r) => r.dir);
console.log(`\nUnder 2σ = did not beat entering the same trade at a random moment.\n`);
