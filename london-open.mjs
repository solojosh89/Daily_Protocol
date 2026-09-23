// ─────────────────────────────────────────────────────────────────────────
// THE 15 MINUTE LONDON OPEN RULE, TESTED
//
// The rule, exactly as written on the screenshot:
//   1-minute chart. At 08:00 London the candle sets the bias (close above
//   open = buy bias, below = sell bias). DO NOT enter immediately. Wait for
//   price to pull back into a liquidity zone. Enter between 08:01 and 08:14.
//   Stop below the recent low (above the recent high for sells). Target 3R.
//
// "Liquidity zone" and "recent low" are not defined on the screenshot, so
// every sensible reading is tested as its own variant. Nothing is picked
// after seeing the results: the whole grid is printed.
//
// Every trade is matched with a SAME DAY random twin: the same instrument,
// the same day, the same entry type, stop rule and target, but a signal
// candle at a random minute of the session instead of 08:00 London. That is
// the only fair control. If 08:00 London is special, the real trades must
// beat their own twins, not merely make money in a trending year.
//
//   node london-open.mjs            full grid, writes london.json
//   FAST=1 node london-open.mjs     headline variants only
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, writeFileSync, readdirSync } from "fs";

// Where the 1-minute library lives. Keep it OUTSIDE the repo: it is 160MB of
// vendor data, not source. Override with DATA_DIR to point at another copy.
const DIR = process.env.DATA_DIR || "data/m1";
const WALK_MIN = 240;            // give every trade 4 hours to resolve
const WINDOW = 14;               // 08:01 .. 08:14 inclusive
const TWINS = 1;                 // random twins per real trade
// Dealing cost per round trip, in price. Gold and Cable are quoted with a
// roughly fixed spread, Bitcoin's is a share of price (and 0.05% is kind:
// Binance spot taker fees alone are 0.2% for a round trip).
const COST = { XAUUSD: { abs: 0.25 }, GBPUSD: { abs: 0.00008 }, BTCUSD: { pct: 0.0005 }, "BTC-WKND": { pct: 0.0005 } };
const costOf = (key, price) => (COST[key].abs != null ? COST[key].abs : COST[key].pct * price);
let seed = 20260923;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// ── London 08:00 in UTC for a given date, DST aware ──────────────────────
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false });
function openAt(dateStr, hour) {
  const noon = Date.parse(dateStr + "T12:00:00Z");
  const londonHour = +fmt.format(new Date(noon));      // 12 in winter, 13 in summer
  const offset = londonHour - 12;
  return Math.floor(Date.parse(dateStr + "T00:00:00Z") / 1000) + (hour - offset) * 3600;
}
const open08 = (dateStr) => openAt(dateStr, 8);

// ── data ─────────────────────────────────────────────────────────────────
function loadInstrument(key) {
  const days = new Map();
  for (const f of readdirSync(DIR)) {
    if (!f.startsWith(key + "-") || !f.endsWith(".json")) continue;
    const obj = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
    for (const [d, rows] of Object.entries(obj)) {
      if (rows.length < 120) continue;
      const byT = new Map();
      for (const r of rows) byT.set(r[0], { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] });
      days.set(d, { byT, arr: [...byT.values()].sort((a, b) => a.t - b.t) });
    }
  }
  return days;
}

// ── the rule ─────────────────────────────────────────────────────────────
// entry variants: how "pull back into a liquidity zone" is read
const ENTRIES = {
  now: { label: "no pullback (08:01 open)", kind: "market" },
  r38: { label: "pullback 38.2% of the candle", kind: "limit", f: 0.382 },
  r50: { label: "pullback 50% of the candle", kind: "limit", f: 0.5 },
  r62: { label: "pullback 61.8% of the candle", kind: "limit", f: 0.618 },
  open: { label: "pullback to the candle open", kind: "openlimit" },
  sweep: { label: "liquidity sweep then close back", kind: "sweep" },
};
// stop variants: how "below the recent low" is read
const STOPS = { c8: "the 08:00 candle low/high", r5: "lowest low of the last 5 min", r15: "lowest low of the last 15 min" };

function tradeFrom(day, sigT, entryKey, stopKey, rr, strongOnly, fade = false) {
  const { byT, arr } = day;
  const sig = byT.get(sigT);
  if (!sig) return null;
  let dir = sig.c > sig.o ? 1 : sig.c < sig.o ? -1 : 0;
  if (!dir) return null;
  if (fade) dir = -dir;              // trade AGAINST the candle: does the bias carry anything?
  const range = sig.h - sig.l;
  if (!(range > 0)) return null;
  if (strongOnly && Math.abs(sig.c - sig.o) < 0.5 * range) return null;

  const E = ENTRIES[entryKey];
  let limit = null;
  if (E.kind === "limit") limit = dir === 1 ? sig.h - E.f * range : sig.l + E.f * range;
  if (E.kind === "openlimit") limit = sig.o;

  // index of the signal bar
  let i = arr.findIndex((b) => b.t === sigT);
  if (i < 20 || i + WINDOW + 5 >= arr.length) return null;

  // ── find the fill inside 08:01 .. 08:14 ────────────────────────────────
  let fill = null, fi = -1;
  if (E.kind === "market") {
    const b = arr[i + 1];
    if (b && b.t === sigT + 60) { fill = b.o; fi = i + 1; }
  } else if (E.kind === "sweep") {
    for (let k = i + 1; k <= i + WINDOW; k++) {
      const b = arr[k];
      if (!b || b.t !== sigT + (k - i) * 60) break;
      const prev = arr.slice(k - 3, k);
      if (prev.length < 3) break;
      if (dir === 1) {
        const pl = Math.min(...prev.map((x) => x.l));
        if (b.l < pl && b.c > pl) { fill = b.c; fi = k; break; }
      } else {
        const ph = Math.max(...prev.map((x) => x.h));
        if (b.h > ph && b.c < ph) { fill = b.c; fi = k; break; }
      }
    }
  } else {
    for (let k = i + 1; k <= i + WINDOW; k++) {
      const b = arr[k];
      if (!b || b.t !== sigT + (k - i) * 60) break;
      if (dir === 1 ? b.l <= limit : b.h >= limit) { fill = limit; fi = k; break; }
    }
  }
  if (fill == null) return { filled: false };

  // ── stop, risk, target ────────────────────────────────────────────────
  let stop;
  if (stopKey === "c8") stop = dir === 1 ? sig.l : sig.h;
  else {
    const n = stopKey === "r5" ? 5 : 15;
    const win = arr.slice(Math.max(0, fi - n + 1), fi + 1);
    stop = dir === 1 ? Math.min(...win.map((b) => b.l)) : Math.max(...win.map((b) => b.h));
  }
  const risk = dir === 1 ? fill - stop : stop - fill;
  if (!(risk > 0)) return { filled: false };
  const target = dir === 1 ? fill + rr * risk : fill - rr * risk;

  // ── walk it out, stop first if both touch in the same minute ──────────
  for (let k = fi; k < Math.min(arr.length, fi + WALK_MIN); k++) {
    const b = arr[k];
    if (k > fi && b.t !== arr[k - 1].t + 60 && b.t - arr[k - 1].t > 600) break;   // long data gap
    const hitStop = dir === 1 ? b.l <= stop : b.h >= stop;
    const hitTgt = dir === 1 ? b.h >= target : b.l <= target;
    if (k === fi && E.kind !== "market" && E.kind !== "sweep") {
      // the fill happened inside this bar; only count a stop on it
      if (hitStop) return { filled: true, r: -1, risk, fill, dir, mins: 0 };
      continue;
    }
    if (hitStop) return { filled: true, r: -1, risk, fill, dir, mins: k - fi };
    if (hitTgt) return { filled: true, r: rr, risk, fill, dir, mins: k - fi };
  }
  return { filled: true, r: null, risk, fill, dir, mins: WALK_MIN };      // unresolved
}

// ── run ──────────────────────────────────────────────────────────────────
const fast = !!process.env.FAST;
const entryKeys = fast ? ["now", "r50", "sweep"] : Object.keys(ENTRIES);
const stopKeys = fast ? ["c8"] : Object.keys(STOPS);
const present = ["XAUUSD", "GBPUSD", "BTCUSD"].filter((k) => readdirSync(DIR).some((f) => f.startsWith(k + "-")));
// Bitcoin also trades at weekends, when London is shut. Running the identical
// rule on Saturdays and Sundays is a free falsification test: if 08:00 London
// matters, the weekend book should be worse than the weekday book.
const books = [];
for (const k of present) {
  const days = loadInstrument(k);
  if (k === "BTCUSD") {
    const wd = new Map(), we = new Map();
    for (const [d, v] of days) (new Date(d + "T00:00:00Z").getUTCDay() % 6 === 0 ? we : wd).set(d, v);
    books.push({ key: "BTCUSD", days: wd });
    books.push({ key: "BTC-WKND", days: we });
  } else books.push({ key: k, days });
}
const instruments = books.map((b) => b.key);

const results = [];
const hourly = [];
const perInst = {};

for (const { key, days } of books) {
  const dates = [...days.keys()].sort();
  if (!dates.length) continue;
  perInst[key] = { days: dates.length, first: dates[0], last: dates[dates.length - 1] };

  for (const entryKey of entryKeys) {
    for (const stopKey of stopKeys) {
      for (const strong of [false, true]) {
        const headline = stopKey === "c8" && !strong && (entryKey === "now" || entryKey === "r50");
        for (const [rr, fade] of (entryKey === "r50" && stopKey === "c8" && !strong
          ? [[1, false], [2, false], [3, false], [3, true]]
          : headline ? [[3, false], [3, true]] : [[3, false]])) {
          const rows = [];
          let tooTight = 0;
          // A stop smaller than twice the dealing cost is not a trade anybody
          // can take, so it is dropped from BOTH books, real and twin, before
          // anything is measured. Without this, one random minute with a
          // two-cent stop swamps a whole year of results.
          const usable = (t) => t && t.filled && t.risk >= 2 * costOf(key, t.fill);
          for (const d of dates) {
            const day = days.get(d);
            const sigT = open08(d);
            const real = tradeFrom(day, sigT, entryKey, stopKey, rr, strong, fade);
            if (!real) continue;
            if (!real.filled) { rows.push({ d, nofill: true }); continue; }
            if (!usable(real)) { tooTight++; continue; }

            // same day random twin, same order type, away from the open
            let twin = null;
            for (let a = 0; a < 12 && !twin; a++) {
              const b = day.arr[20 + Math.floor(rnd() * Math.max(1, day.arr.length - 300))];
              if (!b) continue;
              if (Math.abs(b.t - sigT) < 2400) continue;              // keep clear of 08:00
              const t = tradeFrom(day, b.t, entryKey, stopKey, rr, strong, fade);
              if (usable(t)) twin = t;
            }
            rows.push({ d, real, twin });
          }

          const filled = rows.filter((r) => r.real && r.real.r != null);
          const paired = filled.filter((r) => r.twin && r.twin.r != null);
          if (filled.length < 60) continue;
          const cost = (t) => costOf(key, t.fill) / t.risk;
          const netR = (t) => t.r - cost(t);
          const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
          const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
          // Cluster-robust standard error: trades in the same calendar week
          // share the same weather, so they are not independent observations.
          const week = (d) => { const t = Date.parse(d + "T00:00:00Z") / 86400000; return Math.floor((t + 4) / 7); };
          function zOf(pairs, f) {
            if (pairs.length < 30) return NaN;
            const ds = pairs.map(([a, b]) => f(a) - f(b));
            const m = mean(ds), n = ds.length;
            const g = new Map();
            pairs.forEach(([, , d], i) => g.set(week(d), (g.get(week(d)) || 0) + (ds[i] - m)));
            const v = [...g.values()].reduce((s, x) => s + x * x, 0) / (n * n);
            return v > 0 ? m / Math.sqrt(v) : NaN;
          }
          const pairs = paired.map((r) => [r.real, r.twin, r.d]);
          const wins = filled.filter((r) => r.real.r > 0).length;
          const mid = Math.floor(filled.length / 2);
          const half = (a) => (a.length > 20 ? mean(a.map((r) => netR(r.real))) : NaN);

          results.push({
            inst: key, entry: entryKey, stop: stopKey, rr, strong, fade,
            signals: rows.length + tooTight, fills: filled.length, tooTight,
            unplayablePct: tooTight / Math.max(1, rows.length + tooTight),
            noFillPct: rows.filter((r) => r.nofill).length / Math.max(1, rows.length),
            unresolved: rows.filter((r) => r.real && r.real.r == null).length,
            winPct: wins / filled.length,
            twinWinPct: paired.length ? paired.filter((r) => r.twin.r > 0).length / paired.length : NaN,
            needPct: 1 / (1 + rr),
            grossR: mean(filled.map((r) => r.real.r)),
            netR: mean(filled.map((r) => netR(r.real))),
            costR: mean(filled.map((r) => cost(r.real))),
            twinGrossR: paired.length ? mean(paired.map((r) => r.twin.r)) : NaN,
            twinNetR: paired.length ? mean(paired.map((r) => netR(r.twin))) : NaN,
            diff: pairs.length ? mean(pairs.map(([a, b]) => netR(a) - netR(b))) : NaN,
            z: zOf(pairs, netR),
            zGross: zOf(pairs, (t) => t.r),
            oldHalf: half(filled.slice(0, mid)),
            newHalf: half(filled.slice(mid)),
            medRisk: med(filled.map((r) => r.real.risk)),
            medRiskPct: med(filled.map((r) => r.real.risk / r.real.fill)),
            medMins: med(filled.map((r) => r.real.mins)),
          });
        }
      }
    }
  }
  // ── is 08:00 special? run the same rule at every other hour of the session
  // 06:00 to 13:00 London only: the data window ends at 17:00 UTC, so a later
  // start would give its trades less room to resolve and quietly bias the row.
  for (let hr = 6; hr <= 13; hr++) {
    const book = [];
    for (const d of dates) {
      const day = days.get(d);
      const t = tradeFrom(day, openAt(d, hr), "r50", "c8", 3, false);
      if (t && t.filled && t.r != null && t.risk >= 2 * costOf(key, t.fill)) book.push(t);
    }
    if (book.length < 60) continue;
    const m = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    hourly.push({
      inst: key, hour: hr, fills: book.length,
      winPct: book.filter((t) => t.r > 0).length / book.length,
      grossR: m(book.map((t) => t.r)),
      netR: m(book.map((t) => t.r - costOf(key, t.fill) / t.risk)),
    });
  }
  console.log(`${key}: ${dates.length} days ${dates[0]} -> ${dates[dates.length - 1]}`);
}

// ── hand check: print real trades so they can be found on a chart ────────
{
  const key = (process.env.VERIFY || (books.some((b) => b.key === "XAUUSD") ? "XAUUSD" : books[0].key)).toUpperCase();
  const book = books.find((b) => b.key === key);
  const lon = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false });
  if (book) {
    const dates = [...book.days.keys()].sort().slice(-400);
    const out = [];
    let dropped = 0;
    for (const d of dates) {
      const day = book.days.get(d), sigT = open08(d);
      const sig = day.byT.get(sigT);
      const t = tradeFrom(day, sigT, "r50", "c8", 3, false);
      if (!sig || !t || !t.filled || t.r == null) continue;
      if (t.risk < 2 * costOf(key, t.fill)) { dropped++; continue; }   // same filter the stats use
      out.push({ d, lon: lon.format(new Date(sigT * 1000)), utc: new Date(sigT * 1000).toISOString().slice(11, 16),
        dir: t.dir === 1 ? "BUY" : "SELL", sigO: sig.o, sigC: sig.c, entry: t.fill,
        stop: t.dir === 1 ? t.fill - t.risk : t.fill + t.risk, tgt: t.dir === 1 ? t.fill + 3 * t.risk : t.fill - 3 * t.risk,
        out: t.r > 0 ? "WIN" : "loss", mins: t.mins });
    }
    console.log(`\n${"=".repeat(132)}\nHAND CHECK ${key}: last 12 trades of the headline reading (50% pullback, stop at the 08:00 candle low/high, 3R)`);
    console.log(`  ${"date".padEnd(12)} ${"08:00 LON".padEnd(10)} ${"=UTC".padEnd(6)} ${"side".padEnd(5)} ${"candle O->C".padEnd(22)} ${"entry".padStart(10)} ${"stop".padStart(10)} ${"target".padStart(10)} ${"result".padStart(7)} ${"mins".padStart(5)}`);
    for (const e of out.slice(-12))
      console.log(`  ${e.d.padEnd(12)} ${e.lon.padEnd(10)} ${e.utc.padEnd(6)} ${e.dir.padEnd(5)} ${(e.sigO.toFixed(2) + " -> " + e.sigC.toFixed(2)).padEnd(22)} ${e.entry.toFixed(2).padStart(10)} ${e.stop.toFixed(2).padStart(10)} ${e.tgt.toFixed(2).padStart(10)} ${e.out.padStart(7)} ${String(e.mins).padStart(5)}`);
    const w = out.filter((e) => e.out === "WIN").length;
    console.log(`  those ${out.length} trades: ${w} wins, ${out.length - w} losses (${((w / out.length) * 100).toFixed(1)}%), break even at 25.0% before costs`);
    console.log(`  a further ${dropped} days were skipped because the stop was smaller than twice the dealing cost`);
    const dp = key === "GBPUSD" ? 5 : 2;
    writeFileSync("examples.json", JSON.stringify({
      inst: key, total: out.length, wins: w, dropped,
      rows: out.slice(-12).map((e) => ({ d: e.d, utc: e.utc, dir: e.dir, entry: e.entry.toFixed(dp), stop: e.stop.toFixed(dp), tgt: e.tgt.toFixed(dp), out: e.out, mins: e.mins })),
    }, null, 1));
  }
}

// ── print ────────────────────────────────────────────────────────────────
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "n/a");
const sg = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(3) : "n/a");
const line = "=".repeat(132);

const pct2 = (x) => (Number.isFinite(x) ? (x * 100).toFixed(2) + "%" : "n/a");
for (const key of instruments) {
  const R = results.filter((r) => r.inst === key && r.rr === 3 && !r.fade);
  if (!R.length) continue;
  const c = COST[key];
  console.log(`\n${line}\n${key}  ${perInst[key].first} to ${perInst[key].last}, ${perInst[key].days} sessions, cost ${c.abs != null ? c.abs : (c.pct * 100).toFixed(3) + "% of price"}`);
  console.log(`  ${"entry".padEnd(26)} ${"stop".padEnd(22)} ${"str".padEnd(4)} ${"fills".padStart(6)} ${"dead".padStart(6)} ${"nofill".padStart(7)} ${"stopsz".padStart(7)} ${"win".padStart(6)} ${"twin w".padStart(7)} ${"need".padStart(6)} ${"gross".padStart(8)} ${"cost".padStart(6)} ${"NET".padStart(8)} ${"twinNET".padStart(8)} ${"diff".padStart(8)} ${"z net".padStart(6)} ${"z gross".padStart(7)}`);
  for (const r of R) {
    console.log(`  ${ENTRIES[r.entry].label.padEnd(26)} ${STOPS[r.stop].padEnd(22)} ${(r.strong ? "yes" : "-").padEnd(4)} ${String(r.fills).padStart(6)} ${pct(r.unplayablePct).padStart(6)} ${pct(r.noFillPct).padStart(7)} ${pct2(r.medRiskPct).padStart(7)} ${pct(r.winPct).padStart(6)} ${pct(r.twinWinPct).padStart(7)} ${pct(r.needPct).padStart(6)} ${sg(r.grossR).padStart(8)} ${r.costR.toFixed(2).padStart(6)} ${sg(r.netR).padStart(8)} ${sg(r.twinNetR).padStart(8)} ${sg(r.diff).padStart(8)} ${(Number.isFinite(r.z) ? r.z.toFixed(2) : "n/a").padStart(6)} ${(Number.isFinite(r.zGross) ? r.zGross.toFixed(2) : "n/a").padStart(7)}`);
  }
}

const fades = results.filter((r) => r.fade);
if (fades.length) {
  console.log(`\n${line}\nDOES THE 08:00 CANDLE POINT ANYWHERE? Same rule, traded the OTHER way. If the bias carries information, fading it must be clearly worse.`);
  console.log(`  ${"inst".padEnd(10)} ${"entry".padEnd(26)} ${"follow NET".padStart(11)} ${"fade NET".padStart(10)} ${"follow win".padStart(11)} ${"fade win".padStart(9)}`);
  for (const f of fades) {
    const follow = results.find((r) => r.inst === f.inst && r.entry === f.entry && r.stop === f.stop && r.rr === f.rr && r.strong === f.strong && !r.fade);
    if (!follow) continue;
    console.log(`  ${f.inst.padEnd(10)} ${ENTRIES[f.entry].label.padEnd(26)} ${sg(follow.netR).padStart(11)} ${sg(f.netR).padStart(10)} ${pct(follow.winPct).padStart(11)} ${pct(f.winPct).padStart(9)}`);
  }
}

const rrRows = results.filter((r) => r.rr !== 3 && !r.fade);
if (rrRows.length) {
  console.log(`\n${line}\nTARGET SIZE, using the 50% pullback and the 08:00 candle stop`);
  console.log(`  ${"inst".padEnd(8)} ${"target".padStart(7)} ${"fills".padStart(6)} ${"win".padStart(7)} ${"need".padStart(6)} ${"gross".padStart(8)} ${"NET".padStart(8)} ${"twin".padStart(8)}`);
  for (const r of [...rrRows, ...results.filter((r) => r.rr === 3 && r.entry === "r50" && r.stop === "c8" && !r.strong && !r.fade)].sort((a, b) => a.inst.localeCompare(b.inst) || a.rr - b.rr))
    console.log(`  ${r.inst.padEnd(8)} ${(r.rr + "R").padStart(7)} ${String(r.fills).padStart(6)} ${pct(r.winPct).padStart(7)} ${pct(r.needPct).padStart(6)} ${sg(r.grossR).padStart(8)} ${sg(r.netR).padStart(8)} ${sg(r.twinNetR).padStart(8)}`);
}

console.log(`\n${line}\nHALVES, 3R only: does anything survive out of sample?`);
console.log(`  ${"inst".padEnd(8)} ${"entry".padEnd(26)} ${"stop".padEnd(22)} ${"older half".padStart(11)} ${"newer half".padStart(11)}`);
for (const r of results.filter((x) => x.rr === 3 && !x.strong && !x.fade))
  console.log(`  ${r.inst.padEnd(8)} ${ENTRIES[r.entry].label.padEnd(26)} ${STOPS[r.stop].padEnd(22)} ${sg(r.oldHalf).padStart(11)} ${sg(r.newHalf).padStart(11)}`);

console.log(`\n${line}\nTHE SAME RULE AT EVERY OTHER HOUR OF THE SESSION (50% pullback, 08:00 style stop, 3R)`);
console.log(`  ${"inst".padEnd(10)} ${"London hr".padStart(9)} ${"trades".padStart(7)} ${"win".padStart(7)} ${"gross".padStart(8)} ${"NET".padStart(8)}`);
for (const h of hourly)
  console.log(`  ${h.inst.padEnd(10)} ${(String(h.hour).padStart(2, "0") + ":00").padStart(9)} ${String(h.fills).padStart(7)} ${pct(h.winPct).padStart(7)} ${sg(h.grossR).padStart(8)} ${sg(h.netR).padStart(8)}${h.hour === 8 ? "   <- the rule" : ""}`);

writeFileSync("london.json", JSON.stringify({ built: new Date().toISOString(), perInst, cost: COST, walkMin: WALK_MIN, window: WINDOW, results, hourly }, null, 1));
console.log(`\nstop = the median stop distance as a share of price. win = share of filled trades that reached the target.`);
console.log(`need = the win rate that breaks even at that target. cost = dealing cost as a share of the stop, per trade.`);
console.log(`NET = per trade R after that cost. twin = the same rule, same days, signal candle at a random minute instead of 08:00.`);
console.log(`z net / z gross = the real minus twin difference in standard errors, clustered by calendar week.`);
console.log(`\nwrote london.json`);
