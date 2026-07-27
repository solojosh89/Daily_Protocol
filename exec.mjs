// ─────────────────────────────────────────────────────────────────────────
// EXECUTION ENGINE — auto-decides every setup, logs the full order, and (in
// shadow mode) transmits nothing.
//
// MODE:
//   "shadow" (default) — decide, size, log. NO broker call. The complete
//        machinery runs against live signals so the record shows exactly what
//        the account would have done, with none of the money at risk.
//   "live"  — same decisions, plus a real order. Gated behind execLive:true
//        AND an explicit per-instrument allowlist AND a broker token. Nothing
//        here transmits until all three are set on purpose.
//
// Every decision is logged either way — TAKEN or SKIPPED with the reason —
// so the log answers "why didn't it trade that?" as readily as "what did it
// trade?". Each row carries the paper-book key, so once the paper book
// settles the setup, the order inherits a real outcome and P&L.
//
// RISK GATES, checked in order (first failure skips, with its reason):
//   halted → filters → duplicate → max concurrent → daily loss cap → sizing
//
// exec-log.json is a data file — deploys never overwrite it.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const STORE = join(dirname(fileURLToPath(import.meta.url)), "exec-log.json");

export function loadExec() {
  if (!existsSync(STORE)) return { seq: 1, halted: false, rows: [] };
  try {
    const s = JSON.parse(readFileSync(STORE, "utf8"));
    return { seq: s.seq || 1, halted: !!s.halted, rows: s.rows || [] };
  } catch { return { seq: 1, halted: false, rows: [] }; }
}
export function saveExec(e) { try { writeFileSync(STORE, JSON.stringify(e, null, 2)); } catch {} }

const dayKey = (ts = Date.now() / 1000) => new Date(ts * 1000).toISOString().slice(0, 10);

// Does this setup match the configured filters? An empty/absent filter list
// means "take everything" (correct for shadow mode — you want the full record
// to compare against). Once /perf proves specific buckets, list them here and
// the engine narrows to exactly those.
// Filter shape: { inst?, tf?, level?, aged?, manip?, grade?, source? }
export function matchesFilters(setup, filters) {
  if (!filters || !filters.length) return { ok: true, why: "no filter list — taking all setups" };
  for (const f of filters) {
    if (f.inst && f.inst !== setup.instKey) continue;
    if (f.tf != null && Number(f.tf) !== Number(setup.tf)) continue;
    if (f.level != null && Number(f.level) !== Number(setup.level)) continue;
    if (f.aged != null && !!f.aged !== !!setup.aged) continue;
    if (f.manip != null && !!f.manip !== !!setup.manip) continue;
    if (f.grade && f.grade !== setup.grade) continue;
    if (f.source && f.source !== setup.source) continue;
    return { ok: true, why: `matched filter ${JSON.stringify(f)}` };
  }
  return { ok: false, why: "no configured filter matched this setup" };
}

// Realised R today, from orders whose paper row has since settled.
export function todayR(book, ex) {
  const today = dayKey();
  let r = 0;
  for (const row of ex.rows) {
    if (row.status !== "taken" || dayKey(row.ts) !== today) continue;
    const p = book.rows.find((x) => x.key === row.paperKey && x.status === "closed");
    if (p) r += p.R || 0;
  }
  return +r.toFixed(3);
}

// Count orders still awaiting a settled outcome — the live exposure.
export function openCount(book, ex) {
  return ex.rows.filter((row) => {
    if (row.status !== "taken") return false;
    const p = book.rows.find((x) => x.key === row.paperKey);
    return !p || p.status === "open";
  }).length;
}

// Decide + log one setup. `size` is an optional {riskUsd, dist, note} from
// risk.mjs. Returns the logged row. Never throws — a broken execution engine
// must not take the alerting bot down with it.
export function decide(ex, book, setup, cfg, size) {
  const mode = cfg.execLive === true ? "live" : "shadow";
  const row = {
    id: ex.seq++, ts: Math.floor(Date.now() / 1000), mode,
    instKey: setup.instKey, tf: setup.tf, level: setup.level, dir: setup.dir,
    entry: setup.entry, stop: setup.stop, target: setup.target,
    rr: setup.rr ?? null, paperKey: setup.paperKey || null,
    aged: !!setup.aged, manip: !!setup.manip, grade: setup.grade || null, source: setup.source || null,
    status: "skipped", reason: null,
    riskUsd: size?.riskUsd != null ? +size.riskUsd.toFixed(2) : null,
    sizeNote: size?.note || null,
  };
  const skip = (reason) => { row.reason = reason; ex.rows.push(row); return row; };

  if (ex.halted) return skip("engine HALTED (/resume to re-enable)");

  const f = matchesFilters(setup, cfg.execFilters);
  if (!f.ok) return skip(f.why);

  if (ex.rows.some((r) => r.status === "taken" && r.paperKey && r.paperKey === setup.paperKey)) {
    return skip("already taken — duplicate setup+level");
  }

  const maxOpen = cfg.execMaxOpen ?? 3;
  const nOpen = openCount(book, ex);
  if (nOpen >= maxOpen) return skip(`max concurrent positions reached (${nOpen}/${maxOpen})`);

  const capR = cfg.execDailyLossCapR ?? 3;
  const tR = todayR(book, ex);
  if (capR > 0 && tR <= -Math.abs(capR)) return skip(`daily loss cap hit (${tR}R ≤ -${Math.abs(capR)}R) — halted for today`);

  if (!size || !(size.riskUsd > 0)) return skip("no account/risk configured — set it with /risk 500 1");

  row.status = "taken";
  row.reason = f.why;
  ex.rows.push(row);
  return row;
}

// Aggregate the shadow/live record. Joins each taken order to its settled
// paper row for the real outcome — this is "what the account would have done".
export function execStats(ex, book, sinceTs = 0) {
  const taken = ex.rows.filter((r) => r.status === "taken" && r.ts >= sinceTs);
  const skipped = ex.rows.filter((r) => r.status === "skipped" && r.ts >= sinceTs);
  let settled = 0, wins = 0, totalR = 0, usd = 0, openN = 0;
  for (const r of taken) {
    const p = book.rows.find((x) => x.key === r.paperKey);
    if (!p || p.status !== "closed") { openN++; continue; }
    settled++;
    if (p.outcome === "win") wins++;
    totalR += p.R || 0;
    if (r.riskUsd) usd += (p.R || 0) * r.riskUsd;
  }
  // why setups were skipped, most common first
  const reasons = {};
  for (const r of skipped) reasons[r.reason || "?"] = (reasons[r.reason || "?"] || 0) + 1;
  return {
    taken: taken.length, skipped: skipped.length, settled, open: openN,
    wins, winPct: settled ? Math.round((100 * wins) / settled) : 0,
    totalR: +totalR.toFixed(2), expR: settled ? +(totalR / settled).toFixed(3) : 0,
    usd: +usd.toFixed(2),
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]),
  };
}
