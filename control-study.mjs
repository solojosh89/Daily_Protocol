// ─────────────────────────────────────────────────────────────────────────
// CONTROL STUDY — is the SOL actually doing anything?
//
//   node control-study.mjs [INST] [TF_MINUTES] [BARS]
//   e.g. node control-study.mjs V75 60 1500
//
// The question every signal must survive: does entering BECAUSE of a swept
// level beat entering the SAME trade at a RANDOM time?
//
// Method — the control is matched, not arbitrary. For every real SOL-fib
// setup we build a twin with the identical direction, identical stop distance
// and identical target distance, placed at a randomly chosen bar in the same
// series. Same geometry, same instrument, same period; the ONLY difference is
// whether a sweep picked the moment. If the sweep carries information, the
// real setups beat their twins. If they tie, the sweep is decoration.
//
// Both sides are settled by the same walker used by the paper book, including
// the bar the trade opens inside, so a bias in the measurement hits both arms
// equally and cancels out of the comparison.
//
// Prints expectancy in R with a standard error, because a difference smaller
// than the noise is not a difference.
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS } from "./deriv.mjs";
import { fetchGran } from "./source.mjs";
import { detectSOLFib } from "./solfib.mjs";

const KEY = (process.argv[2] || "V75").toUpperCase();
const TF = Number(process.argv[3] || 60);
const WANT = Number(process.argv[4] || 1500);
const MAX_BARS = 200;

// deterministic RNG so a rerun reproduces the same control sample
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// Settle one trade against a bar series, starting at the bar it opens inside.
function settle(bars, from, dir, entry, stop, target) {
  const long = dir === "LONG";
  const risk = long ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;
  const rr = Math.abs(target - entry) / risk;
  for (let i = from; i < Math.min(from + MAX_BARS, bars.length); i++) {
    const b = bars[i];
    const hitStop = long ? b.low <= stop : b.high >= stop;
    const hitTgt = long ? b.high >= target : b.low <= target;
    if (hitStop) return -1;              // stop first (same-bar ties -> loss)
    if (hitTgt) return rr;
  }
  const last = bars[Math.min(from + MAX_BARS, bars.length) - 1];
  if (!last) return null;
  return (long ? last.close - entry : entry - last.close) / risk;
}

const stat = (rs) => {
  const n = rs.length;
  if (!n) return { n: 0 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const wins = rs.filter((r) => r > 0).length;
  return { n, mean, se: sd / Math.sqrt(n), winPct: (100 * wins) / n };
};
const fmtStat = (s) => s.n
  ? `n=${String(s.n).padStart(4)}  win ${s.winPct.toFixed(1).padStart(5)}%  exp ${(s.mean >= 0 ? "+" : "") + s.mean.toFixed(3)}R ± ${s.se.toFixed(3)}`
  : "n=0";

const inst = INSTRUMENTS.find((i) => i.key === KEY);
if (!inst) { console.log(`unknown instrument ${KEY}`); process.exit(1); }

console.log(`\nfetching ${WANT} × ${TF}m bars for ${inst.label}…`);
const bars = await fetchGran(inst, WANT, TF * 60);
console.log(`got ${bars.length} bars — ${((bars.at(-1).t - bars[0].t) / 86400).toFixed(1)} days\n`);

const real = { 0.618: [], 0.786: [], 0.886: [] };
const ctrl = { 0.618: [], 0.786: [], 0.886: [] };
const seen = new Set();

for (let k = 80; k <= bars.length; k++) {
  const window = bars.slice(0, k);
  const nowIdx = k - 1;
  for (const s of detectSOLFib(window, { dispMult: 2, tfMin: TF, longAgeHours: 240 })) {
    for (const [lvl, tapped] of [[0.618, s.tap618], [0.786, s.tap786], [0.886, s.tap886]]) {
      if (!tapped) continue;
      const id = `${s.id}|${lvl}`;
      if (seen.has(id)) continue;
      seen.add(id);
      // REAL: entry at the price available now (the close), as the bot books it
      const entry = s.price, stop = s.solX, target = s.target;
      const r = settle(bars, nowIdx, s.dir, entry, stop, target);
      if (r == null) continue;
      real[lvl].push(r);
      // CONTROL: identical geometry, random bar. Same distances, so the same
      // R:R — only the timing is unearned.
      const stopDist = Math.abs(stop - entry), tgtDist = Math.abs(target - entry);
      for (let tries = 0; tries < 5; tries++) {
        const j = 80 + Math.floor(rnd() * (bars.length - 120));
        const px = bars[j].close;
        const cStop = s.dir === "LONG" ? px - stopDist : px + stopDist;
        const cTgt = s.dir === "LONG" ? px + tgtDist : px - tgtDist;
        const cr = settle(bars, j, s.dir, px, cStop, cTgt);
        if (cr != null) { ctrl[lvl].push(cr); break; }
      }
    }
  }
}

console.log(`${inst.label} · ${TF}m — SOL-fib setups vs the SAME trade placed at random times\n`);
let allReal = [], allCtrl = [];
for (const lvl of [0.618, 0.786, 0.886]) {
  const R = stat(real[lvl]), C = stat(ctrl[lvl]);
  allReal = allReal.concat(real[lvl]); allCtrl = allCtrl.concat(ctrl[lvl]);
  if (!R.n) { console.log(`${lvl}: no setups`); continue; }
  const diff = R.mean - C.mean;
  const se = Math.sqrt(R.se ** 2 + C.se ** 2);
  const z = se > 0 ? diff / se : 0;
  console.log(`${lvl}`);
  console.log(`   SOL     ${fmtStat(R)}`);
  console.log(`   random  ${fmtStat(C)}`);
  console.log(`   edge over random: ${(diff >= 0 ? "+" : "") + diff.toFixed(3)}R  (${Math.abs(z).toFixed(1)}σ) ${Math.abs(z) < 2 ? "— indistinguishable from chance" : z > 0 ? "— REAL, survives the control" : "— worse than random"}\n`);
}
const R = stat(allReal), C = stat(allCtrl);
const diff = R.mean - C.mean, se = Math.sqrt(R.se ** 2 + C.se ** 2), z = se > 0 ? diff / se : 0;
console.log(`ALL LEVELS`);
console.log(`   SOL     ${fmtStat(R)}`);
console.log(`   random  ${fmtStat(C)}`);
console.log(`   edge over random: ${(diff >= 0 ? "+" : "") + diff.toFixed(3)}R  (${Math.abs(z).toFixed(1)}σ)`);
console.log(`\n<2σ means the sweep is not distinguishable from picking a random moment.\n`);
