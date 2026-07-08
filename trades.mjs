// ─────────────────────────────────────────────────────────────────────────
// TRADE LOG + PERFORMANCE MATH — the honest scoreboard.
//
// Everything in the project measures the MARKET; this measures the TRADER.
// You log entries with their levels, close them with the outcome, and the
// weekly report gives your REAL expectancy in R — not a feeling, a number.
// R is the only unit that matters: it makes a $5-risk Gold trade and a
// $5-risk Nasdaq trade directly comparable, and it's what a prop firm reads.
//
// R math (signed by direction, from the levels you set — no mental math):
//   LONG :  risk = entry-stop ;  R = (exit-entry)/risk
//   SHORT:  risk = stop-entry ;  R = (entry-exit)/risk
//   shorthands: win = exit at target (planned R) · loss = stop (-1R) · be = 0R
//
// Persisted in trades.json (data file — deploys never overwrite it).
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { INSTRUMENTS, idTag } from "./deriv.mjs";

const STORE = join(dirname(fileURLToPath(import.meta.url)), "trades.json");

export function loadTrades() {
  if (!existsSync(STORE)) return { seq: 1, open: [], closed: [] };
  try { const s = JSON.parse(readFileSync(STORE, "utf8")); return { seq: s.seq || 1, open: s.open || [], closed: s.closed || [] }; }
  catch { return { seq: 1, open: [], closed: [] }; }
}
export function saveTrades(t) { try { writeFileSync(STORE, JSON.stringify(t, null, 2)); } catch {} }

export function openTrade(store, { instKey, dir, entry, stop, target }) {
  dir = dir.toUpperCase();
  if (dir !== "LONG" && dir !== "SHORT") throw new Error("direction must be long or short");
  const risk = dir === "LONG" ? entry - stop : stop - entry;
  if (!(risk > 0)) throw new Error(dir === "LONG" ? "stop must be BELOW entry for a long" : "stop must be ABOVE entry for a short");
  const rr = target != null ? Math.abs(target - entry) / risk : null;
  const id = store.seq++;
  const tr = { id, instKey, dir, entry, stop, target: target ?? null, rr, openedAt: Math.floor(Date.now() / 1000), status: "open" };
  store.open.push(tr);
  return tr;
}

// exit: a number (price), or "win"/"loss"/"be"
export function closeTrade(store, id, exit) {
  const idx = store.open.findIndex((t) => t.id === id);
  if (idx < 0) throw new Error(`no open trade #${id} (see /trades)`);
  const tr = store.open[idx];
  const risk = tr.dir === "LONG" ? tr.entry - tr.stop : tr.stop - tr.entry;
  let exitPrice, R;
  const word = typeof exit === "string" ? exit.toLowerCase() : null;
  if (word === "win") { if (tr.target == null) throw new Error("no target set — close with the exit price instead"); exitPrice = tr.target; R = tr.rr; }
  else if (word === "loss" || word === "l") { exitPrice = tr.stop; R = -1; }
  else if (word === "be" || word === "breakeven") { exitPrice = tr.entry; R = 0; }
  else {
    exitPrice = parseFloat(String(exit).replace(/,/g, ""));
    if (!isFinite(exitPrice)) throw new Error(`"${exit}" isn't a price or win/loss/be`);
    R = (tr.dir === "LONG" ? exitPrice - tr.entry : tr.entry - exitPrice) / risk;
  }
  const closed = { ...tr, status: "closed", exit: exitPrice, R: +R.toFixed(3), closedAt: Math.floor(Date.now() / 1000) };
  store.open.splice(idx, 1);
  store.closed.push(closed);
  return closed;
}

// Aggregate stats over closed trades (optionally since a unix ts).
export function stats(closed, sinceTs = 0) {
  const rows = closed.filter((t) => (t.closedAt || 0) >= sinceTs);
  const n = rows.length;
  if (!n) return { n: 0 };
  const wins = rows.filter((t) => t.R > 0), losses = rows.filter((t) => t.R < 0), be = rows.filter((t) => t.R === 0);
  const totalR = rows.reduce((a, t) => a + t.R, 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.R, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.R, 0) / losses.length : 0;
  // longest losing streak (chronological)
  let streak = 0, worst = 0;
  for (const t of rows.sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0))) {
    if (t.R < 0) { streak++; worst = Math.max(worst, streak); } else streak = 0;
  }
  // max drawdown in R along the equity curve
  let eq = 0, peak = 0, dd = 0;
  for (const t of rows) { eq += t.R; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return {
    n, wins: wins.length, losses: losses.length, be: be.length,
    winPct: Math.round(100 * wins.length / n),
    totalR: +totalR.toFixed(2), expR: +(totalR / n).toFixed(2),
    avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
    worstStreak: worst, maxDDR: +dd.toFixed(2),
  };
}

// Human report (HTML). label e.g. "This week" / "All time". account optional
// { balance, riskPct } → adds $ P&L. Honest framing vs the backtest baseline.
export function reportText(store, { label, sinceTs = 0, account } = {}) {
  const s = stats(store.closed, sinceTs);
  const openN = store.open.length;
  if (!s.n) {
    return `📊 <b>${label} report</b>\nNo closed trades${openN ? ` · ${openN} still open` : ""}. Log with <code>/trade GOLD long 3312 3299 3341</code>, close with <code>/close ID win</code>.`;
  }
  const sign = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
  let pnl = "";
  if (account?.balance > 0) {
    const riskUsd = account.balance * (account.riskPct || 1) / 100;
    pnl = `\n💵 At $${riskUsd.toFixed(2)}/R: <b>${sign(s.totalR * riskUsd).replace("+", "+$").replace("-", "-$")}</b> (${sign(s.totalR)}R × $${riskUsd.toFixed(2)})`;
  }
  // honest verdict vs the backtest baseline (+0.35R expectancy)
  const verdict = s.expR >= 0.3 ? "✅ matching/beating the backtest edge (+0.35R)"
    : s.expR >= 0 ? "🟡 positive but under the backtest edge — small sample or leakage; keep logging"
      : "🔴 negative expectancy — protect capital; review whether you're waiting for the setup (both sides / OTE)";
  return (
    `📊 <b>${label} report</b> — ${s.n} trades${openN ? ` (${openN} still open)` : ""}\n\n` +
    `Win rate: <b>${s.winPct}%</b> (${s.wins}W / ${s.losses}L${s.be ? ` / ${s.be}BE` : ""})\n` +
    `Expectancy: <b>${sign(s.expR)}R</b> per trade\n` +
    `Total: <b>${sign(s.totalR)}R</b>${pnl}\n` +
    `Avg win ${sign(s.avgWin)}R · avg loss ${sign(s.avgLoss)}R\n` +
    `Worst losing streak: ${s.worstStreak} · max drawdown ${sign(s.maxDDR)}R\n\n` +
    `<i>${verdict}</i>`
  );
}

export const instName = (key) => { const i = INSTRUMENTS.find((x) => x.key === key); return i ? idTag(i) : key; };
