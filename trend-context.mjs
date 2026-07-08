// ─────────────────────────────────────────────────────────────────────────
// TREND-CONTEXT STUDY — the user's V25s observation, decomposed and tested:
//
//  (1) ORDER: in bullish double-sweeps, is A's LOW taken first? (15m replay)
//  (2) SURVIVORSHIP: among ALL low-takes in a downtrend, how many actually
//      become bullish double-sweeps vs just keep falling? (the part chart
//      reading can't show you — you only trace back from the winners)
//  (3) CONTEXT: do COUNTER-TREND double-sweeps (bull after a downtrend)
//      show bigger follow-through AFTER B closes than with-trend ones?
//      Measured post-close only (candles C..E), so B's own size can't
//      contaminate the answer.
//  (4) CONTROL: all of it on synthetics (RNG — cannot "want" anything) vs
//      reals. If the pattern lives on V25s too, it's random-walk geometry.
// ─────────────────────────────────────────────────────────────────────────
import { fetchCandles } from "./deriv.mjs";
import { fetch4H } from "./source.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const G4 = 14400;
const REALI = [
  { key: "Gold", sym: "frxXAUUSD", dataSrc: "deriv", offset: 1 },
  { key: "EURUSD", sym: "frxEURUSD", dataSrc: "deriv", offset: 1 },
  { key: "GBPUSD", sym: "frxGBPUSD", dataSrc: "deriv", offset: 1 },
  { key: "USDJPY", sym: "frxUSDJPY", dataSrc: "deriv", offset: 1 },
  { key: "GBPJPY", sym: "frxGBPJPY", dataSrc: "deriv", offset: 1 },
  { key: "AUDUSD", sym: "frxAUDUSD", dataSrc: "deriv", offset: 1 },
  { key: "USDCAD", sym: "frxUSDCAD", dataSrc: "deriv", offset: 1 },
];
const SYNTHI = [
  { key: "V25", sym: "R_25", dataSrc: "deriv", offset: 0 },
  { key: "V25S", sym: "1HZ25V", dataSrc: "deriv", offset: 0 },
  { key: "V50", sym: "R_50", dataSrc: "deriv", offset: 0 },
  { key: "V75", sym: "R_75", dataSrc: "deriv", offset: 0 },
  { key: "V100", sym: "R_100", dataSrc: "deriv", offset: 0 },
];
const TREND_N = 6; // trend = close(A) vs close 6 candles earlier (24h of context)
const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);

// ── (2)+(3) from 4H data ────────────────────────────────────────────────────
async function study4H(inst) {
  const c = await fetch4H(inst, 600, inst.offset ?? cfg.bucketOffsetHours);
  const r = {
    // completion table: swept the low, split by prior trend
    lowTake_dn: 0, lowTake_dn_completedBull: 0, lowTake_dn_closedDown: 0,
    lowTake_up: 0, lowTake_up_completedBull: 0,
    // post-close follow-through of CONFIRMED double-sweeps, by context
    followCounter: [], followWith: [],
    bRangeCounter: [], bRangeWith: [],
  };
  for (let i = TREND_N + 1; i < c.length - 3; i++) {
    const A = c[i - 1], B = c[i];
    const aR = A.high - A.low; if (aR <= 0) continue;
    const trend = A.close - c[i - 1 - TREND_N].close; // context BEFORE B exists
    const sL = B.low < A.low, sH = B.high > A.high;
    const bull = B.close > B.open;

    // completion accounting (mirrored: low-take→bull, high-take→bear, pooled)
    if (sL) {
      if (trend < 0) {
        r.lowTake_dn++;
        if (sH && bull) r.lowTake_dn_completedBull++;
        if (!bull) r.lowTake_dn_closedDown++;
      } else {
        r.lowTake_up++;
        if (sH && bull) r.lowTake_up_completedBull++;
      }
    }
    if (sH) { // mirror pooled into the same counters (bear after uptrend = "counter")
      if (trend > 0) {
        r.lowTake_dn++;
        if (sL && !bull) r.lowTake_dn_completedBull++;
        if (bull) r.lowTake_dn_closedDown++;
      } else {
        r.lowTake_up++;
        if (sL && !bull) r.lowTake_up_completedBull++;
      }
    }

    // post-close follow-through of confirmed double-sweeps
    if (sL && sH && B.close !== B.open) {
      const nxt = c.slice(i + 1, i + 4);
      if (nxt.length < 3) continue;
      const bR = B.high - B.low || 1e-9;
      const follow = bull
        ? (Math.max(...nxt.map((x) => x.high)) - B.close) / bR
        : (B.close - Math.min(...nxt.map((x) => x.low))) / bR;
      const counter = (bull && trend < 0) || (!bull && trend > 0);
      (counter ? r.followCounter : r.followWith).push(follow);
      (counter ? r.bRangeCounter : r.bRangeWith).push(bR / aR);
    }
  }
  return r;
}

// ── (1)+(2) 15m replay on V25s specifically (the chart the user is reading) ──
async function replayV25s() {
  const c15 = await fetchCandles("1HZ25V", 5000, 900); // ~52 days of 15m
  // bucket into UTC-aligned 4H
  const buckets = new Map();
  for (const b of c15) {
    const bs = Math.floor(b.t / G4) * G4;
    if (!buckets.has(bs)) buckets.set(bs, []);
    buckets.get(bs).push(b);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b).filter((k) => buckets.get(k).length === 16);
  const agg = (bars) => ({
    open: bars[0].open, close: bars[bars.length - 1].close,
    high: Math.max(...bars.map((x) => x.high)), low: Math.min(...bars.map((x) => x.low)),
  });
  let bullDS = 0, lowFirst = 0;
  const extraBelow = [];           // after the FIRST low-take bar, how much deeper did it go? (%A)
  let dnLowTakes = 0, dnCompleted = 0, dnKeptFalling = 0;
  for (let k = TREND_N + 1; k < keys.length; k++) {
    const Abars = buckets.get(keys[k - 1]), Bbars = buckets.get(keys[k]);
    const A = agg(Abars), B = agg(Bbars);
    const aR = A.high - A.low; if (aR <= 0) continue;
    const trendRef = buckets.get(keys[k - 1 - TREND_N]);
    const trend = A.close - agg(trendRef).close;
    const sL = B.low < A.low, sH = B.high > A.high, bull = B.close > B.open;

    if (sL && sH && bull) {
      bullDS++;
      let tLow = null, tHigh = null;
      for (const b of Bbars) {
        if (tLow === null && b.low < A.low) tLow = b.t;
        if (tHigh === null && b.high > A.high) tHigh = b.t;
      }
      if (tLow !== null && tHigh !== null && tLow < tHigh) lowFirst++;
      // depth of continuation AFTER the first low-take bar closes
      if (tLow !== null) {
        const idx = Bbars.findIndex((b) => b.t === tLow);
        const after = Bbars.slice(idx + 1);
        const firstBarLow = Bbars[idx].low;
        const minAfter = after.length ? Math.min(...after.map((b) => b.low)) : firstBarLow;
        extraBelow.push(100 * Math.max(0, firstBarLow - minAfter) / aR);
      }
    }
    // survivorship on the SAME chart: downtrend + low taken → what happened?
    if (trend < 0 && sL) {
      dnLowTakes++;
      if (sH && bull) dnCompleted++;
      if (!bull) dnKeptFalling++;
    }
  }
  return { bullDS, lowFirst, extraBelow, dnLowTakes, dnCompleted, dnKeptFalling, n4h: keys.length };
}

const run = async () => {
  console.log("═══ (1)+(2) V25s 15m replay — the exact chart you are reading ═══");
  const v = await replayV25s();
  console.log(`4H candles reconstructed: ${v.n4h} (~${Math.round(v.n4h / 6)} days)`);
  console.log(`Bullish double-sweeps: ${v.bullDS} · LOW taken FIRST in ${pct(v.lowFirst, v.bullDS)}% of them`);
  console.log(`After the first low-take 15m bar: median EXTRA drop ${med(v.extraBelow).toFixed(0)}% of A-range before turning`);
  console.log(`Downtrend + low taken (${v.dnLowTakes} cases): completed bullish double-sweep ${pct(v.dnCompleted, v.dnLowTakes)}% · closed DOWN anyway ${pct(v.dnKeptFalling, v.dnLowTakes)}%`);

  console.log("\n═══ (3)+(4) counter-trend vs with-trend — post-close follow-through only ═══");
  const pool = (list) => list.reduce((a, r) => {
    for (const k of ["lowTake_dn", "lowTake_dn_completedBull", "lowTake_dn_closedDown", "lowTake_up", "lowTake_up_completedBull"]) a[k] += r[k];
    for (const k of ["followCounter", "followWith", "bRangeCounter", "bRangeWith"]) a[k] = a[k].concat(r[k]);
    return a;
  }, { lowTake_dn: 0, lowTake_dn_completedBull: 0, lowTake_dn_closedDown: 0, lowTake_up: 0, lowTake_up_completedBull: 0, followCounter: [], followWith: [], bRangeCounter: [], bRangeWith: [] });

  for (const [label, insts] of [["REAL", REALI], ["SYNTH (RNG control)", SYNTHI]]) {
    const rs = [];
    for (const inst of insts) { try { rs.push(await study4H(inst)); } catch (e) { console.log(`${inst.key}: ${e.message}`); } }
    const p = pool(rs);
    console.log(`\n${label}:`);
    console.log(`  completion | counter-trend take: ${pct(p.lowTake_dn_completedBull, p.lowTake_dn)}% became reversal double-sweep, ${pct(p.lowTake_dn_closedDown, p.lowTake_dn)}% kept going  (n=${p.lowTake_dn})`);
    console.log(`  completion | with-trend take:    ${pct(p.lowTake_up_completedBull, p.lowTake_up)}% became reversal double-sweep  (n=${p.lowTake_up})`);
    console.log(`  follow-through after close | counter-trend: median ${med(p.followCounter).toFixed(2)}x B-range (n=${p.followCounter.length})`);
    console.log(`  follow-through after close | with-trend:    median ${med(p.followWith).toFixed(2)}x B-range (n=${p.followWith.length})`);
    console.log(`  B's own size | counter ${med(p.bRangeCounter).toFixed(2)}x A vs with-trend ${med(p.bRangeWith).toFixed(2)}x A  ← geometry check`);
  }
};
run().catch((e) => { console.error(e); process.exit(1); });
