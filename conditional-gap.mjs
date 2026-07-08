// ─────────────────────────────────────────────────────────────────────────
// THE ONE QUESTION: after sweep1, does sweep2 come before H4 close, and when?
//
// Scans EVERY H4 candle (not only completed double-sweeps — that was the
// survivorship blind spot). For each candle, using the PRIOR candle's high/low
// as the liquidity levels, finds on 15m:
//    sweep1 = first side taken (high>prevHigh or low<prevLow), and WHEN
//    sweep2 = the opposite side taken later, before this H4 closes, or NEVER
//
// Everything expressed as % of the H4 elapsed (0-100%), per the friend's
// suggestion, so it generalizes across candles. Answers, conditioned on how
// early sweep1 landed:
//    - completion rate: P(sweep2 before close | sweep1 happened)
//    - if completed: median % elapsed at sweep2, and the gap
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS } from "./deriv.mjs";
import { fetch4H, fetch15m } from "./source.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const G4 = 14400;
const targetKeys = ["XAUUSD", "NAS100", "GBPJPY"];
const targets = INSTRUMENTS.filter((i) => targetKeys.includes(i.key));
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);

// sweep1 timing buckets, in % of the H4 candle elapsed
const B = [
  { label: "0-25%  (hr 1)", lo: 0, hi: 25 },
  { label: "25-50% (hr 2)", lo: 25, hi: 50 },
  { label: "50-75% (hr 3)", lo: 50, hi: 75 },
  { label: "75-100%(hr 4)", lo: 75, hi: 100 },
];

async function study(inst) {
  const c4 = await fetch4H(inst, 600, cfg.bucketOffsetHours);
  const c15 = await fetch15m(inst, 20000);
  const start15 = c15[0].t;
  const rows = [];

  for (let i = 1; i < c4.length - 1; i++) {
    const cur = c4[i], prev = c4[i - 1];
    if (cur.t < start15) continue;
    const win = c15.filter((b) => b.t >= cur.t && b.t < cur.t + G4);
    if (win.length < 4) continue;

    let hi = -1, lo = -1;
    for (let k = 0; k < win.length; k++) {
      if (hi === -1 && win[k].high > prev.high) hi = k;
      if (lo === -1 && win[k].low < prev.low) lo = k;
    }
    if (hi === -1 && lo === -1) continue;          // no first sweep at all — not relevant
    const frac = (k) => 100 * ((win[k].t - cur.t) / G4);

    let s1Frac, complete, s2Frac;
    if (hi !== -1 && lo !== -1) {                   // both sides taken → completed
      const first = Math.min(hi, lo), second = Math.max(hi, lo);
      s1Frac = frac(first); s2Frac = frac(second); complete = true;
    } else {                                        // only one side ever taken → sweep2 never came
      s1Frac = frac(hi !== -1 ? hi : lo); complete = false; s2Frac = null;
    }
    rows.push({ s1Frac, complete, s2Frac, gap: complete ? s2Frac - s1Frac : null });
  }
  return rows;
}

function report(label, rows) {
  const withS1 = rows.length;
  const comp = rows.filter((r) => r.complete);
  console.log(`\n━━ ${label} — ${withS1} candles where a first side was swept  |  ${pct(comp.length, withS1)}% completed sweep2 before close`);
  console.log(`   sweep1 timing        n    P(sweep2 before close)   median sweep2 @      median gap`);
  for (const b of B) {
    const inB = rows.filter((r) => r.s1Frac >= b.lo && r.s1Frac < b.hi);
    if (!inB.length) { console.log(`   ${b.label}      n=0`); continue; }
    const c = inB.filter((r) => r.complete);
    const s2 = median(c.map((r) => r.s2Frac)), gap = median(c.map((r) => r.gap));
    const gapMin = isNaN(gap) ? "—" : `${gap.toFixed(0)}% (~${Math.round(gap / 100 * 240)}m)`;
    const s2Txt = isNaN(s2) ? "—" : `${s2.toFixed(0)}% elapsed`;
    console.log(`   ${b.label}   n=${String(inB.length).padStart(3)}      ${String(pct(c.length, inB.length)).padStart(3)}%              ${s2Txt.padEnd(16)}   ${gapMin}`);
  }
}

const run = async () => {
  let all = [];
  const per = [];
  for (const inst of targets) {
    try { const r = await study(inst); per.push([inst.label, r]); all = all.concat(r); }
    catch (e) { console.log(`${inst.label}: FAILED ${e.message}`); }
  }
  for (const [l, r] of per) report(l, r);
  report("ALL COMBINED", all);
  console.log(`\nRead: "P(sweep2 before close)" is the core number — if sweep1 lands early, how often does the`);
  console.log(`opposite side complete the setup before the H4 closes. History is feed-capped (~50-90 days),`);
  console.log(`so late-bucket n is small; treat the ALL COMBINED row as the signal.`);
};
run().catch((e) => { console.error(e); process.exit(1); });
