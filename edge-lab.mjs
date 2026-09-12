// ─────────────────────────────────────────────────────────────────────────
// EDGE LAB — three edges with decades of published evidence, re-tested on 16
// markets and 20 to 29 years of daily candles, with costs and placebos.
//
//   trend        every week, long the markets that rose over the past 3, 6 and
//                12 months, short the ones that fell, each sized to the same
//                risk (Moskowitz, Ooi & Pedersen, 2012). 2013 onward is after
//                the paper, so it is a real out-of-sample check.
//   calm-size    hold stock indices, sized up after calm months and down after
//                stormy ones (Moreira & Muir, 2017). 2017 onward is after the paper.
//   month-turn   hold stock indices only on the last trading day of the month
//                and the first three of the next (Ariel 1987; Lakonishok &
//                Smidt 1988). Every year of this data is after those papers.
//
// Placebos, fixed before running:
//   trend        re-run 200 times on the same returns with each day's up/down
//                sign flipped at random. Real volatility stays, direction dies.
//   calm-size    re-run 200 times with the same monthly sizes shuffled in time.
//   month-turn   compared with every other 4-day window around the month end.
//
//   node edge-lab.mjs                  downloads candles
//   DATA_DIR=folder node edge-lab.mjs  uses cached candles
//   OUT=lab.json node edge-lab.mjs     also writes curves and tables as JSON
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "fs";
import { MARKETS, loadBars, dayKey } from "./research-markets.mjs";

const Y = 261;                         // trading days per year
const TARGET = 0.10;                   // each trend sleeve aims for 10% yearly volatility
const CAP = 4;                         // never more than 4x a market's price exposure
const LOOKS = [63, 126, 252];          // 3, 6 and 12 months
const FIN = 0.03;                      // pessimistic CFD overnight financing, per year of exposure
const INDICES = ["NAS100", "SPX500", "US30", "UK100", "JP225"];
const PLACEBOS = Number(process.env.PLACEBOS || 200);

let seed = 424242;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

const M = [];
for (const [key, sym, cls, spread] of MARKETS) {
  try {
    const { bars } = await loadBars(sym, "1D", 8000);   // already one candle per trading day
    const dates = bars.map((b) => dayKey(b.t));
    const r = bars.map((b, i) => (i ? b.close / bars[i - 1].close - 1 : 0));
    M.push({ key, cls, spread, dates, r });
  } catch (e) { console.log(`  ${key}: ${e.message}`); }
}
console.log(`Loaded ${M.length} markets: ${M.map((m) => `${m.key} ${m.dates[0].slice(0, 4)}`).join(" · ")}`);

// ── helpers ──────────────────────────────────────────────────────────────
function portfolio(parts) {
  const map = new Map();
  for (const p of parts) for (let i = 0; i < p.dates.length; i++) if (p.on[i]) {
    const e = map.get(p.dates[i]) || [0, 0];
    e[0] += p.series[i]; e[1]++;
    map.set(p.dates[i], e);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, [s, c]]) => ({ d, r: s / c }));
}
function stats(series, from = "0000", to = "9999") {
  const x = series.filter((p) => p.d >= from && p.d < to).map((p) => p.r);
  const n = x.length;
  if (n < 120) return null;
  const m = x.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const sharpe = (m / sd) * Math.sqrt(Y);
  const k = TARGET / (sd * Math.sqrt(Y));              // rescale to 10% volatility so drawdowns compare
  let eq = 1, peak = 1, dd = 0;
  for (const r of x) { eq *= 1 + k * r; if (eq > peak) peak = eq; dd = Math.min(dd, eq / peak - 1); }
  return { years: n / Y, sharpe, t: sharpe * Math.sqrt(n / Y), cagr: Math.pow(eq, Y / n) - 1, dd };
}
function curve(series, k) {
  const pts = []; let eq = 1;
  for (let i = 0; i < series.length; i++) {
    eq *= 1 + k * series[i].r;
    const mo = series[i].d.slice(0, 7);
    if (i === series.length - 1 || series[i + 1].d.slice(0, 7) !== mo) pts.push([mo, +eq.toFixed(4)]);
  }
  return pts;
}
const volOf = (series) => { const x = series.map((p) => p.r), m = x.reduce((a, b) => a + b, 0) / x.length; return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1)) * Math.sqrt(Y); };
const pval = (dist, real) => (dist.filter((x) => x >= real).length + 1) / (dist.length + 1);
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const f2 = (x) => (x == null ? "  -  " : (x >= 0 ? "+" : "") + x.toFixed(2));
const pc = (x) => (x == null ? "  -  " : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%");
function statLine(label, s) {
  if (!s) return `  ${label.padEnd(34)} (not enough data)`;
  return `  ${label.padEnd(34)} ${s.years.toFixed(1).padStart(5)} yrs   Sharpe ${f2(s.sharpe).padStart(5)}   t ${f2(s.t).padStart(5)}   per year at 10% risk ${pc(s.cagr).padStart(7)}   worst drop ${pc(s.dd).padStart(7)}`;
}
const out = {};

// ── 1. TREND ─────────────────────────────────────────────────────────────
export function trend(r, spread, fin = 0) {
  const n = r.length, gross = new Float64Array(n), net = new Float64Array(n), on = new Uint8Array(n);
  const px = new Float64Array(n); px[0] = 1;
  for (let i = 1; i < n; i++) px[i] = px[i - 1] * (1 + r[i]);
  const a = 1 / 61;                                    // volatility: exponential average, 60-day centre of mass
  let v = 0; for (let i = 1; i <= 20; i++) v += r[i] * r[i]; v /= 20;
  let prev = 0;
  for (let i = 1; i < n - 1; i++) {
    v = (1 - a) * v + a * r[i] * r[i];                 // uses returns up to today's close only
    let w = prev;
    if (i >= 260 && i % 5 === 0) {                     // weekly rebalance
      let sig = 0;
      for (const L of LOOKS) sig += Math.sign(px[i] / px[i - L] - 1);
      const vol = Math.sqrt(v * Y);
      w = vol > 0 ? Math.max(-CAP, Math.min(CAP, ((sig / LOOKS.length) * TARGET) / vol)) : 0;
    }
    if (i >= 260) {
      gross[i + 1] = w * r[i + 1];                     // position set at today's close earns tomorrow's move
      net[i + 1] = gross[i + 1] - spread * Math.abs(w - prev) - (fin / Y) * Math.abs(w);
      on[i + 1] = 1;
    }
    prev = w;
  }
  return { gross, net, on };
}
{
  const runs = M.map((m) => ({ m, g: trend(m.r, m.spread), f: trend(m.r, m.spread, FIN) }));
  const G = portfolio(runs.map(({ m, g }) => ({ dates: m.dates, series: g.gross, on: g.on })));
  const N = portfolio(runs.map(({ m, g }) => ({ dates: m.dates, series: g.net, on: g.on })));
  const F = portfolio(runs.map(({ m, f }) => ({ dates: m.dates, series: f.net, on: f.on })));
  const periods = [["all years", "0000", "9999"], ["before 2013 (the paper's era)", "0000", "2013"], ["2013 onward (after the paper)", "2013", "9999"], ["last 5 years", "2021-09", "9999"]];
  console.log(`\n${"=".repeat(120)}\n1. TREND: 16 markets, long what rose over 3/6/12 months, short what fell, weekly\n`);
  for (const [lab, a, b] of periods) {
    console.log(statLine(`${lab}, before costs`, stats(G, a, b)));
    console.log(statLine(`${lab}, after spreads`, stats(N, a, b)));
    console.log(statLine(`${lab}, spreads + 3% financing`, stats(F, a, b)));
  }
  const pAll = [], pAfter = [];
  for (let p = 0; p < PLACEBOS; p++) {
    const S = portfolio(M.map((m) => { const fr = m.r.map((x, i) => (i && rnd() < 0.5 ? -x : x)); const t = trend(fr, m.spread); return { dates: m.dates, series: t.gross, on: t.on }; }));
    pAll.push(stats(S).sharpe); pAfter.push(stats(S, "2013").sharpe);
  }
  const sAll = stats(G).sharpe, sAfter = stats(G, "2013").sharpe;
  const top = (d) => d.slice().sort((x, y) => x - y)[Math.floor(d.length * 0.95)];
  console.log(`\n  PLACEBO (${PLACEBOS} runs, same returns, random up/down): best 5% of placebos reach Sharpe ${f2(top(pAll))} (all years), ${f2(top(pAfter))} (2013+)`);
  console.log(`  real trend: Sharpe ${f2(sAll)} → placebo p = ${pval(pAll, sAll).toFixed(3)}   ·   2013+: ${f2(sAfter)} → p = ${pval(pAfter, sAfter).toFixed(3)}`);
  console.log(`\n  by asset class (before costs)`);
  for (const c of ["metal", "index", "fx"]) {
    const S = portfolio(runs.filter(({ m }) => m.cls === c).map(({ m, g }) => ({ dates: m.dates, series: g.gross, on: g.on })));
    console.log(statLine(`   ${c}, all years`, stats(S)));
    console.log(statLine(`   ${c}, 2013 onward`, stats(S, "2013")));
  }
  console.log(`\n  by market (before costs): Sharpe all years / 2013 onward`);
  const per = runs.map(({ m, g }) => { const s = portfolio([{ dates: m.dates, series: g.gross, on: g.on }]); return [m.key, stats(s)?.sharpe, stats(s, "2013")?.sharpe]; });
  console.log("  " + per.map(([k, a, b]) => `${k} ${f2(a)}/${f2(b)}`).join("  ·  "));
  out.trend = {
    stats: Object.fromEntries(periods.map(([lab, a, b]) => [lab, { gross: stats(G, a, b), net: stats(N, a, b), fin: stats(F, a, b) }])),
    curveGross: curve(G, TARGET / volOf(G)), curveNet: curve(N, TARGET / volOf(G)),
    placebo: { all: pAll, after: pAfter, pAll: pval(pAll, sAll), pAfter: pval(pAfter, sAfter) },
    perMarket: per,
  };
}

// ── 2. CALM-SIZE ─────────────────────────────────────────────────────────
function calm(m, order = null) {
  const { r, dates, spread } = m, n = r.length;
  const ends = [];
  for (let i = 21; i < n - 1; i++) if (dates[i].slice(0, 7) !== dates[i + 1].slice(0, 7)) {
    let v = 0; for (let k = i - 20; k <= i; k++) v += r[k] * r[k];
    ends.push({ i, raw: 21 / Math.max(v, 1e-12) });   // 1 / average squared daily return, last 21 days
  }
  const raws = order ? order(ends.map((e) => e.raw)) : ends.map((e) => e.raw);
  const c = raws.length / raws.reduce((a, b) => a + b, 0);   // average size = 1 (a scale constant, no timing)
  const bh = new Float64Array(n), mg = new Float64Array(n), on = new Uint8Array(n);
  let prev = 0, sumW = 0;
  for (let k = 0; k < ends.length; k++) {
    const w = Math.min(3, c * raws[k]);
    const start = ends[k].i, end = k + 1 < ends.length ? ends[k + 1].i : n - 1;
    for (let i = start + 1; i <= end; i++) { bh[i] = r[i]; mg[i] = w * r[i]; on[i] = 1; }
    mg[start + 1] -= spread * Math.abs(w - prev);
    prev = w; sumW += w;
  }
  return { bh, mg, on, avgW: sumW / ends.length };
}
{
  const idx = M.filter((m) => INDICES.includes(m.key));
  const runs = idx.map((m) => ({ m, c: calm(m) }));
  const BH = portfolio(runs.map(({ m, c }) => ({ dates: m.dates, series: c.bh, on: c.on })));
  const MG = portfolio(runs.map(({ m, c }) => ({ dates: m.dates, series: c.mg, on: c.on })));
  const periods = [["all years", "0000", "9999"], ["before 2017 (the paper's era)", "0000", "2017"], ["2017 onward (after the paper)", "2017", "9999"]];
  console.log(`\n${"=".repeat(120)}\n2. CALM-SIZE: 5 stock indices, size = 1 / last month's volatility², average size 1, monthly\n`);
  for (const [lab, a, b] of periods) {
    console.log(statLine(`${lab}, just hold`, stats(BH, a, b)));
    console.log(statLine(`${lab}, calm-size (after spreads)`, stats(MG, a, b)));
  }
  const pAll = [], pAfter = [];
  for (let p = 0; p < PLACEBOS; p++) {
    const S = portfolio(idx.map((m) => { const c = calm(m, shuffle); return { dates: m.dates, series: c.mg, on: c.on }; }));
    pAll.push(stats(S).sharpe); pAfter.push(stats(S, "2017").sharpe);
  }
  const sAll = stats(MG).sharpe, sAfter = stats(MG, "2017").sharpe;
  console.log(`\n  PLACEBO (${PLACEBOS} runs, same sizes shuffled across months): calm-size Sharpe ${f2(sAll)} → p = ${pval(pAll, sAll).toFixed(3)}   ·   2017+: ${f2(sAfter)} → p = ${pval(pAfter, sAfter).toFixed(3)}`);
  console.log(`  by index, Sharpe hold → calm-size (all years):  ` + runs.map(({ m, c }) => {
    const a = stats(portfolio([{ dates: m.dates, series: c.bh, on: c.on }])), b = stats(portfolio([{ dates: m.dates, series: c.mg, on: c.on }]));
    return `${m.key} ${f2(a?.sharpe)}→${f2(b?.sharpe)} (avg size ${c.avgW.toFixed(2)})`;
  }).join("  ·  "));
  out.calm = {
    stats: Object.fromEntries(periods.map(([lab, a, b]) => [lab, { hold: stats(BH, a, b), calm: stats(MG, a, b) }])),
    curveHold: curve(BH, TARGET / volOf(BH)), curveCalm: curve(MG, TARGET / volOf(MG)),
    placebo: { all: pAll, after: pAfter, pAll: pval(pAll, sAll), pAfter: pval(pAfter, sAfter) },
  };
}

// ── 3. MONTH-TURN ────────────────────────────────────────────────────────
// position in the month: 1..10 from the start, -10..-1 from the end, else null.
// The first and last month of each history are partial, so they are skipped.
function monthPos(dates) {
  const n = dates.length, pos = new Array(n).fill(null), starts = [0];
  for (let i = 1; i < n; i++) if (dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7)) starts.push(i);
  starts.push(n);
  for (let s = 1; s < starts.length - 2; s++) {
    const a = starts[s], b = starts[s + 1];
    for (let k = a; k < b; k++) { const f = k - a + 1, back = k - b; pos[k] = f <= 10 ? f : back >= -10 ? back : null; }
  }
  return pos;
}
{
  const SEQ = [-10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const idx = M.filter((m) => INDICES.includes(m.key));
  const cells = new Map(SEQ.map((p) => [p, []]));
  const parts = [], hold = [];
  for (const m of idx) {
    const pos = monthPos(m.dates);
    const sd = Math.sqrt(m.r.reduce((a, b) => a + b * b, 0) / m.r.length);
    const tom = new Float64Array(m.r.length), bh = new Float64Array(m.r.length), on = new Uint8Array(m.r.length);
    for (let i = 1; i < m.r.length; i++) {
      if (pos[i] == null) continue;
      cells.get(pos[i]).push({ z: m.r[i] / sd, d: m.dates[i] });
      const inTom = pos[i] === -1 || (pos[i] >= 1 && pos[i] <= 3);
      tom[i] = inTom ? m.r[i] : 0;
      if (pos[i] === -1) tom[i] -= m.spread;            // buy the day before, sell after day 3: one spread a month
      bh[i] = m.r[i]; on[i] = 1;
    }
    parts.push({ dates: m.dates, series: tom, on }); hold.push({ dates: m.dates, series: bh, on });
  }
  const windows = [];
  for (let s = 0; s + 4 <= SEQ.length; s++) {
    const ps = SEQ.slice(s, s + 4), xs = ps.flatMap((p) => cells.get(p).map((c) => c.z));
    const m = xs.reduce((a, b) => a + b, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    windows.push({ label: ps.join(","), mean: m, t: m / (sd / Math.sqrt(xs.length)), tom: ps.join(",") === "-1,1,2,3" });
  }
  const TOM = portfolio(parts), BH = portfolio(hold);
  console.log(`\n${"=".repeat(120)}\n3. MONTH-TURN: 5 stock indices, in the market only on the last day of the month and the first 3 days\n`);
  for (const [lab, a, b] of [["all years", "0000", "9999"], ["before 2012", "0000", "2012"], ["2012 onward", "2012", "9999"]]) {
    console.log(statLine(`${lab}, just hold`, stats(BH, a, b)));
    console.log(statLine(`${lab}, month-turn only (after spreads)`, stats(TOM, a, b)));
  }
  const ranked = windows.slice().sort((a, b) => b.mean - a.mean);
  console.log(`\n  every 4-day window around the month end, average daily move in volatility units (t):`);
  for (const w of windows) console.log(`   ${w.label.padEnd(14)} ${f2(w.mean * 100).padStart(6)}% of a normal day  t ${f2(w.t)}${w.tom ? "   ← month-turn" : ""}`);
  console.log(`  month-turn ranks ${ranked.findIndex((w) => w.tom) + 1} of ${windows.length} windows`);
  out.tom = { windows, stats: { hold: stats(BH), tom: stats(TOM), tomNew: stats(TOM, "2012"), holdNew: stats(BH, "2012") }, rank: ranked.findIndex((w) => w.tom) + 1 };
}

console.log(`\nSharpe = yearly return ÷ yearly volatility (above 0.5 is good for a real strategy). t above 3 = very unlikely to be luck.`);
console.log(`p = share of placebo runs that did at least as well. Under 0.05 = the real version beat nearly every fake one.`);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(out));
