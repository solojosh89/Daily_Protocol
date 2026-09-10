// ─────────────────────────────────────────────────────────────────────────
// REGRESSION SUITE — run with:  node test.mjs
//
// Pure logic only: no network, no Telegram, no files. Runs in milliseconds so
// there's no excuse to skip it before a deploy.
//
// Every case here is a bug that actually shipped, or an invariant that was
// verified once by hand and must never silently drift. The detection rules
// changed five times in two days; this is what stops the sixth change from
// quietly breaking the fifth.
// ─────────────────────────────────────────────────────────────────────────
import { recordSetup, resolveOpen, agg, slice } from "./paper.mjs";
import { decide, matchesFilters, todayR, openCount, execStats } from "./exec.mjs";
import { detectSweep } from "./detector.mjs";
import { detectSOLFib } from "./solfib.mjs";
import { detectOTE } from "./ote.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? "  → " + extra : ""}`); }
};
const group = (n) => console.log(`\n${n}`);

// ── paper book ───────────────────────────────────────────────────────────
group("paper book");
{
  const book = { seq: 1, rows: [] };
  const base = { instKey: "V75", level: 0.618, dir: "SHORT", entry: 100, stop: 110, target: 80, source: "solfib" };
  const ep = 1783000800;
  const a = recordSetup(book, { ...base, tf: 15, setupId: `SOLFIB:SHORT:${ep}` });
  const b = recordSetup(book, { ...base, tf: 60, setupId: `SOLFIB:SHORT:${ep}` });
  // SHIPPED BUG: key lacked tf, so a 1H setup sharing a bar epoch with a 15m
  // one was dropped — corrupting the tf-vs-tf comparison the book exists for.
  ok("same bar epoch on two timeframes both record", !!a && !!b && book.rows.length === 2);
  ok("same timeframe still deduped", recordSetup(book, { ...base, tf: 15, setupId: `SOLFIB:SHORT:${ep}` }) === null);
  ok("rejects inverted geometry (stop past entry for a short)",
    recordSetup(book, { ...base, tf: 5, stop: 90, setupId: "X" }) === null);
  ok("rejects non-finite prices",
    recordSetup(book, { ...base, tf: 5, entry: NaN, setupId: "Y" }) === null);
  ok("R:R computed from risk, not range", a.rr === 2); // risk 10, reward 20

  // SHIPPED BUG (the expensive one): entry was booked at the fib LEVEL while
  // the outcome walk began at the triggering bar's CLOSE — which has already
  // moved past that level, since closing past it is what fires the alert. That
  // free head start manufactured a positive expectancy on Deriv synthetics,
  // which are random number generators and cannot hold an edge. Observed win
  // rates (43/28/16% at 0.618/0.786/0.886) matched the driftless random-walk
  // prediction for a favourable start (43.2/26.4/16.4%) almost exactly.
  // Entry must be the price available when the alert lands.
  const b2 = { seq: 1, rows: [] };
  const alertClose = 97;   // price closed 3 past the 0.618 level, in our favour
  const levelPrice = 100;
  const rec = recordSetup(b2, { instKey: "V75", tf: 15, level: 0.618, dir: "SHORT",
    entry: alertClose, levelPrice, stop: 110, target: 60, setupId: "BIAS", source: "solfib" });
  ok("entry is the tradeable price, not the fib level", rec.entry === alertClose);
  ok("fib level retained for reference only", rec.levelPrice === levelPrice);
  ok("R:R measured from the real entry, not the level",
    rec.rr === +(37 / 13).toFixed(3), `got ${rec.rr}`); // reward 97-60, risk 110-97
}
{
  const mk = (openedAt) => ({ seq: 1, rows: [{ id: 1, key: "K|15|0.618", instKey: "V75", tf: 15,
    level: 0.618, dir: "LONG", entry: 100, stop: 90, target: 120, rr: 2, openedAt, status: "open" }] });
  const bars = []; for (let i = 0; i < 250; i++) bars.push({ t: 500000 + i * 900, open: 100, high: i === 240 ? 125 : 101, low: 99, close: 100 });
  const stale = mk(1000);
  await resolveOpen(stale, async () => bars);
  // SHIPPED BUG: window started after entry, so the walk missed the real
  // first touch and reported a WIN for a position that may already have been
  // stopped out before the data began.
  ok("entry predating the data window resolves 'unknown', never a fabricated win",
    stale.rows[0].outcome === "unknown", `got ${stale.rows[0].outcome}`);
  const good = mk(500000);
  await resolveOpen(good, async () => bars);
  ok("valid window still resolves normally", good.rows[0].outcome === "win");

  // A setup opens seconds INTO a bar (the poll runs just after the prior
  // close), so the entry bar must be present in the data and must be walked.
  const stopFirst = mk(500030);
  await resolveOpen(stopFirst, async () => [{ t: 500000, open: 100, high: 105, low: 88, close: 89 }]);
  ok("stop before target is a loss at -1R", stopFirst.rows[0].outcome === "loss" && stopFirst.rows[0].R === -1);

  const both = mk(500030);
  await resolveOpen(both, async () => [{ t: 500000, open: 100, high: 125, low: 88, close: 100 }]);
  ok("stop and target in one candle counts as a loss and is flagged ambiguous",
    both.rows[0].outcome === "loss" && both.rows[0].ambiguous === true);

  // SHIPPED BUG: the resolver kept only bars STARTING after openedAt, skipping
  // the bar the trade was actually inside — the very bar where a tight stop is
  // most often taken. That turned stop-outs into wins, worst at 0.886 whose
  // stop sits ~11% of the leg away.
  const entryBar = mk(500030);
  await resolveOpen(entryBar, async () => [
    { t: 500000, open: 100, high: 105, low: 89, close: 99 },   // stop at 90 hit HERE
    { t: 500900, open: 99, high: 125, low: 98, close: 124 },   // target later
  ]);
  ok("the bar containing entry is walked, not skipped", entryBar.rows[0].outcome === "loss");
}
{
  const a = agg([{ outcome: "unknown", R: 0 }, { outcome: "win", R: 2 }, { outcome: "loss", R: -1 }]);
  ok("'unknown' excluded from win-rate and expectancy", a.n === 2 && a.unknown === 1 && a.winPct === 50);
  ok("expectancy is mean R over settled rows", a.expR === 0.5);

  // SHIPPED BUG: breakeven came from the AVERAGE planned R:R. When close
  // targets win often and far targets lose, that average is dragged up by
  // the far ones and the bar looks far too low. This bucket loses money
  // (6 wins paying 0.5R, 4 losses at -1R) yet the old formula printed
  // "60% win (needed 19%)", a loser dressed as a winner.
  const skew = agg([
    ...Array.from({ length: 6 }, () => ({ outcome: "win", R: 0.5, rr: 0.5 })),
    ...Array.from({ length: 4 }, () => ({ outcome: "loss", R: -1, rr: 10 })),
  ]);
  ok("breakeven reflects what winners actually paid", skew.bePct === 67, `got ${skew.bePct}`);
  ok("a losing bucket can never show win% above its breakeven",
    skew.expR < 0 && skew.winPct < skew.bePct);
}

// ── execution gates ──────────────────────────────────────────────────────
group("execution engine");
{
  const size = { riskUsd: 5, dist: 10, note: "0.5u" };
  const cfg = { execMaxOpen: 3, execDailyLossCapR: 3 };
  const book = { seq: 1, rows: [] };
  const mkSetup = (id) => {
    const r = recordSetup(book, { instKey: "V50", tf: 30, level: 0.618, dir: "LONG",
      entry: 100, stop: 90, target: 120, setupId: id, source: "solfib" });
    return { instKey: "V50", tf: 30, level: 0.618, dir: "LONG", entry: 100, stop: 90,
      target: 120, rr: 2, paperKey: r.key, source: "solfib" };
  };
  ok("defaults to shadow — never live without an explicit flag",
    decide({ seq: 1, halted: false, rows: [] }, book, mkSetup("m1"), cfg, size).mode === "shadow");
  ok("live only when execLive is exactly true",
    decide({ seq: 1, halted: false, rows: [] }, book, mkSetup("m2"), { ...cfg, execLive: true }, size).mode === "live");
  ok("no account configured blocks the order",
    decide({ seq: 1, halted: false, rows: [] }, book, mkSetup("m3"), cfg, null).status === "skipped");
  ok("halt blocks the order",
    decide({ seq: 1, halted: true, rows: [] }, book, mkSetup("m4"), cfg, size).status === "skipped");

  const ex = { seq: 1, halted: false, rows: [] };
  for (const id of ["c1", "c2", "c3"]) decide(ex, book, mkSetup(id), cfg, size);
  ok("max concurrent positions enforced",
    decide(ex, book, mkSetup("c4"), cfg, size).reason.includes("max concurrent"));

  for (const p of book.rows) { p.status = "closed"; p.outcome = "loss"; p.R = -1; }
  ok("realised daily loss is summed from settled orders", todayR(book, ex) === -3);
  ok("settled orders no longer count as open exposure", openCount(book, ex) === 0);
  ok("daily loss cap halts further orders",
    decide(ex, book, mkSetup("c5"), cfg, size).reason.includes("daily loss cap"));

  const dup = mkSetup("d1");
  const exd = { seq: 1, halted: false, rows: [] };
  decide(exd, book, dup, { execMaxOpen: 99, execDailyLossCapR: 0 }, size);
  ok("same setup cannot be ordered twice",
    decide(exd, book, dup, { execMaxOpen: 99, execDailyLossCapR: 0 }, size).reason.includes("duplicate"));

  const before = execStats(exd, book);
  ok("an order awaiting its outcome counts as open, not settled",
    before.taken === 1 && before.settled === 0 && before.open === 1);
  const prow = book.rows.find((x) => x.key === dup.paperKey);
  Object.assign(prow, { status: "closed", outcome: "win", R: 2 });
  const after = execStats(exd, book);
  ok("once the paper row settles the order inherits real R and $",
    after.settled === 1 && after.totalR === 2 && after.usd === 10);
}
{
  const s = { instKey: "V50", tf: 30, level: 0.886, aged: false, manip: true, source: "solfib" };
  ok("empty filter list takes everything (correct for shadow)", matchesFilters(s, []).ok);
  ok("filter matches on every field", matchesFilters(s, [{ inst: "V50", tf: 30, level: 0.886, manip: true }]).ok);
  ok("non-matching filter rejects", !matchesFilters(s, [{ inst: "V75" }]).ok);
  ok("partial filter still matches", matchesFilters(s, [{ level: 0.886 }]).ok);
  ok("boolean false is honoured, not treated as absent", !matchesFilters(s, [{ manip: false }]).ok);
}

// ── detection invariants ─────────────────────────────────────────────────
group("detection");
{
  const bar = (o, h, l, c) => ({ t: 0, open: o, high: h, low: l, close: c });
  ok("double sweep requires BOTH sides taken",
    detectSweep(bar(10, 12, 8, 11), bar(11, 13, 7, 12)) !== null);
  ok("one-sided sweep is not a signal",
    detectSweep(bar(10, 12, 8, 11), bar(11, 13, 9, 12)) === null);
  ok("bullish close reads the LOW sweep as the manipulation",
    detectSweep(bar(10, 12, 8, 11), bar(11, 13, 7, 12)).manipSide === "low");
  ok("bearish close reads the HIGH sweep as the manipulation",
    detectSweep(bar(10, 12, 8, 11), bar(11, 13, 7, 9)).manipSide === "high");
  ok("doji (close == open) has no readable intent",
    detectSweep(bar(10, 12, 8, 11), bar(11, 13, 7, 11)) === null);
}
{
  // A pure uptrend has no swept high, so nothing may fire. Guards against a
  // detector that "finds" structure in any series it is handed.
  const up = []; for (let i = 0; i < 120; i++) up.push({ t: 1700000000 + i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i });
  ok("monotonic uptrend produces no SHORT setup", !detectSOLFib(up, { tfMin: 60 }).some((s) => s.dir === "SHORT"));
  ok("monotonic uptrend produces no OTE", detectOTE(up) === null);
  ok("empty and tiny inputs are safe", detectSOLFib([], { tfMin: 60 }).length === 0 && detectOTE([]) === null);
}
{
  // Every emitted setup must be internally coherent, whatever the input.
  const rnd = []; let p = 1000;
  let seed = 42; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 400; i++) { const o = p, h = p + rand() * 10, l = p - rand() * 10; p = l + rand() * (h - l); rnd.push({ t: 1700000000 + i * 3600, open: o, high: h, low: l, close: p }); }
  const setups = detectSOLFib(rnd, { dispMult: 2, tfMin: 60 });
  let coherent = true;
  for (const s of setups) {
    const L = s.levels;
    if (s.dir === "SHORT") { if (!(L[0.5] < L[0.618] && L[0.618] < L[0.786] && L[0.786] < L[0.886] && L[0.886] < s.solX)) coherent = false; }
    else { if (!(L[0.5] > L[0.618] && L[0.618] > L[0.786] && L[0.786] > L[0.886] && L[0.886] > s.solX)) coherent = false; }
    if (!(s.leg > 0) || !isFinite(s.dispX)) coherent = false;
  }
  ok(`fib ladder ordered and stop beyond every level (${setups.length} setups)`, coherent);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
