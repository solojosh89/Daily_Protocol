// ─────────────────────────────────────────────────────────────────────────
// SOL AT THE TOP — does a sweep of the week's very top (or bottom), confirmed
// by a break of structure or a retest of supply/demand, beat a random entry?
//
// "Very top" SOL: a candle takes the highest high (lowest low) of the last 5
// trading days (120 1H candles, 240 30m candles) and closes back inside. Every
// other ICT sweep (swing, equal, pair, Asia, London, previous day) is run
// through the same confirmations, to see whether the very top adds anything.
//
// Confirmations, fixed before running (short side shown; longs mirrored):
//   sweep    enter at the sweep candle's close
//   choch    first body close below the last swing low before the sweep,
//            within 10 candles; enter at that close
//   bos      after the choch, a lower high forms (3-candle swing high below
//            the sweep extreme), then a body close below the low it bounced
//            from, within 30 candles; enter at that close, stop above the lower high
//   retest   after the choch, a limit at the bottom of the supply zone (body of
//            the last up candle into the sweep extreme), filled within 20
//            candles; stop above the zone and the sweep extreme
// Stops sit 0.1 ATR past their level. Target 2R, settled within 72 candles;
// a limit's fill candle can only stop it out.
//
// Random partners: same market, direction, weather, stop size and target, and
// the same order type (limit partners for the retest). Clustered by market-week.
// Pass rule: 3 standard errors vs random, same sign in both halves, nothing on
// the fake random-walk markets, positive after spread.
//
//   DATA_DIR=folder OUT=soltop.json node sol-top-check.mjs
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "fs";
import { analyzeLiquidity } from "./ict.mjs";
import { MARKETS, loadBars } from "./research-markets.mjs";

const EXT = { 60: 120, 30: 240 };
const POOLS = ["swing", "equal", "pair", "asia", "london", "pdh", "extreme"];
const MODELS = ["sweep", "choch", "bos", "retest"];
const NAMES = { sweep: "sweep only", choch: "first structure break (CHoCH)", bos: "lower high + BOS", retest: "retest of supply/demand" };
const MAX_BARS = 72, RR = 2, CHOCH_WIN = 10, BOS_WIN = 30, FILL_WIN = 20;

let seed = 4242;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let simSeed = 1717;
const simU = () => (simSeed = (simSeed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => { let a = 0; while (a === 0) a = simU(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * simU()); };

function race(bars, from, dir, entry, stop, fillCandle = false) {
  const short = dir === "SHORT", risk = Math.abs(entry - stop);
  const tgt = short ? entry - RR * risk : entry + RR * risk;
  const end = Math.min(bars.length, from + MAX_BARS);
  for (let k = from; k < end; k++) {
    const b = bars[k];
    if (short ? b.high >= stop : b.low <= stop) return { hit: 0, R: -1 };
    if (fillCandle && k === from) continue;
    if (short ? b.low <= tgt : b.high >= tgt) return { hit: 1, R: RR };
  }
  const last = bars[end - 1].close;
  return { hit: 0.5, R: Math.max(-1, Math.min(RR, (short ? entry - last : last - entry) / risk)) };
}

function study(bars, tf, tfMin, key, spread, rows) {
  const { sweeps, atr } = analyzeLiquidity(bars, { pools: POOLS, EXT_N: EXT[tfMin] });
  const n = bars.length, lastIdx = n - 2 - MAX_BARS - BOS_WIN - CHOCH_WIN;
  const pool = [];
  for (let q = 20; q <= lastIdx; q++) if (Number.isFinite(atr[q])) pool.push([atr[q] / bars[q].close, q]);
  pool.sort((a, b) => a[0] - b[0]);
  const W = Math.max(30, Math.floor(pool.length * 0.02));
  const pick = (w) => {
    let lo = 0, hi = pool.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid][0] < w) lo = mid + 1; else hi = mid; }
    const a = Math.max(0, lo - W), b = Math.min(pool.length - 1, lo + W);
    return pool[a + Math.floor(rnd() * (b - a + 1))][1];
  };
  const midT = bars[Math.floor(n / 2)].t;

  const push = (group, model, ev, entryIdx, entry, stop, res, lim = null) => {
    const short = ev.dir === "SHORT", frac = Math.abs(entry - stop) / entry;
    if (!(frac > 0)) return;
    let t = null;
    if (!lim) {
      const q = pick(atr[entryIdx] / bars[entryIdx].close), te = bars[q].close;
      t = race(bars, q + 1, ev.dir, te, short ? te * (1 + frac) : te * (1 - frac));
    } else {
      for (let tries = 0; tries < 60 && !t; tries++) {
        const q = pick(atr[lim.decisionIdx] / bars[lim.decisionIdx].close), c = bars[q].close;
        const te = c * (1 + (short ? lim.retrace : -lim.retrace)), ts = short ? te * (1 + frac) : te * (1 - frac);
        for (let k = q + 1; k <= q + FILL_WIN && k < n; k++) {
          if (short ? bars[k].high >= te : bars[k].low <= te) { t = race(bars, k, ev.dir, te, ts, true); break; }
        }
      }
      if (!t) return;
    }
    rows.push({
      tf, key, group, model, dir: ev.dir, hit: res.hit, R: res.R, tHit: t.hit, tR: t.R, costR: spread / frac,
      half: bars[entryIdx].t < midT ? "older" : "newer", cluster: `${tf}|${key}|${Math.floor(bars[entryIdx].t / 604800)}`,
    });
  };

  for (const ev of sweeps) {
    const s = ev.idx;
    if (s > lastIdx || !Number.isFinite(ev.atr)) continue;
    const short = ev.dir === "SHORT", A = ev.extreme, buf = 0.1 * ev.atr;
    const stopA = short ? A + buf : A - buf;
    const group = ev.levels.some((L) => L.type === "extreme") ? "top" : "other";
    const beyond = (b, p) => (short ? b.high > p : b.low < p);

    // 1. sweep only
    push(group, "sweep", ev, s, ev.close, stopA, race(bars, s + 1, ev.dir, ev.close, stopA));

    // 2. first structure break
    if (ev.ref == null) continue;
    let k = -1;
    for (let i = s + 1; i <= s + CHOCH_WIN && i < n; i++) {
      const b = bars[i];
      if (beyond(b, A)) break;
      if (short ? b.close < ev.ref && b.close < b.open : b.close > ev.ref && b.close > b.open) { k = i; break; }
    }
    if (k < 0) continue;
    if (short ? bars[k].close < stopA : bars[k].close > stopA) push(group, "choch", ev, k, bars[k].close, stopA, race(bars, k + 1, ev.dir, bars[k].close, stopA));

    // 3. lower high (higher low for longs), then a break of the low it bounced from
    let H2 = null, L2 = null, H2idx = -1;
    for (let i = k + 2; i <= k + BOS_WIN && i < n; i++) {
      const b = bars[i];
      if (beyond(b, A)) break;
      const m = i - 1;                                  // swing at m confirmed by candle i... known at i's close,
      if (m - 1 > k && m + 1 <= i) {                    // so it is used from the next candle on
        const pm = bars[m - 1], cm = bars[m], nm = bars[m + 1];
        const isSwing = short ? cm.high > pm.high && cm.high > nm.high && cm.high < A : cm.low < pm.low && cm.low < nm.low && cm.low > A;
        if (isSwing && i > m + 1 - 1) {
          let ext = short ? Infinity : -Infinity;
          for (let x = k; x <= m; x++) ext = short ? Math.min(ext, bars[x].low) : Math.max(ext, bars[x].high);
          H2 = short ? cm.high : cm.low; L2 = ext; H2idx = i;   // usable from candle i + 1
          continue;
        }
      }
      if (H2 != null && i > H2idx && (short ? b.close < L2 && b.close < b.open : b.close > L2 && b.close > b.open)) {
        const stopH = short ? H2 + buf : H2 - buf;
        if (short ? b.close < stopH : b.close > stopH) push(group, "bos", ev, i, b.close, stopH, race(bars, i + 1, ev.dir, b.close, stopH));
        break;
      }
    }

    // 4. retest of the supply (demand) zone: body of the last up (down) candle into the sweep extreme
    const aIdx = ev.twoCandle && (short ? bars[s - 1].high >= bars[s].high : bars[s - 1].low <= bars[s].low) ? s - 1 : s;
    let ob = null;
    for (let x = aIdx; x >= Math.max(0, aIdx - 5); x--) {
      const b = bars[x];
      if (short ? b.close > b.open : b.close < b.open) { ob = b; break; }
    }
    if (!ob) continue;
    const entry = short ? Math.min(ob.open, ob.close) : Math.max(ob.open, ob.close);
    const stopZ = short ? Math.max(ob.high, A) + buf : Math.min(ob.low, A) - buf;
    const ck = bars[k].close;
    if (short ? entry <= ck : entry >= ck) continue;     // needs a real retrace back up (down) to the zone
    for (let i = k + 1; i <= k + FILL_WIN && i < n; i++) {
      const b = bars[i];
      if (short ? b.high >= entry : b.low <= entry) {
        push(group, "retest", ev, i, entry, stopZ, race(bars, i, ev.dir, entry, stopZ, true),
          { decisionIdx: k, retrace: short ? (entry - ck) / ck : (ck - entry) / ck });
        break;
      }
    }
  }
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function cz(rs, f) {
  const n = rs.length;
  if (n < 2) return { m: 0, se: 0, z: 0 };
  const d = rs.map(f), m = mean(d), cl = new Map();
  rs.forEach((r, i) => cl.set(r.cluster, (cl.get(r.cluster) || 0) + d[i] - m));
  let v = 0;
  for (const x of cl.values()) v += x * x;
  const se = Math.sqrt(v) / n;
  return { m, se, z: se > 0 ? m / se : 0 };
}
const sg = (x, p = 2) => (x >= 0 ? "+" : "") + x.toFixed(p);
const flag = (z) => (Math.abs(z) >= 3 ? (z > 0 ? " ▲" : " ▼") : "  ");
function summary(rs) {
  const d = cz(rs, (x) => x.R - x.tR);
  return { n: rs.length, hit: mean(rs.map((x) => x.hit)), tHit: mean(rs.map((x) => x.tHit)), R: mean(rs.map((x) => x.R)), tR: mean(rs.map((x) => x.tR)), net: mean(rs.map((x) => x.R - x.costR)), d };
}
function line(label, rs) {
  if (rs.length < 30) return `  ${label.padEnd(40)} ${String(rs.length).padStart(6)}  (too few)`;
  const s = summary(rs);
  return `  ${label.padEnd(40)} ${String(s.n).padStart(6)}  ${(s.hit * 100).toFixed(1).padStart(5)}%  ${(s.tHit * 100).toFixed(1).padStart(5)}%   ` +
    `${sg(s.R).padStart(6)}R  ${sg(s.tR).padStart(6)}R  ${(sg(s.d.m) + " (" + sg(s.d.z, 1) + ")").padStart(14)}${flag(s.d.z)}  ${sg(s.net).padStart(6)}R`;
}
const header = `  ${"".padEnd(40)} ${"trades".padStart(6)}  ${"won".padStart(6)}  ${"random".padStart(6)}   ${"avg R".padStart(7)}  ${"random".padStart(7)}  ${"R diff (z)".padStart(14)}    ${"after spread".padStart(12)}`;

const rows = [];
for (const tfMin of [60, 30]) {
  const tf = String(tfMin);
  for (const [key, sym, , spread] of MARKETS) {
    try { const { bars } = await loadBars(sym, tf, 20000); study(bars, tf, tfMin, key, spread, rows); }
    catch (e) { console.log(`  ${key}/${tf}: ${e.message}`); }
  }
  const { bars: real } = await loadBars("FOREXCOM:EURUSD", tf, 20000);
  for (let s = 0; s < 4; s++) {
    let p = 1.1;
    const step = tfMin === 60 ? 0.0012 : 0.00085;
    const bars = real.map((rb) => {
      const o = p; let h = p, l = p;
      for (let k = 0; k < 12; k++) { p *= 1 + (step / Math.sqrt(12)) * gauss(); if (p > h) h = p; if (p < l) l = p; }
      return { t: rb.t, open: o, high: h, low: l, close: p };
    });
    study(bars, `SIM${tf}`, tfMin, `SIM${s}`, 0.00008, rows);
  }
}

const out = {};
for (const tf of ["60", "30", "SIM60", "SIM30"]) {
  const T = rows.filter((r) => r.tf === tf);
  const label = tf === "60" ? "1H candles, 16 markets" : tf === "30" ? "30m candles, 16 markets" : `FAKE random-walk markets, ${tf.slice(3)}m (must show nothing)`;
  console.log(`\n${"=".repeat(122)}\n${label}\n${header}`);
  out[tf] = {};
  for (const model of MODELS) {
    for (const group of ["top", "other"]) {
      const V = T.filter((r) => r.model === model && r.group === group);
      console.log(line(`${group === "top" ? "VERY TOP/BOTTOM" : "other sweeps   "} · ${NAMES[model]}`, V));
      if (V.length >= 2) { const s = summary(V); out[tf][`${group}_${model}`] = { n: s.n, hit: s.hit, tHit: s.tHit, R: s.R, tR: s.tR, net: s.net, dR: s.d.m, se: s.d.se, z: s.d.z }; }
      if (group === "top" && !tf.startsWith("SIM")) {
        for (const h of ["older", "newer"]) {
          const H = V.filter((r) => r.half === h);
          console.log(line(`     ${h} half`, H));
          if (H.length >= 2) out[tf][`top_${model}_${h}`] = summary(H).d;
        }
      }
    }
  }
}
console.log(`\n"won": 2R target hit before the stop within 72 candles. A random 2R trade wins about 33%.`);
console.log(`"avg R": average result per trade in risk units, before costs. z = standard errors vs random partners. ▲▼ = 3 or more.`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out, null, 2));
