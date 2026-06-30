// ─────────────────────────────────────────────────────────────────────────
// LIVE 4H SWEEP MONITOR  →  Telegram alerts
//
//   node monitor.mjs            run forever, alert on every new 4H sweep
//   node monitor.mjs --once     evaluate the latest closed candle once, exit
//   node monitor.mjs --setup    test the Telegram bot + print your chat id
//
// No dependencies. Reads config.json (falls back to config.example.json).
// If the Telegram token is missing it runs in DRY mode (console only).
// ─────────────────────────────────────────────────────────────────────────
import { INSTRUMENTS, fmtTime, nextBoundary } from "./deriv.mjs";
import { fetch4H } from "./source.mjs";
import { detectSweep, fmt } from "./detector.mjs";
import { analyzeLTF, ltfLines } from "./ltf.mjs";
import { loadConfig, saveField } from "./config.mjs";

const GRAN = 14400; // 4H in seconds
const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const SETUP = args.includes("--setup");

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
  const tline = `Candle open: ${fmtTime(s.cur.t, cfg.displayTzOffset, cfg.displayTzLabel)}`;
  if (phase === "fizzled") {
    return `<b>${inst.label}</b> — ⚠️ setup FIZZLED\nThe forming double-sweep did not hold at close.\n${tline}`;
  }
  const dirTxt = s.dir === "BULL"
    ? `🟢 BULLISH — swept both sides, clos${phase === "forming" ? "ing" : "ed"} up (low sweep = manipulation)`
    : `🔴 BEARISH — swept both sides, clos${phase === "forming" ? "ing" : "ed"} down (high sweep = manipulation)`;
  const star = s.strength === "STRONG" ? "  ⭐ <b>STRONG</b>" : "";
  const head = phase === "forming"
    ? `<b>${inst.label}</b> — ⏳ FORMING double-sweep${star}\n<i>~${minsLeft} min to close — provisional, can still change. Get to the chart.</i>`
    : `<b>${inst.label}</b> — ✅ CONFIRMED double-sweep${star}`;
  const priceLabel = phase === "forming" ? "Now" : "Close";
  return (
    `${head}\n${dirTxt}\n` +
    `Swept high: <code>${fmt(s.sweptHigh)}</code>   Swept low: <code>${fmt(s.sweptLow)}</code>\n` +
    `${priceLabel}: <code>${fmt(s.cur.close)}</code>   Body: <b>${(s.bodyPct * 100).toFixed(0)}%</b>${s.engulf ? "   engulf" : ""}${s.biggerBody !== undefined ? `   vs prior body: ${s.biggerBody ? "bigger ✓" : "smaller ✗"}` : ""}\n` +
    `${tline}\n→ go check structure to the left.`
  );
}

// ── core evaluation pass ──────────────────────────────────────────────────
async function evaluate(cfg, state, emit) {
  for (const inst of selectedInstruments(cfg)) {
    let candles;
    try { candles = await fetch4H(inst, 6, cfg.bucketOffsetHours); }
    catch (e) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${inst.label}: fetch err ${e.message}`); continue; }

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
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  const token = cfg.telegram?.token && !cfg.telegram.token.startsWith("PASTE") ? cfg.telegram.token : null;
  let chatId = cfg.telegram?.chatId || null;

  // SETUP mode
  if (SETUP) {
    if (!token) return console.log("No token in config.json. Copy config.example.json → config.json and paste your BotFather token first.");
    const me = await tgGetMe(token);
    console.log(`✅ Bot OK: @${me.username}`);
    const id = await tgResolveChatId(token);
    if (id) { saveField("telegram.chatId", id); console.log(`✅ Found your chat id: ${id} (saved to config.json)`); await tgSend(token, id, "✅ Sweep monitor connected. You'll get 4H sweep alerts here."); console.log("✅ Sent you a test message — check Telegram."); }
    else console.log("⚠ Send your bot any message in Telegram first (e.g. 'hi'), then re-run: node monitor.mjs --setup");
    return;
  }

  const dry = !token || !chatId;
  if (token && !chatId) { chatId = await tgResolveChatId(token); if (chatId) saveField("telegram.chatId", chatId); }

  const emit = async (inst, s, phase = "closed", minsLeft = 0) => {
    const tag = phase === "forming" ? "⏳ FORMING" : phase === "fizzled" ? "⚠️ FIZZLED" : "✅ CONFIRMED";
    const when = fmtTime(s.cur.t, cfg.displayTzOffset, cfg.displayTzLabel);
    const line = phase === "fizzled"
      ? `${inst.label}  setup fizzled @ ${when}`
      : `${inst.label}  ${s.dir}  ${s.strength}  swept H ${fmt(s.sweptHigh)}/L ${fmt(s.sweptLow)} body ${(s.bodyPct * 100).toFixed(0)}%${phase === "forming" ? `  (~${minsLeft}m left)` : ""}  @ ${when}`;
    console.log(`🔔 ${tag}  ${line}`);

    // 15m entry plan (former/sweep candle times + SOL) for real setups
    let ltf = null;
    if (cfg.ltfEnabled && phase !== "fizzled" && s.prev && s.cur) {
      try { ltf = ltfLines(await analyzeLTF(inst, s.prev, s.cur, s.dir, { bufferHours: cfg.ltfBufferHours }), cfg); } catch {}
    }
    if (ltf) ltf.forEach((l) => console.log(`     ↳ ${l}`));

    if (!dry) {
      let txt = alertText(inst, s, cfg, phase, minsLeft);
      if (ltf) txt += `\n\n<b>↓ 15m entry plan</b>\n` + ltf.join("\n");
      try { await tgSend(token, chatId, txt); } catch (e) { console.log("  telegram error:", e.message); }
    }
  };

  const nextClose = fmtTime(nextBoundary(cfg.bucketOffsetHours), cfg.displayTzOffset, cfg.displayTzLabel);
  const insts = selectedInstruments(cfg).map((i) => i.label).join(", ");
  const timing = `${cfg.alertLeadMinutes > 0 ? cfg.alertLeadMinutes + "m before close" : "at close"}${cfg.confirmAtClose ? " + confirm at close" : ""}`;
  console.log(`Sweep monitor ${dry ? "(DRY / console only — set up Telegram for phone push)" : "→ Telegram chat " + chatId}`);
  console.log(`Watching: ${insts}`);
  console.log(`Times shown in: ${cfg.displayTzLabel} (UTC${cfg.displayTzOffset >= 0 ? "+" : ""}${cfg.displayTzOffset})   4H align: ${cfg.bucketOffsetHours ? "UTC+" + cfg.bucketOffsetHours + "h grid" : "UTC grid"}`);
  console.log(`Alerts: ${timing}   Level: ${cfg.alertLevel.toUpperCase()}${cfg.minBodyPct ? ` (min body ${(cfg.minBodyPct*100)|0}%)` : ""}   Poll: ${cfg.pollSeconds}s   Next 4H close ~ ${nextClose}\n`);

  const state = { lastSeen: {}, formingSeen: {} };

  if (ONCE) {
    // --once: show the forming candle's current state AND the last closed candle.
    for (const inst of selectedInstruments(cfg)) {
      let candles; try { candles = await fetch4H(inst, 6, cfg.bucketOffsetHours); } catch { continue; }
      const fc = formingCandle(candles);
      if (fc) {
        const mins = Math.round((fc.cur.t + GRAN - nowSec()) / 60);
        const sig = detectSweep(fc.prev, fc.cur);
        console.log(`${inst.label}: FORMING (~${mins}m to close) — ${sig ? `${sig.dir} ${sig.strength} double-sweep so far` : "no sweep yet"}`);
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

  await evaluate(cfg, state, emit); // prime
  if (!dry) { try { await tgSend(token, chatId, `🟢 <b>Sweep monitor live</b>\nWatching: ${insts}\nTimes in ${cfg.displayTzLabel}\nAlerts: ${timing}\nLevel: ${cfg.alertLevel.toUpperCase()}\nNext 4H close ~ ${nextClose}`); } catch {} }

  setInterval(() => evaluate(cfg, state, emit).catch((e) => console.log("eval error:", e.message)),
    Math.max(15, cfg.pollSeconds || 60) * 1000);
}

main().catch((e) => { console.error(e); process.exit(1); });
