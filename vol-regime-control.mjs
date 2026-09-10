// ---------------------------------------------------------------------------
// VOLATILITY REGIME STUDY: do OTE setups work better in wild times or calm?
//
//   node vol-regime-control.mjs [TF_MINUTES] [BARS] [INSTRUMENTS]
//   e.g. node vol-regime-control.mjs 240 4500
//        node vol-regime-control.mjs 60 5000 XAUUSD,NAS100,GBPJPY
//        node vol-regime-control.mjs 240 4500 SIM      (no clustering: must show nothing)
//
// WHY: the coin-toss check (random-check.mjs) found exactly one strong,
// non-random property in real markets: wild candles come in bunches (13 to 21
// standard errors past chance on Gold and Nasdaq). It says WHEN big moves
// come, not WHICH WAY. This asks whether pairing that "when" with a setup's
// "which way" produces something the setup alone did not.
//
// WEATHER LABEL (known at the signal bar, nothing from the future):
//   ratio = average candle range over the last 20 bars
//           / average candle range over the last 200 bars
//   The ratio's thirds for that instrument define calm / normal / wild.
//
// FAIRNESS:
//   * OTE detection sees only a rolling 200-bar window ending at the bar being
//     judged, like the live bot.
//   * Entry = close of the signal bar; the walk starts on the next bar.
//   * The random twin is drawn from bars in the SAME weather, same direction,
//     same stop and target distances. So "wild beats its twin" means the setup
//     adds something inside wild weather, not merely that wild weather moves.
//   * Every trade and twin gets a full 200-bar walk window.
//   * Stop and target in the same candle counts as a loss (both arms).
// ---------------------------------------------------------------------------
import { INSTRUMENTS } from "./deriv.mjs";
import { fetchGran } from "./source.mjs";
import { detectOTE } from "./ote.mjs";

const TF = Number(process.argv[2] || 240);
const BARS = Number(process.argv[3] || 4500);
const KEYS = (process.argv[4] || "XAUUSD,NAS100,GBPJPY").split(",").map((s) => s.trim().toUpperCase());
const MAX_BARS = 200;
const FAST = 20, SLOW = 200, WINDOW = 200;

let seed = 8642;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

let simSeed = 31337;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };
function simBars(n, step) {
  const out = []; let p = 1000;
  for (let i = 0; i < n; i++) {
    const o = p; let h = p, l = p;
    for (let k = 0; k < 30; k++) { p *= 1 + 0.0009 * gauss(); if (p > h) h = p; if (p < l) l = p; }
    out.push({ t: 1700000000 + i * step, open: o, high: h, low: l, close: p });
  }
  return out;
}

function settle(bars, from, dir, entry, stop, target) {
  const long = dir === "LONG";
  const risk = long ? entry - stop : stop - entry;
  const reward = long ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0)) return null;
  const rr = reward / risk;
  const end = Math.min(from + MAX_BARS, bars.length);
  if (from >= end) return null;
  for (let i = from; i < end; i++) {
    const b = bars[i];
    if (long ? b.low <= stop : b.high >= stop) return { R: -1, win: 0, rr };
    if (long ? b.high >= target : b.low <= target) return { R: rr, win: 1, rr };
  }
  const last = bars[end - 1];
  return { R: (long ? last.close - entry : entry - last.close) / risk, win: 0, rr };
}

// ratio[i] uses bars up to and including i only.
function weatherRatios(bars) {
  const rng = bars.map((b) => b.high - b.low);
  const out = new Array(bars.length).fill(null);
  let f = 0, s = 0;
  for (let i = 0; i < bars.length; i++) {
    f += rng[i]; s += rng[i];
    if (i >= FAST) f -= rng[i - FAST];
    if (i >= SLOW) s -= rng[i - SLOW];
    if (i >= SLOW - 1 && s > 0) out[i] = (f / FAST) / (s / SLOW);
  }
  return out;
}

const rows = [];
const tfL = TF >= 60 ? `${TF / 60}H` : `${TF}m`;
console.log(`\nVolatility regime study  |  OTE on ${tfL}  |  ${BARS} bars  |  ${KEYS.join(", ")}\n`);

for (const key of KEYS) {
  let bars;
  if (key === "SIM") bars = simBars(BARS, TF * 60);
  else {
    const inst = INSTRUMENTS.find((i) => i.key === key);
    if (!inst) { console.log(`  ${key}: unknown instrument`); continue; }
    try { bars = await fetchGran(inst, BARS, TF * 60); }
    catch (e) { console.log(`  ${key}: fetch failed (${e.message})`); continue; }
  }
  if (!bars || bars.length < SLOW + MAX_BARS + 100) { console.log(`  ${key}: too little data`); continue; }

  const ratio = weatherRatios(bars);
  const lastEntry = bars.length - 2 - MAX_BARS;
  const valid = [];
  for (let j = SLOW; j <= lastEntry; j++) if (ratio[j] != null) valid.push(ratio[j]);
  const sorted = [...valid].sort((a, b) => a - b);
  const t1 = sorted[Math.floor(sorted.length / 3)], t2 = sorted[Math.floor((2 * sorted.length) / 3)];
  const label = (j) => (ratio[j] < t1 ? "calm" : ratio[j] < t2 ? "normal" : "wild");
  const pool = { calm: [], normal: [], wild: [] };
  for (let j = SLOW; j <= lastEntry; j++) if (ratio[j] != null) pool[label(j)].push(j);

  const twin = (regime, dir, sd, td) => {
    const idx = pool[regime];
    for (let t = 0; t < 10; t++) {
      const j = idx[Math.floor(rnd() * idx.length)];
      const px = bars[j].close, long = dir === "LONG";
      const r = settle(bars, j + 1, dir, px, long ? px - sd : px + sd, long ? px + td : px - td);
      if (r) return r;
    }
    return null;
  };

  const seen = new Set();
  const count = { calm: 0, normal: 0, wild: 0 };
  for (let j = SLOW; j <= lastEntry; j++) {
    const win = bars.slice(Math.max(0, j + 1 - WINDOW), j + 1);
    const o = detectOTE(win, { dispMult: 2.5 });
    if (!o || seen.has(o.id)) continue;
    seen.add(o.id);
    const entry = o.price != null ? o.price : o.entryNear;
    const r = settle(bars, j + 1, o.dir, entry, o.stop, o.target);
    if (!r) continue;
    const regime = label(j);
    const tw = twin(regime, o.dir, Math.abs(o.stop - entry), Math.abs(o.target - entry));
    rows.push({ key, regime, dir: o.dir, R: r.R, win: r.win, rr: r.rr, tR: tw ? tw.R : null, tWin: tw ? tw.win : null });
    count[regime]++;
  }
  const days = (bars.at(-1).t - bars[0].t) / 86400;
  console.log(`  ${key.padEnd(7)} ${days.toFixed(0).padStart(5)} days  calm<${t1.toFixed(2)}  wild>=${t2.toFixed(2)}  ->  calm ${count.calm}  normal ${count.normal}  wild ${count.wild}`);
}

const stat = (v) => {
  const n = v.length; if (!n) return { n: 0, mean: 0, se: 0 };
  const m = v.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean: m, se: sd / Math.sqrt(n) };
};
const sg = (x) => (x >= 0 ? "+" : "") + x.toFixed(3);

function table(title, keyFn, minN = 15, order = null) {
  const g = new Map();
  for (const r of rows) { if (r.tR == null) continue; const k = keyFn(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  let keys = [...g.keys()];
  if (order) keys = order.filter((k) => g.has(k)).concat(keys.filter((k) => !order.includes(k)));
  const lines = [];
  for (const k of keys) {
    const rs = g.get(k);
    if (rs.length < minN) continue;
    const P = stat(rs.map((r) => r.R)), T = stat(rs.map((r) => r.tR)), D = stat(rs.map((r) => r.R - r.tR));
    const z = D.se > 0 ? D.mean / D.se : 0;
    const win = (100 * rs.reduce((a, r) => a + r.win, 0)) / rs.length;
    const twinWin = (100 * rs.reduce((a, r) => a + (r.tWin || 0), 0)) / rs.length;
    const verdict = Math.abs(z) < 2 ? "" : z > 0 ? "  <- BEATS CHANCE" : "  <- worse than chance";
    lines.push(`  ${k.padEnd(18)} ${String(rs.length).padStart(5)}  ${(win.toFixed(1) + "%").padStart(6)}  ${(twinWin.toFixed(1) + "%").padStart(8)}  ${(sg(P.mean) + "R").padStart(9)}  ${(sg(T.mean) + "R").padStart(9)}  ${(sg(D.mean) + ` (${Math.abs(z).toFixed(1)}s)`).padStart(16)}${verdict}`);
  }
  if (!lines.length) return;
  console.log(`\n${title}`);
  console.log(`  ${"bucket".padEnd(18)} ${"n".padStart(5)}  ${"win".padStart(6)}  ${"twin win".padStart(8)}  ${"OTE".padStart(9)}  ${"twin".padStart(9)}  ${"difference".padStart(16)}`);
  for (const l of lines) console.log(l);
}

console.log(`\n${"=".repeat(92)}\n${rows.length} OTE setups, each with a random twin from the SAME weather\n${"=".repeat(92)}`);
table("all", () => "all setups", 5);
table("by weather", (r) => r.regime, 10, ["calm", "normal", "wild"]);
table("by instrument and weather", (r) => `${r.key} ${r.regime}`, 10,
  KEYS.flatMap((k) => ["calm", "normal", "wild"].map((w) => `${k} ${w}`)));
table("by direction and weather", (r) => `${r.dir} ${r.regime}`, 10,
  ["LONG", "SHORT"].flatMap((d) => ["calm", "normal", "wild"].map((w) => `${d} ${w}`)));
console.log(`\n"difference" = OTE minus its random twin from the same weather. Under 2s = no better than chance.\n`);
