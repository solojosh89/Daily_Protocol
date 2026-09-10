// ─────────────────────────────────────────────────────────────────────────
// PAPER BOOK — the setup scoreboard (auto, mechanical, no human in the loop).
//
// trades.mjs measures the TRADER (what you chose to take, closed by hand).
// This measures the SETUP: every qualifying alert is auto-recorded with its
// entry/stop/target, then resolved by walking real candles forward — did
// target or stop come first? No discretion, no hindsight, no selection bias.
//
// That's what makes questions like "does V50 do better on 30m 0.886 than on
// 15m 0.618?" answerable: every setup is in the book, winners and losers,
// sliced by instrument × timeframe × level × age × confluence.
//
// HONEST LIMIT — same-candle ambiguity: if one candle's range contains BOTH
// the stop and the target, OHLC can't say which printed first. Those are
// marked `ambiguous` and counted as LOSSES (the standard conservative
// assumption) but reported separately, so you can see how much of the record
// leans on that choice.
//
// paper.json is a data file — deploys never overwrite it.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const STORE = join(dirname(fileURLToPath(import.meta.url)), "paper.json");
const MAX_BARS = 200; // give up on a position after this many bars → EXPIRED

export function loadPaper() {
  if (!existsSync(STORE)) return { seq: 1, rows: [] };
  try { const s = JSON.parse(readFileSync(STORE, "utf8")); return { seq: s.seq || 1, rows: s.rows || [] }; }
  catch { return { seq: 1, rows: [] }; }
}
export function savePaper(p) { try { writeFileSync(STORE, JSON.stringify(p, null, 2)); } catch {} }

// Record a setup the moment it alerts. Deduped on (setupId + level) so the
// same structure re-tapping the same level never double-counts.
// Returns the new row, or null if it was a duplicate / invalid geometry.
export function recordSetup(book, s) {
  const { instKey, tf, level, dir, entry, stop, target, setupId } = s;
  if (![entry, stop, target].every((x) => typeof x === "number" && isFinite(x))) return null;
  const risk = dir === "LONG" ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;                  // malformed geometry — don't pollute the book
  // Key MUST include the timeframe. solfib ids are `SOLFIB:<DIR>:<barEpoch>`,
  // and a 1H bar opening at 12:00 shares that epoch with the 15m bar at 12:00
  // — without `tf` the two collide and the second timeframe's setup is
  // silently dropped, corrupting the very tf-vs-tf comparison the book exists
  // to answer.
  const key = `${setupId}|${tf}|${level}`;
  if (book.rows.some((r) => r.key === key)) return null;
  const row = {
    id: book.seq++, key, instKey, tf, level, dir,
    levelPrice: typeof s.levelPrice === "number" ? +s.levelPrice.toFixed(6) : null,
    entry: +entry.toFixed(6), stop: +stop.toFixed(6), target: +target.toFixed(6),
    rr: +(Math.abs(target - entry) / risk).toFixed(3),
    // A setup booked late (e.g. after a restart) passes its true entry time,
    // so the resolver walks candles from the real entry, not from "now".
    openedAt: Number.isFinite(s.openedAt) ? s.openedAt : Math.floor(Date.now() / 1000),
    status: "open",
    // slicing attributes — the whole point of the book
    aged: !!s.aged, manip: !!s.manip, grade: s.grade || null, source: s.source || "solfib",
    session: s.session || null,
    move: Number.isFinite(s.move) ? +s.move.toFixed(3) : null,
  };
  book.rows.push(row);
  return row;
}

// Resolve every open row by walking its own timeframe's candles forward from
// entry. `fetchBars(instKey, tfMin, count)` must return [{t,open,high,low,close}].
// Returns { resolved, expired } counts. Network failures just leave rows open.
export async function resolveOpen(book, fetchBars) {
  const open = book.rows.filter((r) => r.status === "open");
  if (!open.length) return { resolved: 0, expired: 0 };
  let resolved = 0, expired = 0;
  // one fetch per (instrument, timeframe) — not per row
  const groups = new Map();
  for (const r of open) {
    const k = `${r.instKey}:${r.tf}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, rows] of groups) {
    const [instKey, tfStr] = k.split(":");
    const tf = Number(tfStr);
    let bars;
    try { bars = await fetchBars(instKey, tf, MAX_BARS + 50); } catch { continue; }
    if (!bars || !bars.length) continue;
    for (const r of rows) {
      // The window MUST reach back to entry. If the oldest fetched bar is
      // newer than openedAt, the walk would start mid-history and miss the
      // true first touch — fabricating an outcome (e.g. reporting a WIN for a
      // position that had already been stopped out before the window began).
      // "Covers entry" means the window starts no later than the FIRST bar
      // after entry. A gap bigger than one bar means candles are missing and
      // the first touch may be in that gap.
      const tfSec = tf * 60;
      // Coverage: we need a bar starting at or before entry, otherwise the bar
      // the trade actually opened inside is missing from the data.
      if (bars[0].t > r.openedAt) {
        if (Math.floor(Date.now() / 1000) - r.openedAt > MAX_BARS * tfSec) {
          // too old to ever verify — close it as unknown, excluded from stats
          Object.assign(r, { status: "closed", outcome: "unknown", R: 0, ambiguous: false, bars: null, at: null });
          expired++;
        }
        continue; // otherwise leave it open; a later pass may cover it
      }
      // Include the bar the trade is INSIDE, not just bars starting after it.
      // A setup opens ~seconds into a fresh bar (the poll runs just after the
      // previous close), so `b.t > openedAt` skipped that whole bar — and the
      // first bar after entry is precisely where a tight stop gets taken. That
      // silently converted stop-outs into wins, hardest on the deep levels
      // whose stops are only ~11% of the leg away.
      const after = bars.filter((b) => b.t + tfSec > r.openedAt);
      if (!after.length) continue;
      const long = r.dir === "LONG";
      let done = null;
      for (let i = 0; i < after.length; i++) {
        const b = after[i];
        const hitStop = long ? b.low <= r.stop : b.high >= r.stop;
        const hitTgt = long ? b.high >= r.target : b.low <= r.target;
        if (hitStop && hitTgt) { done = { outcome: "loss", R: -1, ambiguous: true, bars: i + 1, at: b.t }; break; }
        if (hitStop) { done = { outcome: "loss", R: -1, ambiguous: false, bars: i + 1, at: b.t }; break; }
        if (hitTgt) { done = { outcome: "win", R: r.rr, ambiguous: false, bars: i + 1, at: b.t }; break; }
      }
      if (done) {
        Object.assign(r, { status: "closed", ...done, R: +done.R.toFixed(3) });
        resolved++;
      } else if (after.length >= MAX_BARS) {
        // neither level reached in MAX_BARS — mark it out, valued at the last
        // close so an endlessly-drifting setup can't sit "open" forever.
        const last = after[after.length - 1].close;
        const risk = long ? r.entry - r.stop : r.stop - r.entry;
        const R = (long ? last - r.entry : r.entry - last) / risk;
        Object.assign(r, { status: "closed", outcome: "expired", R: +R.toFixed(3), ambiguous: false, bars: after.length, at: after[after.length - 1].t });
        expired++;
      }
    }
  }
  return { resolved, expired };
}

// ── analytics ────────────────────────────────────────────────────────────
// Aggregate one bucket of closed rows.
export function agg(all) {
  // `unknown` = opened before our data window, outcome unverifiable. Counted
  // and surfaced, but never allowed into win-rate or expectancy math.
  const unknown = all.filter((r) => r.outcome === "unknown").length;
  const rows = all.filter((r) => r.outcome !== "unknown");
  const n = rows.length;
  if (!n) return { n: 0, unknown };
  const wins = rows.filter((r) => r.outcome === "win").length;
  const losses = rows.filter((r) => r.outcome === "loss").length;
  const exp = rows.filter((r) => r.outcome === "expired").length;
  const amb = rows.filter((r) => r.ambiguous).length;
  const totalR = rows.reduce((a, r) => a + (r.R || 0), 0);
  const medBars = [...rows].map((r) => r.bars || 0).sort((a, b) => a - b)[Math.floor(n / 2)];
  // Breakeven win rate. Deep fib entries carry a far bigger reward-to-risk
  // (0.618≈1.6R, 0.786≈3.7R, 0.886≈7.8R), so their win rates are NOT
  // comparable: 20% at 0.886 is excellent, 45% at 0.618 is marginal. Without
  // this number the win-rate column invites exactly the wrong conclusion.
  const avgRR = rows.reduce((a, r) => a + (r.rr || 0), 0) / n;
  // Breakeven must come from what winners ACTUALLY paid, not the average
  // planned R:R. Close targets win often and pay little; far targets win
  // rarely and pay a lot. Averaging planned R:R lets a few far targets drag
  // the bar down, so a losing bucket could print "60% win (needed 19%)".
  // With losses at -1R, expectancy is p*avgWin - (1-p), so breakeven is
  // p = 1 / (1 + avgWin). This always agrees with the sign of expR.
  const winRows = rows.filter((r) => r.outcome === "win");
  const avgWinR = winRows.length ? winRows.reduce((a, r) => a + (r.R || 0), 0) / winRows.length : 0;
  const bePct = avgWinR > 0 ? 100 / (1 + avgWinR) : null;
  return {
    n, wins, losses, expired: exp, ambiguous: amb, unknown,
    winPct: Math.round((100 * wins) / n),
    avgRR: +avgRR.toFixed(2),
    avgWinR: +avgWinR.toFixed(2),
    bePct: bePct == null ? null : Math.round(bePct),
    totalR: +totalR.toFixed(2),
    expR: +(totalR / n).toFixed(3),
    medBars,
  };
}

// Group closed rows by any attribute combo, e.g. ["instKey","tf","level"].
// Returns [{ label, ...agg }] sorted by expectancy, richest samples first.
export function slice(book, keys, filter = () => true) {
  const rows = book.rows.filter((r) => r.status === "closed" && filter(r));
  const map = new Map();
  for (const r of rows) {
    const label = keys.map((k) => fmtAttr(k, r[k])).join(" · ");
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(r);
  }
  return [...map.entries()]
    .map(([label, rs]) => ({ label, ...agg(rs) }))
    .sort((a, b) => b.expR - a.expR || b.n - a.n);
}

function fmtAttr(k, v) {
  if (k === "tf") return v >= 60 ? `${v / 60}H` : `${v}m`;
  if (k === "level") return String(v);
  if (k === "aged") return v ? "aged" : "fresh";
  if (k === "manip") return v ? "confluence" : "no-confluence";
  return String(v);
}

// Minimum sample before a bucket's number means anything. Below this the
// report labels it explicitly rather than letting 2 trades look like an edge.
export const THIN = 10;
