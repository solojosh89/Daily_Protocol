// ─────────────────────────────────────────────────────────────────────────
// LIVE 4H SWEEP MONITOR  →  Telegram + WhatsApp alerts
//
//   node monitor.mjs                 run forever, alert on every new 4H sweep
//   node monitor.mjs --once          evaluate the latest closed candle once, exit
//   node monitor.mjs --setup         test the Telegram bot + print your chat id
//   node monitor.mjs --setup-whatsapp   verify WhatsApp config + send a test
//
// No dependencies. Reads config.json (falls back to config.example.json).
// If a channel's token is missing it's simply skipped for that channel.
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS, fmtTime, nextBoundary, sessionOf, idTag } from "./deriv.mjs";
import { fetch4H } from "./source.mjs";
import { detectSweep, fmt, dec } from "./detector.mjs";
import { analyzeLTF, ltfLines } from "./ltf.mjs";
import { analyzeFirstSweep, firstSweepText, firstSweepLine, statusText, statusLine, firstSweepDigestLine, statusDigestLine } from "./firstsweep.mjs";
import { analyzeB, bSummaryLine, narrativeLines } from "./narrative.mjs";
import { detectOTE } from "./ote.mjs";
import { analyzeSweep15, solVerdict } from "./sweep15.mjs";
import { positionSize } from "./risk.mjs";
import { loadTrades, reportText } from "./trades.mjs";
import { renderOTEChart, renderSweep15Chart, render4HContext, chartCandleCount, tgSendPhoto, tgSendAlbum } from "./chart.mjs";
import { fetch1H, fetch15m, fetchGran } from "./source.mjs";
import { detectSOLFib } from "./solfib.mjs";
import { pollCommands, checkPriceAlerts, registerCommands } from "./commands.mjs";
import { logEvent } from "./log.mjs";
import { loadConfig, saveField } from "./config.mjs";
import { sendWhatsApp, verifyWhatsAppConfig } from "./whatsapp.mjs";
import net from "net";

// Single-instance guard: bind a fixed localhost port. If it's already taken,
// another live monitor owns it → refuse to start (prevents the double-alerts
// that happen when a restart accidentally leaves two copies running). The OS
// frees the port the instant the owning process dies, so there's no stale lock.
function acquireLock(port = 47673) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => resolve(e.code === "EADDRINUSE" ? null : srv));
    srv.once("listening", () => resolve(srv));
    srv.listen(port, "127.0.0.1");
  });
}
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// OTE dedup persisted to disk (ote-seen.json) so a bot RESTART never re-sends
// an alert for a setup that was already announced. Data file — push-update.ps1
// copies only *.mjs/*.sh, so deploys never reset it.
const MDIR = dirname(fileURLToPath(import.meta.url));
const OTE_SEEN_PATH = join(MDIR, "ote-seen.json");
function loadOteSeen() {
  if (!existsSync(OTE_SEEN_PATH)) return {};
  try { return JSON.parse(readFileSync(OTE_SEEN_PATH, "utf8")); } catch { return {}; }
}
function saveOteSeen(seen) { try { writeFileSync(OTE_SEEN_PATH, JSON.stringify(seen, null, 2)); } catch {} }

// ALL dedup/seen state persisted across restarts (state.json). Before this,
// every deploy/reboot wiped the in-memory maps → duplicate FORMING alerts
// (seen live 2026-07-03: 19:45 + 19:52 same candle after a restart) and
// silently-swallowed milestones. Data file — deploys never overwrite it.
const RUN_STATE_PATH = join(MDIR, "state.json");
const RUN_STATE_KEYS = ["lastSeen", "formingSeen", "firstSweepSeen", "statusSeen", "progSeen", "sweep15Seen", "sweep15Pending", "tcSeen", "reports", "solFib"];
function loadRunState() {
  let raw = {};
  if (existsSync(RUN_STATE_PATH)) { try { raw = JSON.parse(readFileSync(RUN_STATE_PATH, "utf8")); } catch {} }
  const s = {};
  for (const k of RUN_STATE_KEYS) s[k] = raw[k] && typeof raw[k] === "object" ? raw[k] : {};
  return s;
}
function saveRunState(state) {
  try {
    const out = {};
    for (const k of RUN_STATE_KEYS) out[k] = state[k] || {};
    writeFileSync(RUN_STATE_PATH, JSON.stringify(out));
  } catch {}
}

// Fingerprint of the files that decide candle alignment/source (deriv.mjs,
// source.mjs). Shown in the startup banner so it's obvious at a glance whether
// a running process has picked up a fix, without having to guess or ask.
function codeFingerprint() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const h = createHash("md5");
  for (const f of ["deriv.mjs", "source.mjs", "detector.mjs"]) {
    try { h.update(readFileSync(join(dir, f))); } catch {}
  }
  return h.digest("hex").slice(0, 8);
}

const GRAN = 14400; // 4H in seconds
const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const SETUP = args.includes("--setup");
const SETUP_WA = args.includes("--setup-whatsapp");

// ── telegram ────────────────────────────────────────────────────────────
const TG = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
async function tgGetMe(token) {
  const r = await fetch(TG(token, "getMe")); const j = await r.json();
  if (!j.ok) throw new Error("Telegram token rejected: " + (j.description || r.status));
  return j.result;
}
async function tgResolveChatId(token) {
  const r = await fetch(TG(token, "getUpdates")); const j = await r.json();
  if (!j.ok || !j.result?.length) return null;
  const msg = [...j.result].reverse().find((u) => u.message?.chat?.id);
  return msg ? String(msg.message.chat.id) : null;
}
async function tgSend(token, chatId, text) {
  const r = await fetch(TG(token, "sendMessage"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error("Telegram send failed: " + (j.description || r.status));
}

// ── helpers ─────────────────────────────────────────────────────────────
const selectedInstruments = (cfg) =>
  cfg.instruments === "all" ? INSTRUMENTS : INSTRUMENTS.filter((i) => cfg.instruments.includes(i.key));

function passesFilter(sig, cfg) {
  if (cfg.alertLevel === "strong" && sig.strength !== "STRONG") return false;
  if (cfg.minBodyPct && sig.bodyPct < cfg.minBodyPct) return false;
  return true;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// Most recent CLOSED 4H candle = last candle whose window has fully elapsed.
function lastClosed(candles) {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) if (candles[i].t + GRAN <= nowSec()) idx = i;
  if (idx < 1) return null;
  return { prev: candles[idx - 1], cur: candles[idx] };
}

// The currently-FORMING 4H candle (window not yet elapsed) + the candle before it.
function formingCandle(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (last && prev && last.t + GRAN > nowSec()) return { prev, cur: last };
  return null;
}

function alertText(inst, s, cfg, phase, minsLeft) {
  const id = idTag(inst);
  const cline = `H4 candle ${fmtTime(s.cur.t, cfg.displayTzOffset, cfg.displayTzLabel)} · ${sessionOf(s.cur.t)}`;
  if (phase === "fizzled") {
    return `${id} — ⚠️ <b>SETUP FIZZLED</b>\n<i>Phase 5 · H4 closed · protocol INVALID</i>\nThe forming double-sweep did not hold at close.\n${cline}`;
  }
  // NOTE: no "(x sweep = manipulation)" claim here — the close-direction guess
  // about which side went first is wrong ~22% of the time. The measured true
  // order is reported in the Candle B narrative appended at close.
  const biasTxt = s.dir === "BULL" ? "🟢 <b>BULLISH</b>" : "🔴 <b>BEARISH</b>";
  const dirTxt = `${biasTxt} — swept both sides, clos${phase === "forming" ? "ing" : "ed"} ${s.dir === "BULL" ? "up" : "down"}`;
  const star = s.strength === "STRONG" ? " ⭐ <b>STRONG</b>" : "";
  const head = phase === "forming"
    ? `${id} — ${s.dir === "BULL" ? "🟢" : "🔴"} <b>${s.dir === "BULL" ? "BULLISH" : "BEARISH"} DOUBLE-SWEEP forming</b>${star}\n<i>Phase 4 · ~${minsLeft} min to close — provisional, can still change. Get to the chart.</i>`
    : `${id} — ${s.dir === "BULL" ? "🟢" : "🔴"} <b>${s.dir === "BULL" ? "BULLISH" : "BEARISH"} CONFIRMED</b>${star}\n<i>Phase 5 · H4 closed · protocol VALID</i>`;
  const priceLabel = phase === "forming" ? "Now" : "Close";
  return (
    `${head}\n${cline}\n${dirTxt}\n` +
    `Swept high: <code>${fmt(s.sweptHigh)}</code>   Swept low: <code>${fmt(s.sweptLow)}</code>\n` +
    `${priceLabel}: <code>${fmt(s.cur.close)}</code>   Body: <b>${(s.bodyPct * 100).toFixed(0)}%</b> of its own range${s.prev ? ` · <b>${(100 * Math.abs(s.cur.close - s.cur.open) / ((s.prev.high - s.prev.low) || 1e-9)).toFixed(0)}%</b> of A` : ""}${s.engulf ? "   engulf" : ""}${s.biggerBody !== undefined ? `   vs prior body: ${s.biggerBody ? "bigger ✓" : "smaller ✗"}` : ""}\n` +
    execBlock(inst, s, cfg, phase) +
    `→ go check structure to the left.`
  );
}

// Candle C execution guidance — only on the confirmed (Phase 5) close.
// B is the bias candle; C = the next candle = execution. Watch M15/H1 in the
// first `executionWindowMin` of C (data-backed priority window, not a wall).
function execBlock(inst, s, cfg, phase) {
  if (phase !== "closed") return "";
  const bias = s.dir === "BULL" ? "🟢 BULLISH" : "🔴 BEARISH";
  const cOpen = s.cur.t + 14400;               // Candle C opens when B closes
  const wEnd = cOpen + cfg.executionWindowMin * 60;
  const T = (e) => fmtTime(e, cfg.displayTzOffset, cfg.displayTzLabel);
  return (
    `\n<b>▶ Execution — Candle C</b>\n` +
    `${bias} bias set by B. Watch M15/H1 for a sweep/displacement entry.\n` +
    `High-attention window: <b>${T(cOpen)} → ${T(wEnd)}</b> (first ${cfg.executionWindowMin}m of C)\n` +
    `📊 ~66% of best entries land in this window (vs ~53% random); after it, priority drops.\n\n`
  );
}

// ── core evaluation pass ──────────────────────────────────────────────────
// ── SOL-FIB SCANNER (synthetics) ────────────────────────────────────────
// Scans each configured timeframe for the SOL→fib structure and emits at
// most three alerts per setup lifetime: armed / 0.618 tap / 0.886 tap.
// Phase flags persist in state.solFib (restart-proof, keyed by setup id).
// History depth per TF: enough to hold a month-old SOL on 1H (the user's
// V25 June-12 → July-8 example needs ~650 1H bars).
const SOLFIB_COUNTS = { 15: 400, 30: 500, 60: 800 };
async function scanSOLFib(inst, cfg, state, emitSOLFib) {
  const tfs = cfg.solFibTimeframes || [15, 30, 60];
  state.solFib ||= {};
  const fetched = await Promise.all(tfs.map((tf) =>
    fetchGran(inst, SOLFIB_COUNTS[tf] || 400, tf * 60).then((cs) => [tf, cs]).catch(() => [tf, null])));
  for (const [tf, cs] of fetched) {
    if (!cs || cs.length < 60) continue;
    const setups = detectSOLFib(cs, {
      dispMult: cfg.solFibDispMult || 2,
      tfMin: tf,
      longAgeHours: cfg.solFibLongAgeHours || 240,
    });
    // Old and new setups coexist (nested SOLs) — track each by its id.
    const prefix = `${inst.key}:${tf}:`;
    const liveIds = new Set(setups.map((s) => s.id));
    for (const k of Object.keys(state.solFib)) {
      if (k.startsWith(prefix) && !liveIds.has(k.slice(prefix.length))) delete state.solFib[k]; // invalidated/expired — silent
    }
    for (const s of setups) {
      const key = prefix + s.id;
      const st = state.solFib[key] || (state.solFib[key] = {});
      try {
        // Alert policy (the user's rule, anti-noise): TAP618 always fires —
        // it's the entry on fresh setups and the "deep 0.886 likely" warning
        // on aged ones. ARMED and TAP886 fire only for AGED setups (the big
        // month-long structures worth pre-drawing; fresh ARMED/886 is chop).
        // cfg.solFibAlertAll = true restores every phase on every setup.
        const all = cfg.solFibAlertAll === true;
        if (s.armed && !st.armed) { st.armed = 1; if (s.aged || all) await emitSOLFib(inst, tf, s, "armed", cs); }
        if (s.tap618 && !st.t618) { st.t618 = 1; await emitSOLFib(inst, tf, s, "tap618", cs); }
        if (s.tap886 && !st.t886) { st.t886 = 1; if (s.aged || all) await emitSOLFib(inst, tf, s, "tap886", cs); }
      } catch (e) { console.log(`  solfib emit ${key}:`, e.message); }
    }
  }
}

async function evaluate(cfg, state, emit, emitFirstSweep, emitStatus, emitMilestone, emitOTE, emitPrice, emitSweep15, emitSweep15Verdict, emitTiming, emitSOLFib) {
  const fsBatch = [], stBatch = [], msBatch = []; // collect bursts so 11-at-once become ONE digest each
  const tcOpenBatch = [], tcClosedBatch = [];     // timing-clock zone reminders
  const want = Math.max(6, cfg.oteLookback || 60); // enough history for OTE structure
  for (const inst of selectedInstruments(cfg)) {
    let candles;
    try { candles = await fetch4H(inst, want, cfg.bucketOffsetHours); }
    catch (e) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${inst.label}: fetch err ${e.message}`); continue; }

    // USER PRICE ALERTS — check the freshest candle against any /alert levels.
    if (emitPrice && candles.length) { try { await emitPrice(inst, candles[candles.length - 1]); } catch {} }

    // SYNTHETICS → SOL-FIB ENGINE ONLY (user request 2026-07-10): on Deriv
    // pairs the 4H manipulation flow is OFF. We only hunt the charted
    // structure — SOL → impulse → fib retrace with age-adaptive level
    // (fresh → 0.618, aged → 0.886) — on 15m/30m/1H. Price alerts (above)
    // still work. `continue` skips every 4H phase below.
    if (inst.key.startsWith("V")) {
      if (cfg.solFib !== false && emitSOLFib) {
        try { await scanSOLFib(inst, cfg, state, emitSOLFib); }
        catch (e) { console.log(`  solfib ${inst.key} error:`, e.message); }
      }
      continue;
    }

    // OTE / STRUCTURE SETUP (REALS only) — fires once per setup, on the 15m
    // entry chart by default (cfg.oteTimeframeMin: 15; 240 = the 4H
    // ote-study-validated version): swept liquidity → displacement → 0.62–0.79.
    if (cfg.oteAlert && emitOTE) {
      try {
        const tfMin = cfg.oteTimeframeMin || 15;
        const bars = tfMin >= 240 ? candles : await fetch15m(inst, cfg.oteCandles || 200);
        const setup = detectOTE(bars, { dispMult: cfg.oteDispMult });
        if (setup && state.oteSeen[inst.key] !== setup.id) {
          state.oteSeen[inst.key] = setup.id;
          saveOteSeen(state.oteSeen); // survive restarts — no duplicate re-alerts
          await emitOTE(inst, setup, tfMin);
        }
      } catch {}
    }

    const fc = formingCandle(candles);
    // Compute the first-sweep/progress snapshot once (15m fetch) and reuse for the
    // Stage-2 alert, the Phase-3 status update, and the progress milestones.
    let fs = null;
    if (fc && (cfg.firstSweepAlert || cfg.statusUpdateEnabled || cfg.progressAlerts || cfg.sweep15Alert || cfg.timingClock)) {
      try { fs = await analyzeFirstSweep(inst, fc.prev, fc.cur); } catch {}
    }

    // TIMING CLOCK — measured zone reminders (sweeptiming-study.mjs, n=182 real):
    //   OPEN:   first side taken in hour 1 → 82% of completions start like this;
    //           if it completes, median arrival ~2h in; zone closes ~3h15.
    //   CLOSED: 3h15 elapsed, first sweep happened, no completion → 90% of
    //           completions would have arrived; stand down on this candle.
    // Completion itself ends the clock silently (BOTH SIDES alert covers it).
    if (cfg.timingClock && fc && fs) {
      if (state.tcSeen[inst.key]?.t !== fc.cur.t) state.tcSeen[inst.key] = { t: fc.cur.t };
      const tc = state.tcSeen[inst.key];
      const elapsedMin = (nowSec() - fc.cur.t) / 60;
      const completed = detectSweep(fc.prev, fc.cur) != null;
      if (completed) { tc.open = 1; tc.closed = 1; }
      else {
        if (!tc.open && fs.sweepElapsedPct <= 25 && elapsedMin <= 180) { tc.open = 1; tcOpenBatch.push({ inst, fs, fc }); }
        if (!tc.closed && elapsedMin >= 195) { tc.closed = 1; tcClosedBatch.push({ inst, fs, fc }); }
      }
    }

    // 15m SOL CHECK — the instant the first side is taken (fresh breach only),
    // pull the 15m chart and report whether a clean SOL formed. Once per candle.
    // On restart mid-candle a stale breach is marked seen silently (no spam).
    // If the breach bar was still forming, a PENDING verdict is queued so the
    // promised "verdict at its close" actually arrives (gap the user caught).
    if (cfg.sweep15Alert && emitSweep15 && fc && fs && state.sweep15Seen[inst.key] !== fc.cur.t) {
      state.sweep15Seen[inst.key] = fc.cur.t;
      if (nowSec() - fs.at <= 1200) {
        try {
          const s = await emitSweep15(inst, fc, fs, candles);
          if (s && !s.barClosed) state.sweep15Pending[inst.key] = { curT: fc.cur.t, side: s.side, breachT: s.breachT };
        } catch (e) { console.log("  sweep15 error:", e.message); }
      }
    }

    // PENDING 15m SOL VERDICT — once the breach bar has closed, deliver it.
    const pend = state.sweep15Pending[inst.key];
    if (pend && emitSweep15Verdict) {
      if (!fc || fc.cur.t !== pend.curT) delete state.sweep15Pending[inst.key]; // candle rolled over
      else if (nowSec() >= pend.breachT + 900 + 20) {
        delete state.sweep15Pending[inst.key];
        try { await emitSweep15Verdict(inst, fc, pend, candles); } catch (e) { console.log("  sweep15 verdict error:", e.message); }
      }
    }

    // (A0) STAGE 2 — first-sweep "manipulation candidate" heads-up, once per candle.
    if (cfg.firstSweepAlert && emitFirstSweep && fc && fs && state.firstSweepSeen[inst.key] !== fc.cur.t) {
      state.firstSweepSeen[inst.key] = fc.cur.t; // one first-sweep event per candle — mark seen regardless
      const fresh = (nowSec() - fs.at) <= 1200;  // only alert if the breach is within ~the last 15m bar
      if (fresh && fs.sweepElapsedPct <= cfg.firstSweepMaxElapsedPct) fsBatch.push({ inst, fs });
    }

    // (A1) PHASE 3 — factual status update once past statusUpdatePct, only while
    // one side is swept and the double-sweep hasn't completed (the "waiting" state).
    if (cfg.statusUpdateEnabled && emitStatus && fc && fs && state.statusSeen[inst.key] !== fc.cur.t) {
      const bothSwept = detectSweep(fc.prev, fc.cur) != null;
      if (!bothSwept && fs.timeProgressPct >= cfg.statusUpdatePct) {
        state.statusSeen[inst.key] = fc.cur.t;
        stBatch.push({ inst, fs });
      }
    }

    // (A2) PROGRESS MILESTONES — after sweep1, announce when B's extreme crosses
    // each threshold on its way back toward the un-swept side, and the instant it
    // completes (100%). Progress is monotonic (built from B's running extremes),
    // so a crossing can't flap. On the FIRST observation of a candle (fresh start
    // or bot restart) already-crossed levels are primed silently — no stale spam.
    if (cfg.progressAlerts && emitMilestone && fc && fs) {
      const firstLook = state.progSeen[inst.key]?.t !== fc.cur.t;
      if (firstLook) state.progSeen[inst.key] = { t: fc.cur.t, fired: {} };
      const fired = state.progSeen[inst.key].fired;
      const completed = detectSweep(fc.prev, fc.cur) != null;
      if (completed) {
        // fc+candles ride along so the both-sides alert can attach the 4H+15m charts
        if (!fired[100]) { fired[100] = 1; if (!firstLook) msBatch.push({ inst, fs, T: 100, fc, candles }); }
      } else {
        const prog = 100 - Math.max(0, fs.rem.pctA);
        const crossed = (cfg.progressThresholds || []).filter((T) => prog >= T && !fired[T]);
        if (crossed.length) {
          for (const T of crossed) fired[T] = 1;                 // collapse multi-level jumps
          if (!firstLook) msBatch.push({ inst, fs, T: Math.max(...crossed), prog });
        }
      }
    }

    // (A) FORMING heads-up — fire once per forming candle when within the lead window.
    if (cfg.alertLeadMinutes > 0) {
      const fc = formingCandle(candles);
      if (fc && state.formingSeen[inst.key] !== fc.cur.t) {
        const minsLeft = (fc.cur.t + GRAN - nowSec()) / 60;
        if (minsLeft > 0 && minsLeft <= cfg.alertLeadMinutes) {
          const sig = detectSweep(fc.prev, fc.cur);
          if (sig && passesFilter(sig, cfg)) {
            state.formingSeen[inst.key] = fc.cur.t;
            await emit(inst, sig, "forming", Math.round(minsLeft));
          }
        }
      }
    }

    // (B) CLOSE confirmation — once per newly-closed candle.
    if (cfg.confirmAtClose) {
      const lc = lastClosed(candles);
      if (!lc) continue;
      const epoch = lc.cur.t;
      const seen = state.lastSeen[inst.key];
      if (seen === undefined) { state.lastSeen[inst.key] = epoch; continue; } // prime silently
      if (epoch <= seen) continue;
      state.lastSeen[inst.key] = epoch;

      const sig = detectSweep(lc.prev, lc.cur);
      if (sig && passesFilter(sig, cfg)) await emit(inst, sig, "closed", 0);
      else if (state.formingSeen[inst.key] === epoch) {
        await emit(inst, { dir: "—", strength: "—", cur: lc.cur, sweptHigh: lc.prev.high, sweptLow: lc.prev.low, bodyPct: 0, engulf: false }, "fizzled", 0);
      } else {
        console.log(`[${new Date().toISOString().slice(11, 19)}] ${inst.label}: closed ${fmtTime(epoch, cfg.displayTzOffset, cfg.displayTzLabel)} — ${sig ? "sweep filtered" : "no sweep"}`);
      }
    }
  }

  // flush the burst batches — one digest each (or full detail if only one fired)
  if (fsBatch.length && emitFirstSweep) await emitFirstSweep(fsBatch);
  if (stBatch.length && emitStatus) await emitStatus(stBatch);
  if (msBatch.length && emitMilestone) await emitMilestone(msBatch);
  if ((tcOpenBatch.length || tcClosedBatch.length) && emitTiming) await emitTiming(tcOpenBatch, tcClosedBatch);
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  const token = cfg.telegram?.token && !cfg.telegram.token.startsWith("PASTE") ? cfg.telegram.token : null;
  let chatId = cfg.telegram?.chatId || null;
  const wa = cfg.whatsapp || {};
  const waReady = !!(wa.enabled && wa.token && wa.phoneNumberId && wa.toNumber);

  // SETUP mode (Telegram)
  if (SETUP) {
    if (!token) return console.log("No token in config.json. Copy config.example.json → config.json and paste your BotFather token first.");
    const me = await tgGetMe(token);
    console.log(`✅ Bot OK: @${me.username}`);
    const id = await tgResolveChatId(token);
    if (id) { saveField("telegram.chatId", id); console.log(`✅ Found your chat id: ${id} (saved to config.json)`); await tgSend(token, id, "✅ Sweep monitor connected. You'll get 4H sweep alerts here."); console.log("✅ Sent you a test message — check Telegram."); }
    else console.log("⚠ Send your bot any message in Telegram first (e.g. 'hi'), then re-run: node monitor.mjs --setup");
    return;
  }

  // SETUP mode (WhatsApp)
  if (SETUP_WA) {
    if (!wa.token || !wa.phoneNumberId) return console.log("Set whatsapp.token and whatsapp.phoneNumberId in config.json first (from the Meta developer dashboard).");
    if (!wa.toNumber) return console.log("Set whatsapp.toNumber in config.json — YOUR WhatsApp number in international format, no + or leading 0 (e.g. \"2348012345678\").");
    try {
      const info = await verifyWhatsAppConfig(wa.token, wa.phoneNumberId);
      console.log(`✅ WhatsApp sender OK: ${info.display_phone_number} (${info.verified_name || "unverified name"})`);
    } catch (e) { return console.log(`❌ Config check failed: ${e.message}`); }
    try {
      await sendWhatsApp(wa.token, wa.phoneNumberId, wa.toNumber, "✅ Sweep monitor connected. You'll get 4H sweep alerts here.");
      console.log("✅ Sent you a test message — check WhatsApp.");
    } catch (e) {
      if (e.message.startsWith("WA_WINDOW_CLOSED")) console.log("⚠ Send the bot's WhatsApp number a message first (e.g. 'hi'), then re-run: node monitor.mjs --setup-whatsapp");
      else console.log(`❌ Send failed: ${e.message}`);
    }
    return;
  }

  const dry = !(token && chatId) && !waReady;
  if (token && !chatId) { chatId = await tgResolveChatId(token); if (chatId) saveField("telegram.chatId", chatId); }
  const tgReady = !!(token && chatId);

  // Telegram channels linked at runtime via "/link ote" / "/link alerts" /
  // "/link reals" / "/link deriv" posted in a channel the bot admins. Read
  // fresh from config.json on every send so a /link takes effect immediately
  // — no restart needed.
  //   ote   — A-grade OTE setups only (reals)
  //   reals — every Gold/Nasdaq/GBPJPY alert (4H sweeps, OTE, digests)
  //   deriv — every synthetics alert (SOL-fib engine)
  //   all   — mirror of literally everything (existing catch-all)
  const channelIds = () => {
    try {
      const t = loadConfig().telegram || {};
      return { ote: t.oteChannelId || null, all: t.alertsChannelId || null, reals: t.realsChannelId || null, deriv: t.derivChannelId || null };
    } catch { return { ote: null, all: null, reals: null, deriv: null }; }
  };

  // Fan out one alert to every configured channel. `stream` ("reals" | "deriv")
  // additionally mirrors to that dedicated group if linked. Each channel fails
  // independently (e.g. WhatsApp's 24h window closing doesn't touch Telegram).
  const sendAlert = async (text, stream = null) => {
    if (tgReady) { try { await tgSend(token, chatId, text); } catch (e) { console.log("  telegram error:", e.message); } }
    const ch = channelIds();
    if (tgReady && ch.all) { try { await tgSend(token, ch.all, text); } catch (e) { console.log("  alerts-channel error:", e.message); } }
    if (tgReady && stream && ch[stream]) { try { await tgSend(token, ch[stream], text); } catch (e) { console.log(`  ${stream}-channel error:`, e.message); } }
    if (waReady) {
      try { await sendWhatsApp(wa.token, wa.phoneNumberId, wa.toNumber, text); }
      catch (e) {
        if (e.message.startsWith("WA_WINDOW_CLOSED")) console.log("  whatsapp: 24h window closed — message the bot's WhatsApp number to re-open it");
        else console.log("  whatsapp error:", e.message);
      }
    }
  };

  const emit = async (inst, s, phase = "closed", minsLeft = 0) => {
    const tag = phase === "forming" ? "⏳ FORMING" : phase === "fizzled" ? "⚠️ FIZZLED" : "✅ CONFIRMED";
    const when = fmtTime(s.cur.t, cfg.displayTzOffset, cfg.displayTzLabel);
    const line = phase === "fizzled"
      ? `${idTag(inst)}  setup fizzled @ ${when}`
      : `${idTag(inst)}  ${s.dir}  ${s.strength}  swept H ${fmt(s.sweptHigh)}/L ${fmt(s.sweptLow)} body ${(s.bodyPct * 100).toFixed(0)}%${phase === "forming" ? `  (~${minsLeft}m left)` : ""}  @ ${when}`;
    console.log(`🔔 ${tag}  ${line}`);

    logEvent({
      event: phase === "forming" ? "second_sweep" : phase === "fizzled" ? "fizzled" : "confirmed",
      phase: phase === "forming" ? 4 : 5,
      inst: inst.key, session: sessionOf(s.cur.t),
      h4Open: fmtTime(s.cur.t, cfg.displayTzOffset, cfg.displayTzLabel),
      bias: s.dir, strength: s.strength,
      sweptHigh: s.sweptHigh, sweptLow: s.sweptLow, close: s.cur.close,
      bodyPct: s.bodyPct != null ? +(s.bodyPct * 100).toFixed(1) : null,
      engulf: s.engulf, biggerBody: s.biggerBody,
    });

    // 15m entry plan (former/sweep candle times + SOL) for real setups
    let ltf = null;
    if (cfg.ltfEnabled && phase !== "fizzled" && s.prev && s.cur) {
      try { ltf = ltfLines(await analyzeLTF(inst, s.prev, s.cur, s.dir, { bufferHours: cfg.ltfBufferHours }), cfg); } catch {}
    }
    if (ltf) ltf.forEach((l) => console.log(`     ↳ ${l}`));

    // Candle B narrative (multi-sweep catalogue + chronological replay) — only at close.
    let bn = null;
    if (cfg.narrativeEnabled && phase === "closed" && s.prev && s.cur) {
      try {
        bn = await analyzeB(inst, s.prev, s.cur, s.dir);
        console.log(`     ↳ ${bSummaryLine(bn).replace(/<[^>]+>/g, "")}`);
        logEvent({ event: "candleB_narrative", phase: 5, inst: inst.key, session: sessionOf(s.cur.t),
          h4Open: fmtTime(s.cur.t, cfg.displayTzOffset, cfg.displayTzLabel),
          sweepCount: bn.sweepCount, firstSide: bn.firstSide,
          largestSide: bn.largest?.side ?? null, largestDist: bn.largest ? +bn.largest.dist.toFixed(4) : null,
          largestPctA: bn.largest ? +bn.largest.pctA.toFixed(1) : null,
          bodyPctA: +bn.bodyPctA.toFixed(1), rangeRatioPctA: +bn.rangeRatioPct.toFixed(1) });
      } catch {}
    }

    if (!dry) {
      let txt = alertText(inst, s, cfg, phase, minsLeft);
      if (bn) {
        txt += `\n\n<b>📋 Candle B summary</b>\n${bSummaryLine(bn)}`;
        const nl = narrativeLines(bn, cfg);
        if (nl.length) txt += `\n\n<b>🎬 Narrative</b>\n<code>${nl.join("\n")}</code>`;
      }
      if (ltf) txt += `\n\n<b>↓ 15m entry plan</b>\n` + ltf.join("\n");
      await sendAlert(txt, "reals");
    }
  };

  const byNearest = (a, b) => Math.max(0, a.fs.rem.pctA) - Math.max(0, b.fs.rem.pctA);

  const emitFirstSweep = async (batch) => {
    batch.sort(byNearest);
    for (const { inst, fs } of batch) {
      console.log(`🔔 ${firstSweepLine(inst, fs, fmt)}`);
      logEvent({
        event: "first_sweep", phase: 2, inst: inst.key, session: fs.session,
        h4Open: fmtTime(fs.h4Open, cfg.displayTzOffset, cfg.displayTzLabel),
        side: fs.side, sweepElapsedPct: +fs.sweepElapsedPct.toFixed(1),
        distance: fs.distance, distancePctPrev: +fs.distancePctPrev.toFixed(1),
        bodyPct: +fs.bodyPct.toFixed(1), color: fs.color, completionOdds: fs.completionOdds,
        coveragePctA: +fs.geo.coveragePct.toFixed(1), rangeRatioPctA: +fs.geo.rangeRatioPct.toFixed(1),
        bodyDominancePct: +fs.geo.bodyDominancePct.toFixed(1), bodyReclaimedPct: +fs.geo.bodyReclaimedPct.toFixed(1),
        bodyVsAClosePct: +fs.geo.bodyVsAClosePct.toFixed(1), toOppositePctA: +fs.rem.pctA.toFixed(1),
      });
    }
    if (dry) return;
    if (batch.length === 1) { await sendAlert(firstSweepText(batch[0].inst, batch[0].fs, cfg, fmt), "reals"); return; }
    const f = batch[0].fs;
    const head = `🟠 <b>Phase 2 · first sweep</b> — ${batch.length} pairs · H4 ${fmtTime(f.h4Open, cfg.displayTzOffset, cfg.displayTzLabel)} · ${f.session}\n<i>sorted by closeness to opposite side (toOpp)</i>`;
    const body = batch.map(({ inst, fs }) => firstSweepDigestLine(inst, fs)).join("\n");
    await sendAlert(`${head}\n${body}`, "reals");
  };

  const emitStatus = async (batch) => {
    batch.sort(byNearest);
    for (const { inst, fs } of batch) {
      console.log(`🔔 ${statusLine(inst, fs)}`);
      logEvent({
        event: "status", phase: 3, inst: inst.key, session: fs.session,
        h4Open: fmtTime(fs.h4Open, cfg.displayTzOffset, cfg.displayTzLabel),
        firstSide: fs.side, timeProgressPct: +fs.timeProgressPct.toFixed(1),
        priceProgressPct: +fs.priceProgressPct.toFixed(1), efficiencyPct: +fs.efficiencyPct.toFixed(1),
        coveragePctA: +fs.geo.coveragePct.toFixed(1), toOppositePctA: +fs.rem.pctA.toFixed(1),
      });
    }
    if (dry) return;
    if (batch.length === 1) { await sendAlert(statusText(batch[0].inst, batch[0].fs, cfg, fmt), "reals"); return; }
    const f = batch[0].fs;
    const head = `🔵 <b>Phase 3 · status</b> — ${batch.length} waiting · H4 ${fmtTime(f.h4Open, cfg.displayTzOffset, cfg.displayTzLabel)} · ${f.session} · ${f.timeProgressPct.toFixed(0)}% elapsed\n<i>sorted by closeness to completing the double-sweep</i>`;
    const body = batch.map(({ inst, fs }) => statusDigestLine(inst, fs)).join("\n");
    await sendAlert(`${head}\n${body}`, "reals");
  };

  // MEASURED completion odds by progress threshold (progress-study.mjs — 635
  // real / 2257 synthetic first-sweep candles). Mostly random-walk geometry
  // (synthetics show nearly the same ladder), but true odds either way.
  const MS_ODDS = { real: { 50: 36, 70: 56, 90: 83 }, synth: { 50: 29, 70: 48, 90: 79 } };
  const MS_MINS = { real: { 50: 45, 70: 15, 90: 0 }, synth: { 50: 60, 70: 30, 90: 0 } };
  const msFam = (inst) => (inst.key.startsWith("V") ? "synth" : "real");
  const msOddsFor = (inst, T) => {
    const keys = Object.keys(MS_ODDS.real).map(Number).filter((k) => k <= T);
    if (!keys.length) return null;
    const k = Math.max(...keys);
    return { p: MS_ODDS[msFam(inst)][k], m: MS_MINS[msFam(inst)][k], at: k };
  };

  // BOTH SIDES TAKEN — the user's actual setup moment ("my losses are the ones
  // I didn't wait for both sides"). Full treatment: 4H context chart (both
  // swept levels) + 15m chart with a SOL check on the SECOND sweep — the
  // rejection they trade — with the follow-up verdict queued if it's forming.
  const emitBothSides = async ({ inst, fs, fc, candles }) => {
    const second = fs.oppositeSide; // just-completed side
    let s = null;
    try { s = await analyzeSweep15(inst, fc.prev, fc.cur, second); } catch {}
    const closeT = fmtTime(fs.h4Open + GRAN, cfg.displayTzOffset, cfg.displayTzLabel);
    let txt =
      `${idTag(inst)} — ✅ <b>BOTH SIDES TAKEN</b>\n` +
      `<i>double-sweep complete mid-candle · ${fs.side.toUpperCase()} first, ${second.toUpperCase()} just now</i>\n\n`;
    if (s) {
      const v = solVerdict(s);
      logEvent({
        event: "sweep15_check", inst: inst.key, session: fs.session,
        h4Open: fmtTime(fs.h4Open, cfg.displayTzOffset, cfg.displayTzLabel),
        side: second, level: +s.level.toFixed(6),
        breachT: fmtTime(s.breachT, cfg.displayTzOffset, cfg.displayTzLabel),
        barClosed: s.barClosed, cleanSOL: s.barClosed ? s.reclaimed : null,
        rejWickPct: +s.rejWickPct.toFixed(1), extPctA: +s.extPctA.toFixed(1), holding: s.holding, onCompletion: true,
      });
      txt +=
        `${v.icon} <b>2nd sweep on 15m: ${v.text}</b>\n` +
        `Level <code>${fmt(s.level)}</code> · rejection wick ${s.rejWickPct.toFixed(0)}% · extended ${s.extPctA.toFixed(0)}% of A\n\n`;
    }
    txt += `Bias is decided by the CLOSE (${closeT}) — a full-body close makes it valid.\nNow <code>${fmt(fc.cur.close)}</code>`;
    if (s) {
      await sendChartsAlert(inst, s, fc, candles, txt, true);
      if (!s.barClosed) state.sweep15Pending[inst.key] = { curT: fc.cur.t, side: second, breachT: s.breachT };
    } else {
      await sendAlert(txt, "reals");
    }
  };

  const emitMilestone = async (batch) => {
    batch.sort((a, b) => b.T - a.T); // completions and highest progress first
    for (const { inst, fs, T, prog } of batch) {
      console.log(`🔔 ${idTag(inst)}  ${T === 100 ? "✅ BOTH SIDES TAKEN" : `🎯 ${Math.round(prog)}% toward ${fs.oppositeSide.toUpperCase()}`}`);
      logEvent({ event: "progress", inst: inst.key, session: fs.session,
        h4Open: fmtTime(fs.h4Open, cfg.displayTzOffset, cfg.displayTzLabel),
        milestone: T, progressPct: T === 100 ? 100 : +prog.toFixed(1), firstSide: fs.side });
    }
    if (dry) return;
    // completions get the full chart treatment, individually — they're the setup
    const dones = batch.filter((b) => b.T === 100);
    for (const b of dones) {
      try { await emitBothSides(b); } catch (e) { console.log("  both-sides alert error:", e.message); }
    }
    const rest = batch.filter((b) => b.T !== 100);
    if (!rest.length) return;
    const msg = ({ inst, fs, T, prog }) => {
      const o = msOddsFor(inst, T);
      return `${idTag(inst)} — 🎯 <b>${Math.round(prog)}% toward ${fs.oppositeSide.toUpperCase()}</b>\n<i>progress · ${fs.side.toUpperCase()} swept earlier, working back across A</i>\nOpposite level <code>${fmt(fs.oppositeLevel)}</code> · remaining <code>${fmt(Math.max(0, fs.rem.dist), 2)}</code>\n📊 measured: candles crossing ${o.at}% completed ${o.p}% of the time (median ~${o.m}m to finish)`;
    };
    if (rest.length === 1) { await sendAlert(msg(rest[0]), "reals"); return; }
    const lines = rest.map(({ inst, fs, T, prog }) =>
      `${inst.emoji || "▫️"} <b>${inst.short || inst.label}</b> · 🎯 ${Math.round(prog)}% → ${fs.oppositeSide.toUpperCase()}`);
    await sendAlert(`🎯 <b>Progress</b> — ${rest.length} pairs\n${lines.join("\n")}`, "reals");
  };

  // A-GRADE OTE / structure setup — the validated edge. One clean, actionable
  // message: entry zone, stop, target, displacement strength. Honest tail: it's
  // a defined-risk opportunity, NOT a prediction (~55–60% hit rate in backtest).
  const emitOTE = async (inst, o, tfMin = 240) => {
    const d = Math.max(dec(o.stop), dec(o.target));
    const long = o.dir === "LONG";
    const tfLabel = tfMin >= 240 ? "4H" : tfMin >= 60 ? `${tfMin / 60}H` : `${tfMin}m`;
    const extHrs = (30 * tfMin) / 60; // EXT=30 candles → depth-window span for this timeframe
    const extSpan = extHrs >= 48 ? `${Math.round(extHrs / 24)}-day` : `~${Math.round(extHrs)}-hour`;
    const rr = (long ? (o.target - o.entryNear) / (o.entryNear - o.stop)
                     : (o.entryNear - o.target) / (o.stop - o.entryNear));
    const zoneLo = fmt(Math.min(o.entryNear, o.entryFar), d);
    const zoneHi = fmt(Math.max(o.entryNear, o.entryFar), d);
    console.log(`${o.kind === "fib618" ? "📐 FIB618" : "🎯 OTE"} ${o.dir} ${idTag(inst)} zone ${zoneLo}-${zoneHi} stop ${fmt(o.stop, d)} tgt ${fmt(o.target, d)} disp ${o.dispX.toFixed(1)}x`);
    logEvent({
      event: "ote_setup", kind: o.kind || "ote", inst: inst.key, dir: o.dir, session: sessionOf(o.sweepT),
      sweepT: fmtTime(o.sweepT, cfg.displayTzOffset, cfg.displayTzLabel),
      entryNear: +o.entryNear.toFixed(6), entryFar: +o.entryFar.toFixed(6),
      stop: +o.stop.toFixed(6), target: +o.target.toFixed(6), dispX: +o.dispX.toFixed(2),
      deep: !!o.deep, // A+ = swept level was the 30-candle range extreme
      fvg: o.fvg ? { top: +o.fvg.top.toFixed(6), bot: +o.fvg.bot.toFixed(6) } : null,
    });
    if (dry) return;
    const fib = o.kind === "fib618";
    let txt;
    if (fib) {
      // SYNTHETICS — 61.8% fib reversal. Geometry only (RNG walk, no liquidity).
      txt =
        `${idTag(inst)} — 📐 <b>61.8% Fib Reversal ${long ? "LONG" : "SHORT"}</b> · <b>${tfLabel}</b>\n` +
        `<i>impulse leg → retraced to the 0.618 → candle closed back ${long ? "up" : "down"} (reversal)</i>\n` +
        `\n` +
        `Entry        <code>${fmt(o.entryNear, d)}</code>  (0.618 fib)\n` +
        `Stop         <code>${fmt(o.stop, d)}</code>  (0.786 fib — reversal failed if broken)\n` +
        `Target       <code>${fmt(o.target, d)}</code>  (leg ${long ? "high" : "low"}) · ~${rr.toFixed(1)}R\n` +
        `Impulse leg  <b>${o.dispX.toFixed(1)}×</b> median range\n` +
        `\n⚠️ <i>Synthetic (RNG walk) — a geometric level with no liquidity behind it. Experimental & UNVALIDATED: no backtested edge yet. Defined-risk geometry, not a proven signal.</i>`;
    } else {
      const grade = o.deep
        ? `Grade <b>A+</b> — swept level was the <b>${extSpan} range extreme</b> (deep liquidity)`
        : `Grade <b>A</b> — swept level was a minor swing (not the range extreme)`;
      txt =
        `${idTag(inst)} — 🎯 <b>OTE ${long ? "LONG" : "SHORT"} setup</b> · <b>${tfLabel}</b>\n` +
        `<i>swept ${long ? "low" : "high"} → strong displacement → retraced into the OTE zone</i>\n` +
        `\n` +
        `${grade}\n` +
        `Entry zone   <code>${zoneLo} – ${zoneHi}</code>  (0.62–0.79 retrace)\n` +
        (o.fvg ? `FVG inside   <code>${fmt(o.fvg.bot, d)} – ${fmt(o.fvg.top, d)}</code>  ← fine-tuned entry (gaps tap 82%)\n` : "") +
        `Stop         <code>${fmt(o.stop, d)}</code>  (swept ${long ? "low" : "high"})\n` +
        `Target       <code>${fmt(o.target, d)}</code>  (leg ${long ? "high" : "low"}) · ~${rr.toFixed(1)}R at the near edge\n` +
        `Displacement <b>${o.dispX.toFixed(1)}×</b> median range — strong\n` +
        (tfMin >= 240
          ? `\n📊 backtest: ~55–60% hit target; deep-extreme setups ran better (small sample — grade is a fact, not a promise). You decide.`
          : `\n📊 <i>${tfLabel} entry-timeframe pattern. The ~55–60% backtest was measured on H4, not here — treat this as an execution trigger inside your H4 bias, not a standalone validated edge.</i>`);
    }
    // Position size from the live /risk settings (read fresh so /risk applies
    // without a restart). One stop-out = exactly riskPct of the account.
    try {
      const acct = loadConfig().account || {};
      if (acct.balance > 0) {
        const ps = await positionSize(inst, o.entryNear, o.stop, acct.balance, acct.riskPct || 1);
        if (ps) txt += `\n\n💰 <b>Size for ${acct.riskPct || 1}% risk</b> ($${ps.riskUsd.toFixed(2)} of $${acct.balance}): ${ps.note}\n<i>Set once, never widen the stop.</i>`;
      }
    } catch {}
    // Chart snapshot drawn on the SAME timeframe the OTE was detected on (15m by
    // default, 1H for the 4H structural version). Image is a bonus: if the render
    // or photo-send fails for any reason, the TEXT alert still goes.
    let chartUrl = null;
    if (tgReady) {
      try {
        const bars = tfMin >= 60 ? await fetch1H(inst, chartCandleCount(o)) : await fetch15m(inst, chartCandleCount(o));
        chartUrl = await renderOTEChart(inst, o, bars);
      } catch {}
    }
    const ch = channelIds();
    // Dedicated OTE channel gets its copy first (photo if we have one) — this is
    // the never-miss stream, nothing else posts there.
    if (tgReady && ch.ote) {
      try { chartUrl ? await tgSendPhoto(token, ch.ote, chartUrl, txt) : await tgSend(token, ch.ote, txt); }
      catch (e) { console.log("  ote-channel error:", e.message); }
    }
    if (chartUrl) {
      try { await tgSendPhoto(token, chatId, chartUrl, txt); } catch (e) { console.log("  ote photo error:", e.message); await sendAlert(txt, "reals"); return; }
      // sendAlert not used on this path — cover its other outputs: the mirror
      // channel, the reals channel, and WhatsApp still get the text.
      if (ch.all) { try { await tgSend(token, ch.all, txt); } catch (e) { console.log("  alerts-channel error:", e.message); } }
      if (ch.reals) { try { await tgSend(token, ch.reals, txt); } catch (e) { console.log("  reals-channel error:", e.message); } }
      if (waReady) { try { await sendWhatsApp(wa.token, wa.phoneNumberId, wa.toNumber, txt); } catch (e) { console.log("  whatsapp error:", e.message); } }
    } else {
      await sendAlert(txt, "reals");
    }
  };

  // SOL-FIB ENGINE (synthetics) — the user's charted playbook, encoded.
  // Three phases per setup: armed (fib map) → 0.618 tap → 0.886 deep tap.
  const emitSOLFib = async (inst, tf, s, phase, bars) => {
    const d = dec(s.solX);
    const long = s.dir === "LONG";
    const tfL = tf >= 60 ? `${tf / 60}H` : `${tf}m`;
    const lv = s.levels;
    const F = (p) => fmt(p, d);
    const stopBeyond = s.solX; // invalidation = the SOL extreme (1.0), their red-box rule
    const rrFrom = (entry) => Math.abs(entry - s.target) / Math.max(Math.abs(stopBeyond - entry), 1e-9);
    console.log(`🧲 SOLFIB ${phase} ${idTag(inst)} ${tfL} ${s.dir} sol ${F(s.solX)} tgt ${F(s.target)} age ${s.ageBars}/leg ${s.legBars}`);
    logEvent({
      event: "solfib", phase, inst: inst.key, tf, dir: s.dir, session: sessionOf(s.solT),
      solT: fmtTime(s.solT, cfg.displayTzOffset, cfg.displayTzLabel),
      sol: +s.solX.toFixed(6), target: +s.target.toFixed(6),
      l618: +lv[0.618].toFixed(6), l886: +lv[0.886].toFixed(6),
      legBars: s.legBars, ageBars: s.ageBars, aged: s.aged, dispX: +s.dispX.toFixed(2),
      fvgs: s.fvgs.map((g) => ({ top: +g.top.toFixed(6), bot: +g.bot.toFixed(6), near: g.near })),
    });
    if (dry) return;
    const fvgLines = s.fvgs.map((g) => `FVG @ ~${g.near}   <code>${F(g.bot)} – ${F(g.top)}</code>`).join("\n");
    const ageRead = s.aged
      ? `<b>aged</b> (retrace ${s.ageBars} bars vs leg ${s.legBars}) → deep <b>0.886</b> is the higher-odds reaction`
      : `<b>fresh</b> (retrace ${s.ageBars} bars vs leg ${s.legBars}) → <b>0.618</b> expected to hold`;
    let txt;
    if (phase === "armed") {
      txt =
        `${idTag(inst)} · <b>${tfL}</b> — 🧲 <b>SOL fib armed · ${s.dir}</b>\n` +
        `<i>SOL took the ${long ? "low" : "high"} <code>${F(s.solX)}</code> → impulse to <code>${F(s.target)}</code> (${s.dispX.toFixed(1)}× median, ${s.legBars} bars) → retrace reached 0.5</i>\n\n` +
        `0.500   <code>${F(lv[0.5])}</code>\n` +
        `0.618   <code>${F(lv[0.618])}</code> ← classic hold\n` +
        `0.786   <code>${F(lv[0.786])}</code>\n` +
        `0.886   <code>${F(lv[0.886])}</code> ← deep (aged SOLs)\n` +
        (fvgLines ? fvgLines + "\n" : "") +
        `\nRead: ${ageRead}\n` +
        `Invalidation ${long ? "below" : "above"} <code>${F(s.solX)}</code> · target <code>${F(s.target)}</code>\n` +
        `<i>Experimental structure engine — UNVALIDATED geometry, not a promise.</i>`;
    } else {
      const deep = phase === "tap886";
      const entry = deep ? lv[0.886] : lv[0.618];
      const rr = rrFrom(entry);
      txt =
        `${idTag(inst)} · <b>${tfL}</b> — ${deep ? "🎯🎯 <b>0.886 DEEP tap" : "🎯 <b>0.618 tap"} & rejection · ${s.dir}</b>\n` +
        `<i>wicked <code>${F(entry)}</code>, now back ${long ? "above" : "below"} at <code>${F(s.price)}</code></i>\n\n` +
        `Entry   <code>${F(entry)}</code>\n` +
        `Stop    <code>${F(stopBeyond)}</code>  (beyond the SOL — reversal wrong if taken)\n` +
        `Target  <code>${F(s.target)}</code>  (leg extreme) · ~${rr.toFixed(1)}R\n` +
        (deep
          ? `\nThis is the deep entry — the one aged SOLs pay.`
          : (s.aged
            ? `\n⚠️ Aged SOL: 0.886 <code>${F(lv[0.886])}</code> is the higher-odds deep tap — consider 0.618 a partial, not the meal.`
            : `\nFresh SOL — 0.618 is the expected hold.`)) +
        `\n<i>Experimental — UNVALIDATED. Your read, your risk.</i>`;
    }
    // chart snapshot on the SAME timeframe, using the bars we already fetched
    let chartUrl = null;
    if (tgReady && phase !== "armed") {
      try {
        const oLike = {
          dir: s.dir, dispX: s.dispX, sweepT: s.solT, stop: stopBeyond, target: s.target,
          entryNear: lv[0.618], entryFar: lv[0.886],
          fvg: s.fvgs.length ? s.fvgs[s.fvgs.length - 1] : null,
          title: `${inst.short} ${tfL} — SOL fib ${s.dir} · ${phase === "tap886" ? "0.886 deep tap" : "0.618 tap"}`,
        };
        chartUrl = await renderOTEChart(inst, oLike, bars.slice(-Math.min(bars.length, 160)));
      } catch {}
    }
    if (chartUrl) {
      try { await tgSendPhoto(token, chatId, chartUrl, txt); }
      catch { await sendAlert(txt, "deriv"); return; }
      const ch = channelIds();
      if (ch.all) { try { await tgSend(token, ch.all, txt); } catch {} }
      if (ch.deriv) { try { await tgSend(token, ch.deriv, txt); } catch (e) { console.log("  deriv-channel error:", e.message); } }
      if (waReady) { try { await sendWhatsApp(wa.token, wa.phoneNumberId, wa.toNumber, txt); } catch {} }
    } else {
      await sendAlert(txt, "deriv");
    }
  };

  // USER PRICE ALERTS (/alert PAIR PRICE → 3 pings). checkPriceAlerts owns the
  // store and the 3-ping countdown; we just broadcast whatever it returns per
  // instrument's stream (reals group vs deriv group).
  const emitPrice = async (inst, candle) => {
    const stream = inst.key.startsWith("V") ? "deriv" : "reals";
    for (const msg of checkPriceAlerts(inst, candle)) {
      console.log(`🔔 PRICE ALERT ${idTag(inst)} @ ${fmt(candle.close)}`);
      await sendAlert(msg, stream);
    }
  };

  // TIMING CLOCK — compact text-only zone reminders, digest-batched. Facts
  // from sweeptiming-study.mjs; the "clock, not signal" framing is deliberate.
  const emitTiming = async (opens, closes) => {
    const T = (e) => fmtTime(e, cfg.displayTzOffset, cfg.displayTzLabel).slice(11); // HH:MM only
    for (const { inst, fs, fc } of opens) {
      console.log(`⏱ ZONE OPEN ${idTag(inst)} first ${fs.side} @ ${Math.round(fs.sweepElapsedPct)}%`);
      logEvent({ event: "timing_zone_open", inst: inst.key, session: fs.session, h4Open: fmtTime(fc.cur.t, cfg.displayTzOffset, cfg.displayTzLabel), side: fs.side, sweepElapsedPct: +fs.sweepElapsedPct.toFixed(1) });
    }
    for (const { inst, fs, fc } of closes) {
      console.log(`⏱ ZONE CLOSED ${idTag(inst)} no completion by 3h15`);
      logEvent({ event: "timing_zone_closed", inst: inst.key, session: fs.session, h4Open: fmtTime(fc.cur.t, cfg.displayTzOffset, cfg.displayTzLabel), side: fs.side });
    }
    if (dry) return;
    const parts = [];
    if (opens.length) {
      const lines = opens.map(({ inst, fs, fc }) =>
        `${inst.emoji || "▫️"} <b>${inst.short}</b> ${fs.side === "high" ? "⬆️" : "⬇️"}${fs.side.toUpperCase()} @${Math.round(fs.sweepElapsedPct)}% · median completion ~${T(fc.cur.t + 120 * 60)} · zone closes ${T(fc.cur.t + 195 * 60)}`);
      parts.push(
        `⏱ <b>Completion zone OPEN</b> — early first sweep (82% of completions start like this)\n${lines.join("\n")}\n` +
        `<i>Base odds still only ~17-21% — a clock, not a signal. The 90% alert calls you if it develops.</i>`);
    }
    if (closes.length) {
      const lines = closes.map(({ inst, fs }) =>
        `${inst.emoji || "▫️"} <b>${inst.short}</b> — ${fs.side.toUpperCase()} was taken, opposite never came`);
      parts.push(
        `⏱ <b>Zone CLOSED (3h15, no completion)</b> — 90% of completions would have arrived by now. Stand down on the double-sweep this candle.\n${lines.join("\n")}`);
    }
    for (const p of parts) await sendAlert(p, "reals");
  };

  // 15m SOL CHECK — chart pic + factual verdict the moment a side is taken.
  // The user's manual habit automated: "when a sweep happens, watch the 15m
  // immediately and see if a SOL cleanly formed". Facts + measured odds only.
  // Album sender shared by the sweep15 check + verdict: 4H context chart +
  // 15m detail chart in one message. Degrades gracefully — one chart if the
  // other fails to render, plain text if both do. Channels/WA get the text.
  const sendChartsAlert = async (inst, s, fc, candles, txt, both = false) => {
    let url15 = null, url4h = null;
    if (tgReady) {
      try { url15 = await renderSweep15Chart(inst, s, fc.prev); } catch {}
      try { url4h = await render4HContext(inst, candles, fc.prev, s.side, both); } catch {}
    }
    const urls = [url4h, url15].filter(Boolean); // 4H first: structure, then detail
    const ch = channelIds();
    if (urls.length) {
      try {
        if (urls.length > 1) await tgSendAlbum(token, chatId, urls, txt);
        else await tgSendPhoto(token, chatId, urls[0], txt);
      } catch (e) { console.log("  sweep15 send error:", e.message); await sendAlert(txt, "reals"); return; }
      if (ch.all) { try { await tgSend(token, ch.all, txt); } catch {} }
      if (ch.reals) { try { await tgSend(token, ch.reals, txt); } catch (e) { console.log("  reals-channel error:", e.message); } }
      if (waReady) { try { await sendWhatsApp(wa.token, wa.phoneNumberId, wa.toNumber, txt); } catch (e) { console.log("  whatsapp error:", e.message); } }
    } else {
      await sendAlert(txt, "reals");
    }
  };

  const emitSweep15 = async (inst, fc, fs, candles) => {
    const s = await analyzeSweep15(inst, fc.prev, fc.cur, fs.side);
    if (!s) return null;
    const v = solVerdict(s);
    const d = dec(s.level);
    const arrow = s.side === "high" ? "⬆️" : "⬇️";
    console.log(`🔔 15m SOL CHECK ${idTag(inst)} ${arrow}${s.side.toUpperCase()} @ ${fmt(s.level, d)} — ${v.text}`);
    logEvent({
      event: "sweep15_check", inst: inst.key, session: sessionOf(fc.cur.t),
      h4Open: fmtTime(fc.cur.t, cfg.displayTzOffset, cfg.displayTzLabel),
      side: s.side, level: +s.level.toFixed(6),
      breachT: fmtTime(s.breachT, cfg.displayTzOffset, cfg.displayTzLabel),
      barClosed: s.barClosed, cleanSOL: s.barClosed ? s.reclaimed : null,
      rejWickPct: +s.rejWickPct.toFixed(1), extPctA: +s.extPctA.toFixed(1),
      holding: s.holding,
    });
    if (dry) return s;
    const holdLine = s.afterN > 0
      ? `Since breach: ${s.afterN} closed bar${s.afterN > 1 ? "s" : ""} — ${s.holding ? "all held back inside ✅" : "closed beyond again ❌"}\n`
      : "";
    const txt =
      `${idTag(inst)} — ${arrow} <b>${s.side.toUpperCase()} of prior 4H taken</b> · 15m check\n` +
      `<i>your rule: sweep happened → look at 15m for a clean SOL</i>\n` +
      `\n` +
      `${v.icon} <b>${v.text}</b>\n` +
      `Level <code>${fmt(s.level, d)}</code> · breached ${fmtTime(s.breachT, cfg.displayTzOffset, cfg.displayTzLabel)}\n` +
      `Rejection wick ${s.rejWickPct.toFixed(0)}% of breach bar · extended ${s.extPctA.toFixed(0)}% of A beyond\n` +
      holdLine +
      `Now <code>${fmt(s.priceNow, d)}</code>\n` +
      `\n📊 measured: ~${fs.completionOdds}% of sweeps this early complete the opposite side; most one-side takes continue. A cue to look — not a signal.`;
    await sendChartsAlert(inst, s, fc, candles, txt);
    return s;
  };

  // Follow-up verdict once a pending breach bar closes — delivers the promise
  // "SOL verdict at its close". Short message, chart attached when possible.
  const emitSweep15Verdict = async (inst, fc, pend, candles) => {
    const s = await analyzeSweep15(inst, fc.prev, fc.cur, pend.side);
    if (!s || !s.barClosed) return;
    const v = solVerdict(s);
    const d = dec(s.level);
    const arrow = s.side === "high" ? "⬆️" : "⬇️";
    console.log(`🔔 15m SOL VERDICT ${idTag(inst)} ${arrow}${s.side.toUpperCase()} — ${v.text}`);
    logEvent({
      event: "sweep15_verdict", inst: inst.key, session: sessionOf(fc.cur.t),
      h4Open: fmtTime(fc.cur.t, cfg.displayTzOffset, cfg.displayTzLabel),
      side: s.side, level: +s.level.toFixed(6), cleanSOL: s.reclaimed,
      rejWickPct: +s.rejWickPct.toFixed(1), extPctA: +s.extPctA.toFixed(1), holding: s.holding,
    });
    if (dry) return;
    const holdLine = s.afterN > 0
      ? `Since: ${s.afterN} bar${s.afterN > 1 ? "s" : ""} — ${s.holding ? "held back inside ✅" : "closed beyond again ❌"}\n`
      : "";
    const txt =
      `${idTag(inst)} — ${v.icon} <b>15m SOL verdict</b> (follow-up)\n` +
      `${arrow} ${s.side.toUpperCase()} sweep at <code>${fmt(s.level, d)}</code>: <b>${v.text}</b>\n` +
      `Rejection wick ${s.rejWickPct.toFixed(0)}% · extended ${s.extPctA.toFixed(0)}% of A\n` +
      holdLine +
      `Now <code>${fmt(s.priceNow, d)}</code>`;
    await sendChartsAlert(inst, s, fc, candles, txt);
  };

  const nextClose = fmtTime(nextBoundary(cfg.bucketOffsetHours), cfg.displayTzOffset, cfg.displayTzLabel);
  const insts = selectedInstruments(cfg).map((i) => i.label).join(", ");
  const timing = `${cfg.alertLeadMinutes > 0 ? cfg.alertLeadMinutes + "m before close" : "at close"}${cfg.confirmAtClose ? " + confirm at close" : ""}`;
  const fp = codeFingerprint();
  const channels = [tgReady && `Telegram chat ${chatId}`, waReady && `WhatsApp ${wa.toNumber}`].filter(Boolean).join(" + ");
  console.log(`Sweep monitor ${dry ? "(DRY / console only — set up Telegram/WhatsApp for phone push)" : "→ " + channels}   [code ${fp}]`);
  console.log(`Watching: ${insts}`);
  console.log(`Times shown in: ${cfg.displayTzLabel} (UTC${cfg.displayTzOffset >= 0 ? "+" : ""}${cfg.displayTzOffset})   4H align: per-instrument (reals +1h OANDA grid, synthetics UTC grid)`);
  console.log(`Alerts: ${timing}   Level: ${cfg.alertLevel.toUpperCase()}${cfg.minBodyPct ? ` (min body ${(cfg.minBodyPct*100)|0}%)` : ""}   Poll: ${cfg.pollSeconds}s   Next 4H close ~ ${nextClose}`);
  console.log(`Stage-2 first-sweep heads-up: ${cfg.firstSweepAlert ? `on (up to ${cfg.firstSweepMaxElapsedPct}% elapsed)` : "off"}   Phase-3 status: ${cfg.statusUpdateEnabled ? `on (at ${cfg.statusUpdatePct}% if waiting)` : "off"}`);
  console.log(`Synthetics: ${cfg.solFib !== false ? `SOL-fib engine on ${(cfg.solFibTimeframes || [15, 30, 60]).map((t) => (t >= 60 ? t / 60 + "H" : t + "m")).join("/")} — 4H manipulation flow OFF for V-pairs` : "SOL-fib engine off"}\n`);

  // seen/dedup maps persisted in state.json (restart-proof); oteSeen has its own file
  const state = { ...loadRunState(), oteSeen: loadOteSeen() };

  if (ONCE) {
    // --once: show the forming candle's current state AND the last closed candle.
    for (const inst of selectedInstruments(cfg)) {
      let candles; try { candles = await fetch4H(inst, 6, cfg.bucketOffsetHours); } catch { continue; }
      const fc = formingCandle(candles);
      if (fc) {
        const mins = Math.round((fc.cur.t + GRAN - nowSec()) / 60);
        const sig = detectSweep(fc.prev, fc.cur);
        console.log(`${inst.label}: FORMING (~${mins}m to close) — ${sig ? `${sig.dir} ${sig.strength} double-sweep so far` : "no sweep yet"}`);
        try {
          const fs = await analyzeFirstSweep(inst, fc.prev, fc.cur);
          if (fs) {
            console.log(`     ↳ ${firstSweepLine(inst, fs, fmt)}`);
            if (!sig) console.log(`     ↳ ${statusLine(inst, fs)}`);
          }
        } catch {}
        if (sig && cfg.ltfEnabled) {
          try { ltfLines(await analyzeLTF(inst, sig.prev, sig.cur, sig.dir, { bufferHours: cfg.ltfBufferHours }), cfg).forEach((l) => console.log(`     ↳ ${l}`)); } catch {}
        }
      }
      const lc = lastClosed(candles);
      if (lc) {
        const sig = detectSweep(lc.prev, lc.cur);
        console.log(`   last closed ${fmtTime(lc.cur.t, cfg.displayTzOffset, cfg.displayTzLabel)} — ${sig ? `${sig.dir} ${sig.strength} sweep` : "no sweep"}`);
      }
    }
    return;
  }

  // Persistent run only: refuse to start if another monitor is already live,
  // so a botched restart can't leave two copies double-alerting. (--once/--setup
  // reach `return` above and never get here, so they always run.)
  const lock = await acquireLock();
  if (!lock) { console.log("⛔ Another monitor instance is already running — this copy will exit to avoid duplicate alerts."); return; }

  // Prime double-sweep state silently; first-sweep alerts are allowed on this pass
  // (a first sweep already in progress at startup is still current, worth flagging).
  await evaluate(cfg, state, emit, emitFirstSweep, emitStatus, emitMilestone, emitOTE, emitPrice, emitSweep15, emitSweep15Verdict, emitTiming, emitSOLFib);
  saveRunState(state);
  if (!dry) { await sendAlert(`🟢 <b>Sweep monitor live</b> (this is just the startup ping)\nWatching: ${insts}\nTimes in ${cfg.displayTzLabel}\nAlerts: ${timing}\nLevel: ${cfg.alertLevel.toUpperCase()}\nNext 4H close ~ ${nextClose}\nCode: <code>${fp}</code>\nChannels: ${[tgReady && "Telegram", waReady && "WhatsApp"].filter(Boolean).join(" + ") || "none"}\n<i>Detailed per-pair alerts (naming the pair) follow as sweeps happen.</i>`); }

  // Guard against overlapping AND fully-hung cycles: if a fetch ever hangs
  // (e.g. a stuck WebSocket after a network blip), plain setInterval would
  // keep stacking new evaluate() calls on top every poll, piling up
  // connections until the process chokes — that's what actually happened once.
  //   - busy flag: skip a tick if the previous one hasn't finished yet.
  //   - hard cap: if a cycle runs past 3x the poll interval, give up on it
  //     (log it, release the guard) so future ticks aren't blocked forever by
  //     one wedged cycle, even though the underlying dangling fetch leaks.
  // Daily heartbeat: makes SILENCE meaningful. Alerts only fire on events, so
  // from the phone a healthy-but-quiet bot is indistinguishable from a dead
  // one (PC off, process hung). One ping a day means: no heartbeat = it's down.
  if (!dry) {
    setInterval(() => {
      sendAlert(`❤️ Heartbeat — monitor alive · code <code>${fp}</code> · watching ${selectedInstruments(cfg).length} pairs\n<i>If this stops arriving daily, the bot is down — restart it.</i>`);
    }, 24 * 3600 * 1000);

    // WEEKLY PERFORMANCE REPORT — your real numbers, once a week (default Sun
    // 18:00 displayTz). Fires once per 7-day bucket so a restart can't repeat it.
    if (cfg.weeklyReport) {
      const checkReport = () => {
        try {
          const nowS = nowSec();
          const localS = nowS + (cfg.displayTzOffset || 0) * 3600;
          const local = new Date(localS * 1000);
          const bucket = Math.floor(localS / (7 * 86400));
          if (local.getUTCDay() !== (cfg.reportDow ?? 0)) return;
          if (local.getUTCHours() < (cfg.reportHour ?? 18)) return;
          if (state.reports?.lastWeek === bucket) return;
          const tr = loadTrades();
          const recent = tr.closed.filter((t) => (t.closedAt || 0) >= nowS - 7 * 86400).length;
          if (!recent && !tr.open.length) { state.reports = { lastWeek: bucket }; saveRunState(state); return; } // quiet week, no nag
          const txt = reportText(tr, { label: "📅 Weekly", sinceTs: nowS - 7 * 86400, account: loadConfig().account });
          sendAlert(`${txt}\n\n<i>Log trades all week with /trade & /close so this stays true.</i>`);
          state.reports = { lastWeek: bucket }; saveRunState(state);
        } catch (e) { console.log("weekly report error:", e.message); }
      };
      checkReport();
      setInterval(checkReport, 30 * 60 * 1000); // check every 30 min
    }
  }

  const pollMs = Math.max(15, cfg.pollSeconds || 60) * 1000;
  const cycleCap = pollMs * 3;
  let busy = false;
  setInterval(async () => {
    if (busy) { console.log(`[${new Date().toISOString().slice(11, 19)}] previous cycle still running — skipping this tick`); return; }
    busy = true;
    const timeout = setTimeout(() => {
      console.log(`[${new Date().toISOString().slice(11, 19)}] cycle exceeded ${cycleCap / 1000}s — abandoning it, resuming on next tick`);
      busy = false;
    }, cycleCap);
    try { await evaluate(cfg, state, emit, emitFirstSweep, emitStatus, emitMilestone, emitOTE, emitPrice, emitSweep15, emitSweep15Verdict, emitTiming, emitSOLFib); }
    catch (e) { console.log("eval error:", e.message); }
    finally { clearTimeout(timeout); busy = false; saveRunState(state); }
  }, pollMs);

  // Inbound Telegram command poller (/alert PAIR PRICE, /alerts, /cancel). Runs
  // on its own faster tick so commands feel responsive, independent of the heavy
  // evaluate() cycle. Replies go to whoever sent the command.
  if (cfg.commandsEnabled && token) {
    setInterval(() => { pollCommands(token).catch(() => {}); }, 5000);
    registerCommands(token).catch(() => {}); // populate the "/" menu everywhere — best-effort, non-blocking
    console.log("Commands: on (/alert guided · /alert PAIR PRICE · /alerts · /cancel · /help)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
