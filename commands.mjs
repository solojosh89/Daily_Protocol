// ─────────────────────────────────────────────────────────────────────────
// TELEGRAM COMMANDS + USER PRICE ALERTS
//
// Adds an inbound command channel to the (previously send-only) bot via
// getUpdates polling — no webhook, no extra deps.
//
// Two ways to set a price alert:
//   • one-shot:   /alert GOLD 3350
//   • guided 2-step:  /alert   → tap a pair button → reply with the price
// Either way you get pinged 3× when the level is hit.
//   /alerts        list active price alerts
//   /cancel <id>   cancel one   (/cancel alone clears a half-finished /alert)
//   /help          usage
//
// Alerts persist in price-alerts.json (survives restarts). That file is DATA,
// never overwritten by deploy/push-update.ps1 (which copies only *.mjs/*.sh).
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { INSTRUMENTS, idTag, fmtTime, sessionOf } from "./deriv.mjs";
import { fetch15m, fetch4H, fetch1H } from "./source.mjs";
import { logEvent } from "./log.mjs";
import { fmt, dec } from "./detector.mjs";
import { detectOTE } from "./ote.mjs";
import { renderOTEChart, chartCandleCount, tgSendPhoto } from "./chart.mjs";
import { loadConfig, saveField } from "./config.mjs";
import { loadTrades, saveTrades, openTrade, closeTrade, reportText, instName } from "./trades.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const STORE = join(DIR, "price-alerts.json");
const PENDING_TTL = 15 * 60; // a half-finished /alert selection expires after 15 min

// extra spellings → instrument key (shorts/keys already match directly)
const ALIASES = {
  GOLD: "XAUUSD", XAU: "XAUUSD", XAUUSD: "XAUUSD",
  NAS: "NAS100", NASDAQ: "NAS100", US100: "NAS100", USTEC: "NAS100", NDX: "NAS100",
  EUR: "EURUSD", EURUSD: "EURUSD", GBPJPY: "GBPJPY", GJ: "GBPJPY",
};

function loadStore() {
  if (!existsSync(STORE)) return { offset: 0, seq: 1, alerts: [], pending: {} };
  try {
    const s = JSON.parse(readFileSync(STORE, "utf8"));
    return { offset: s.offset || 0, seq: s.seq || 1, alerts: s.alerts || [], pending: s.pending || {} };
  } catch { return { offset: 0, seq: 1, alerts: [], pending: {} }; }
}
function saveStore(s) { writeFileSync(STORE, JSON.stringify(s, null, 2)); }

function resolveInst(tok) {
  if (!tok) return null;
  const norm = tok.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (ALIASES[norm]) tok = ALIASES[norm];
  const t = tok.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return INSTRUMENTS.find((i) =>
    i.key.toUpperCase() === t ||
    (i.short || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === t ||
    (i.label || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === t
  ) || null;
}

const pairMenu = () => INSTRUMENTS.map((i) => `${i.emoji || "▫️"} <code>${i.short}</code>`).join("  ");

// inline keyboard of all pairs, 3 per row → step 1 of the guided flow
function pairKeyboard() {
  const rows = []; let row = [];
  for (const i of INSTRUMENTS) {
    row.push({ text: `${i.emoji || "▫️"} ${i.short}`, callback_data: `pair:${i.key}` });
    if (row.length === 3) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}

async function currentPrice(inst) {
  const c = await fetch15m(inst, 2);
  if (!c || !c.length) throw new Error("no price");
  return c[c.length - 1].close;
}

// ── telegram send helpers (self-contained so monitor stays send-only) ────────
const TG = (t, m) => `https://api.telegram.org/bot${t}/${m}`;
async function tgSend(token, chatId, text, reply_markup) {
  try {
    await fetch(TG(token, "sendMessage"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) }),
    });
  } catch (e) { console.log("  cmd send error:", e.message); }
}
async function tgAnswerCallback(token, id) {
  try { await fetch(TG(token, "answerCallbackQuery"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id }) }); } catch {}
}

// Registers the "/" command menu via the Bot API (setMyCommands) — the
// permanent, code-side fix for "I don't see the full command list when I
// type /". Default scope covers private chats AND groups/supergroups, so one
// call on startup populates the menu everywhere, no BotFather step needed.
// Telegram caches this client-side; a chat may need to be reopened once.
export async function registerCommands(token) {
  const commands = [
    { command: "alert", description: "Set a price alert (guided or /alert PAIR PRICE)" },
    { command: "alerts", description: "List your active price alerts" },
    { command: "cancel", description: "Cancel a price alert by ID" },
    { command: "ote", description: "Active A-grade OTE setups now" },
    { command: "status", description: "Every pair's forming 4H candle at a glance" },
    { command: "history", description: "Recent alerts" },
    { command: "price", description: "Current price for a pair" },
    { command: "note", description: "Journal your read on a pair" },
    { command: "risk", description: "Set account size + risk % for position sizing" },
    { command: "trade", description: "Log a trade" },
    { command: "trades", description: "List open trades" },
    { command: "report", description: "Your win rate and expectancy" },
    { command: "link", description: "Link this group/channel to a filtered alert stream" },
    { command: "unlink", description: "Remove this chat from its linked stream" },
    { command: "help", description: "Show all commands" },
  ];
  // Telegram resolves the menu by SCOPE PRIORITY — a more specific scope always
  // wins over a less specific one, even if the general one is set correctly:
  //   chat-specific  >  all_group_chats  >  default
  // A stale group-only or chat-specific list (e.g. an old manual BotFather
  // /setcommands limited to /alert) silently shadows the default-scope call
  // above in every group, even though private chats show the full list fine.
  // So: overwrite EVERY scope that could realistically be shadowing us —
  // default, all_group_chats, and each linked group's exact chat id.
  const scopes = [
    null, // default — covers private chats + any chat with no more specific override
    { type: "all_group_chats" },
  ];
  try {
    const t = loadConfig().telegram || {};
    for (const cid of new Set([t.realsChannelId, t.derivChannelId, t.oteChannelId, t.alertsChannelId].filter(Boolean))) {
      scopes.push({ type: "chat", chat_id: cid });
    }
  } catch {}
  for (const scope of scopes) {
    try {
      const r = await fetch(TG(token, "setMyCommands"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope ? { commands, scope } : { commands }),
      });
      const j = await r.json();
      if (!j.ok) console.log(`  setMyCommands (${scope ? scope.type : "default"}) failed:`, j.description);
    } catch (e) { console.log(`  setMyCommands (${scope ? scope.type : "default"}) error:`, e.message); }
  }
}

// Create an alert now that we have pair + price. Returns a confirmation string.
async function createAlert(store, inst, price) {
  let now;
  try { now = await currentPrice(inst); } catch { now = price; }
  const dir = price >= now ? "above" : "below";
  const id = store.seq++;
  store.alerts.push({ id, instKey: inst.key, price, dir, remaining: 3, triggered: false, createdAt: Math.floor(Date.now() / 1000) });
  const arrow = dir === "above" ? "rises to ⬆️" : "falls to ⬇️";
  return `✅ Alert <code>#${id}</code> set — I'll ping you <b>3×</b> when ${idTag(inst)} ${arrow} <code>${fmt(price, dec(now))}</code>.\n<i>Now: ${fmt(now, dec(now))}</i>`;
}

// Prompt for step 2 (price), after a pair is chosen. Sets the pending selection.
async function promptForPrice(token, store, chatId, inst) {
  store.pending[chatId] = { instKey: inst.key, at: Math.floor(Date.now() / 1000) };
  let nowLine = "";
  try { const now = await currentPrice(inst); nowLine = `\n<i>Now: ${fmt(now, dec(now))}</i>`; } catch {}
  await tgSend(token, chatId, `${idTag(inst)} selected — now reply with the <b>price</b> (e.g. <code>3350</code>).${nowLine}\n<i>or /cancel to abort</i>`);
}

// ── command routing (text messages beginning with "/") ───────────────────────
// Returns { text?, reply_markup? } to send, or null to ignore. May mutate store.
async function handleCommand(token, text, store, chatId) {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase().replace(/@.*$/, "");

  if (cmd === "/start" || cmd === "/help") {
    return { text:
      `👋 <b>Sweep-monitor commands</b>\n\n` +
      `<b>/alert</b> — guided: pick a pair, then send the price\n` +
      `<b>/alert PAIR PRICE</b> — one-shot, e.g. <code>/alert GOLD 3350</code>\n` +
      `I'll ping you <b>3×</b> when the level is hit.\n` +
      `<b>/alerts</b> — list price alerts · <b>/cancel ID</b> — remove one\n\n` +
      `<b>/ote</b> — active A-grade OTE setups now (with chart)\n` +
      `<b>/status</b> — every pair's forming 4H candle at a glance\n` +
      `<b>/history</b> — recent alerts (<code>/history 20</code>, <code>/history ote</code>, <code>/history notes</code>)\n` +
      `<b>/price PAIR</b> — current price\n` +
      `<b>/note PAIR text</b> — journal your read (took it / skipped &amp; why); measurable later\n` +
      `<b>/risk 500 1</b> — set account + risk %; OTE alerts then show your exact position size\n` +
      `<b>/trade PAIR long ENTRY STOP TARGET</b> — log a trade · <b>/close ID win|loss|PRICE</b>\n` +
      `<b>/trades</b> — open trades · <b>/report</b> — your real win rate &amp; expectancy in R\n\n` +
      `<b>Channels:</b> add this bot as admin to a group/channel, then post one of these there:\n` +
      `<code>/link reals</code> — Gold/Nasdaq/GBPJPY alerts only\n` +
      `<code>/link deriv</code> — Deriv synthetics (SOL-fib) alerts only\n` +
      `<code>/link ote</code> — A-grade OTE setups only\n` +
      `<code>/link alerts</code> — mirror of everything\n` +
      `<code>/unlink</code> — remove this chat from whatever it's linked to\n\n` +
      `Pairs:\n${pairMenu()}` };
  }

  if (cmd === "/trade" || cmd === "/t") {
    // /trade PAIR long|short ENTRY STOP [TARGET]
    if (parts.length < 5) {
      const tr = loadTrades();
      const openList = tr.open.length
        ? `\n\n<b>Open:</b>\n` + tr.open.map((t) => `<code>#${t.id}</code> ${instName(t.instKey)} ${t.dir} @${t.entry} sl ${t.stop}${t.target != null ? ` tp ${t.target}` : ""}`).join("\n")
        : "";
      return { text: `Log a trade: <code>/trade PAIR long|short ENTRY STOP [TARGET]</code>\n  e.g. <code>/trade GOLD long 3312 3299 3341</code>\nClose it with <code>/close ID win|loss|be|PRICE</code>.${openList}` };
    }
    const inst = resolveInst(parts[1]);
    if (!inst) return { text: `Unknown pair "<code>${parts[1]}</code>".\n${pairMenu()}` };
    const dir = parts[2].toLowerCase();
    const nums = parts.slice(3).map((x) => parseFloat(x.replace(/,/g, "")));
    if (nums.slice(0, 2).some((x) => !isFinite(x))) return { text: `Entry and stop must be numbers: <code>/trade GOLD long 3312 3299 3341</code>` };
    const store = loadTrades();
    try {
      const t = openTrade(store, { instKey: inst.key, dir, entry: nums[0], stop: nums[1], target: isFinite(nums[2]) ? nums[2] : null });
      saveTrades(store);
      logEvent({ event: "trade_open", inst: inst.key, tradeId: t.id, dir: t.dir, entry: t.entry, stop: t.stop, target: t.target, plannedRR: t.rr != null ? +t.rr.toFixed(2) : null });
      return { text: `✅ Trade <code>#${t.id}</code> logged — ${idTag(inst)} <b>${t.dir}</b>\nEntry ${t.entry} · stop ${t.stop}${t.target != null ? ` · target ${t.target} (${t.rr.toFixed(1)}R)` : ""}\nClose with <code>/close ${t.id} win|loss|be|PRICE</code>.` };
    } catch (e) { return { text: `⚠️ ${e.message}` }; }
  }

  if (cmd === "/close" || cmd === "/c") {
    if (parts.length < 3) return { text: `Usage: <code>/close ID win|loss|be|PRICE</code> (ID from /trades).` };
    const id = parseInt(parts[1], 10);
    if (!id) return { text: `Need a trade ID: <code>/close 3 win</code> (see /trades).` };
    const store = loadTrades();
    try {
      const t = closeTrade(store, id, parts[2]);
      saveTrades(store);
      logEvent({ event: "trade_close", inst: t.instKey, tradeId: t.id, dir: t.dir, exit: t.exit, R: t.R });
      const emoji = t.R > 0 ? "🟢" : t.R < 0 ? "🔴" : "⚪";
      return { text: `${emoji} Closed <code>#${t.id}</code> ${instName(t.instKey)} at ${t.exit} → <b>${t.R >= 0 ? "+" : ""}${t.R}R</b>.\nSee your numbers with <code>/report</code>.` };
    } catch (e) { return { text: `⚠️ ${e.message}` }; }
  }

  if (cmd === "/trades") {
    const tr = loadTrades();
    if (!tr.open.length) return { text: `No open trades. Log one with <code>/trade GOLD long 3312 3299 3341</code>.` };
    return { text: `<b>Open trades</b>\n` + tr.open.map((t) => `<code>#${t.id}</code> ${instName(t.instKey)} ${t.dir} @${t.entry} · sl ${t.stop}${t.target != null ? ` · tp ${t.target} (${t.rr.toFixed(1)}R)` : ""}`).join("\n") + `\n\nClose with <code>/close ID win|loss|be|PRICE</code>.` };
  }

  if (cmd === "/report") {
    const store = loadTrades();
    const cfg = loadConfig();
    const arg = (parts[1] || "").toLowerCase();
    let sinceTs = 0, label = "All-time";
    if (arg === "week" || arg === "") { sinceTs = Math.floor(Date.now() / 1000) - 7 * 86400; label = "Last 7 days"; }
    else if (arg === "all") { sinceTs = 0; label = "All-time"; }
    else if (/^\d+$/.test(arg)) { sinceTs = Math.floor(Date.now() / 1000) - parseInt(arg, 10) * 86400; label = `Last ${arg} days`; }
    return { text: reportText(store, { label, sinceTs, account: cfg.account }) };
  }

  if (cmd === "/risk" || cmd === "/r") {
    const cfg = loadConfig();
    const cur = cfg.account || { balance: 0, riskPct: 1 };
    if (parts.length < 2) {
      return { text:
        `💰 <b>Risk settings</b>\n` +
        `Account: <code>$${cur.balance}</code> · risk per setup: <code>${cur.riskPct}%</code> ($${(cur.balance * cur.riskPct / 100).toFixed(2)})\n\n` +
        `Set with <code>/risk 500</code> (balance) or <code>/risk 500 1.5</code> (balance + %).\n` +
        `Every OTE alert then shows your exact position size — one stop-out = exactly ${cur.riskPct}% of account.` };
    }
    const balance = parseFloat(parts[1].replace(/[$,]/g, ""));
    if (!isFinite(balance) || balance < 0) return { text: `"<code>${parts[1]}</code>" isn't a valid balance. e.g. <code>/risk 500</code>` };
    let riskPct = cur.riskPct || 1;
    if (parts[2] != null) {
      riskPct = parseFloat(parts[2].replace(/%/g, ""));
      if (!isFinite(riskPct) || riskPct <= 0) return { text: `"<code>${parts[2]}</code>" isn't a valid risk %. e.g. <code>/risk 500 1</code>` };
      if (riskPct > 3) return { text: `⚠️ ${riskPct}% per trade is how accounts die: at the validated 55% win rate a 5-loss streak is NORMAL (~every 40 trades) — that would be −${(riskPct * 5).toFixed(0)}%. I won't set above 3%. Use <code>/risk ${balance} 3</code> at most (1–2% recommended).` };
    }
    saveField("account", { balance, riskPct });
    const r$ = (balance * riskPct / 100).toFixed(2);
    return { text:
      `✅ Account <code>$${balance}</code> · risk <code>${riskPct}%</code> = <b>$${r$} per setup</b>.\n` +
      `A 5-loss streak (normal at 55%) costs −${(riskPct * 5).toFixed(1)}% — survivable by design.\n` +
      `OTE alerts now include your exact size.` };
  }

  if (cmd === "/note" || cmd === "/n") {
    // /note GOLD took it, structure clean   → journaled next to the setups in
    // events.jsonl so the user's discretionary read becomes measurable later.
    if (parts.length < 2) {
      return { text: `Usage: <code>/note PAIR your read...</code>\n  e.g. <code>/note GOLD took it, clean structure left</code>\n  or <code>/note GOLD skipped, no HTF level</code>\nYour note is journaled next to the alerts — months from now we can measure whether your filter beats the raw setups.` };
    }
    const inst = resolveInst(parts[1]);
    const noteText = parts.slice(inst ? 2 : 1).join(" ").trim();
    if (!noteText) return { text: `Add the note text: <code>/note ${inst ? inst.short : "GOLD"} took it, clean SOL + HTF level</code>` };
    const now = Math.floor(Date.now() / 1000);
    // attach the current 4H candle so the note lines up with that candle's alerts
    let h4Open = null;
    try {
      const cfg = loadConfig();
      if (inst) {
        const c = await fetch4H(inst, 2, cfg.bucketOffsetHours);
        const cur = c[c.length - 1];
        if (cur && cur.t + 14400 > now) h4Open = fmtTime(cur.t, cfg.displayTzOffset, cfg.displayTzLabel);
      }
    } catch {}
    logEvent({ event: "user_note", inst: inst ? inst.key : null, session: sessionOf(now), h4Open, note: noteText });
    return { text: `📝 Noted${inst ? ` for ${idTag(inst)}` : ""}${h4Open ? ` (H4 ${h4Open})` : ""}:\n<i>${noteText}</i>\nJournaled — <code>/history notes</code> to review.` };
  }

  if (cmd === "/price" || cmd === "/p") {
    const inst = resolveInst(parts[1]);
    if (!inst) return { text: parts[1] ? `Unknown pair "<code>${parts[1]}</code>".\n${pairMenu()}` : `Usage: <code>/price GOLD</code>\n${pairMenu()}` };
    try {
      const now = await currentPrice(inst);
      return { text: `${idTag(inst)} — <code>${fmt(now, dec(now))}</code>` };
    } catch { return { text: `Couldn't fetch ${inst.short} right now — try again in a moment.` }; }
  }

  if (cmd === "/status" || cmd === "/s") {
    const cfg = loadConfig();
    const G4 = 14400, now = Math.floor(Date.now() / 1000);
    const sel = cfg.instruments === "all" ? INSTRUMENTS : INSTRUMENTS.filter((i) => cfg.instruments.includes(i.key));
    const lines = [];
    for (const inst of sel) {
      try {
        const c = await fetch4H(inst, 3, cfg.bucketOffsetHours);
        const cur = c[c.length - 1], prev = c[c.length - 2];
        if (!cur || !prev || cur.t + G4 <= now) { lines.push(`${inst.emoji || "▫️"} <b>${inst.short}</b> · no forming candle (closed/weekend)`); continue; }
        const sH = cur.high > prev.high, sL = cur.low < prev.low;
        const swept = sH && sL ? "⬆️H+⬇️L BOTH swept" : sH ? "⬆️ HIGH swept" : sL ? "⬇️ LOW swept" : "— none swept";
        const el = Math.round(100 * (now - cur.t) / G4);
        const col = cur.close >= cur.open ? "🟢" : "🔴";
        lines.push(`${inst.emoji || "▫️"} <b>${inst.short}</b> · ${swept} · ${el}% · ${col} <code>${fmt(cur.close)}</code>`);
      } catch { lines.push(`${inst.emoji || "▫️"} <b>${inst.short}</b> · fetch failed`); }
    }
    return { text: `📊 <b>Forming 4H candle — all pairs</b>\n<i>swept sides vs prior candle · % elapsed · current</i>\n\n${lines.join("\n")}` };
  }

  if (cmd === "/history" || cmd === "/h") {
    const evPath = join(DIR, "events.jsonl");
    if (!existsSync(evPath)) return { text: "No history yet on this server — events accumulate from deployment onward." };
    const arg = (parts[1] || "").toLowerCase();
    const onlyOte = arg === "ote";
    const onlyNotes = arg === "notes" || arg === "note";
    let n = onlyOte || onlyNotes ? 10 : parseInt(arg, 10) || 10;
    n = Math.min(Math.max(n, 1), 20);
    const rows = readFileSync(evPath, "utf8").trim().split("\n").slice(-400)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.event && e.event !== "candleB_narrative")
      .filter((e) => (onlyOte ? e.event === "ote_setup" : onlyNotes ? e.event === "user_note" : true))
      .slice(-n).reverse();
    if (!rows.length) return { text: onlyOte ? "No OTE setups recorded yet — they're rare by design." : onlyNotes ? "No notes yet. Journal one with <code>/note GOLD your read...</code>" : "No events recorded yet." };
    const describe = (e) => {
      const inst = INSTRUMENTS.find((i) => i.key === e.inst);
      const tag = inst ? idTag(inst) : (e.inst || "📒");
      const when = e.h4Open || e.sweepT || "";
      switch (e.event) {
        case "ote_setup": return `${tag} 🎯 <b>OTE ${e.dir}</b>${e.deep != null ? ` <b>${e.deep ? "A+" : "A"}</b>` : ""} stop <code>${fmt(e.stop)}</code> tgt <code>${fmt(e.target)}</code> · ${when}`;
        case "user_note": return `${tag} 📝 <i>${e.note}</i> · ${when}`;
        case "sweep15_check": return `${tag} ${e.side === "high" ? "⬆️" : "⬇️"} 15m check: ${e.cleanSOL === true ? "✅ clean SOL" : e.cleanSOL === false ? "❌ no SOL" : "⏳ forming"} · ${when}`;
        case "confirmed": return `${tag} ✅ ${e.bias || ""} ${e.strength || ""} double-sweep · ${when}`;
        case "second_sweep": return `${tag} ⏳ ${e.bias || ""} forming double-sweep · ${when}`;
        case "fizzled": return `${tag} ⚠️ fizzled · ${when}`;
        case "first_sweep": return `${tag} ${e.side === "high" ? "⬆️" : "⬇️"} first ${e.side} sweep · ${when}`;
        case "progress": return `${tag} 🎯 ${e.milestone}% progress · ${when}`;
        case "status": return `${tag} 🔵 status snapshot · ${when}`;
        default: return `${tag} ${e.event} · ${when}`;
      }
    };
    return { text: `🗂 <b>Last ${rows.length}${onlyOte ? " OTE" : ""} events</b> (newest first)\n\n${rows.map(describe).join("\n")}` };
  }

  if (cmd === "/ote" || cmd === "/o") {
    const cfg = loadConfig();
    const reals = INSTRUMENTS.filter((i) => !i.key.startsWith("V") &&
      (cfg.instruments === "all" || cfg.instruments.includes(i.key)));
    const actives = [];
    for (const inst of reals) {
      try {
        const c4 = await fetch4H(inst, cfg.oteLookback, cfg.bucketOffsetHours);
        const o = detectOTE(c4, { dispMult: cfg.oteDispMult });
        if (o) actives.push({ inst, o });
      } catch {}
    }
    if (!actives.length) return { text: "No active OTE setups right now (real pairs, strong displacement only). They're rare by design — ~3/week across all pairs." };
    // text summary first, then a chart per setup
    const lines = actives.map(({ inst, o }) => {
      const d = Math.max(dec(o.stop), dec(o.target));
      const zLo = fmt(Math.min(o.entryNear, o.entryFar), d), zHi = fmt(Math.max(o.entryNear, o.entryFar), d);
      return `${idTag(inst)} 🎯 <b>${o.dir}</b> <b>${o.deep ? "A+" : "A"}</b> · zone <code>${zLo}–${zHi}</code>${o.fvg ? " · FVG✓" : ""} · stop <code>${fmt(o.stop, d)}</code> · tgt <code>${fmt(o.target, d)}</code> · disp ${o.dispX.toFixed(1)}×`;
    });
    await tgSend(token, chatId, `🎯 <b>Active OTE setups</b> — ${actives.length}\n\n${lines.join("\n")}\n\n<i>charts following…</i>`);
    for (const { inst, o } of actives) {
      try {
        const c1 = await fetch1H(inst, chartCandleCount(o));
        const url = await renderOTEChart(inst, o, c1);
        if (url) await tgSendPhoto(token, chatId, url, `${idTag(inst)} — OTE ${o.dir} · 1H view`);
      } catch {}
    }
    return null; // replies already sent
  }

  if (cmd === "/alerts" || cmd === "/list") {
    if (!store.alerts.length) return { text: "No active price alerts. Set one with <code>/alert</code>." };
    return { text: `<b>Active price alerts</b>\n` + store.alerts.map((a) => {
      const inst = INSTRUMENTS.find((i) => i.key === a.instKey);
      const arrow = a.dir === "above" ? "⬆️ ≥" : "⬇️ ≤";
      return `<code>#${a.id}</code> ${inst ? idTag(inst) : a.instKey} ${arrow} <code>${fmt(a.price)}</code>${a.triggered ? " (firing…)" : ""}`;
    }).join("\n") + `\n\nCancel with <code>/cancel ID</code>.` };
  }

  if (cmd === "/cancel" || cmd === "/delete") {
    // /cancel with no id → abort a half-finished /alert selection
    if (parts.length < 2) {
      if (store.pending[chatId]) { delete store.pending[chatId]; return { text: "Cancelled — no alert set." }; }
      return { text: "Usage: <code>/cancel ID</code> (get the ID from /alerts)." };
    }
    const id = parseInt(parts[1], 10);
    if (!id) return { text: "Usage: <code>/cancel ID</code> (get the ID from /alerts)." };
    const before = store.alerts.length;
    store.alerts = store.alerts.filter((a) => a.id !== id);
    return { text: store.alerts.length < before ? `✅ Cancelled alert #${id}.` : `No alert #${id} found.` };
  }

  if (cmd === "/alert") {
    // /alert            → step 1: show the pair keyboard
    if (parts.length < 2) return { text: "Pick a pair:", reply_markup: pairKeyboard() };
    const inst = resolveInst(parts[1]);
    if (!inst) return { text: `Unknown pair "<code>${parts[1]}</code>". Pick one:`, reply_markup: pairKeyboard() };
    // /alert PAIR       → jump to step 2: ask for the price
    if (parts.length < 3) { await promptForPrice(token, store, chatId, inst); return null; }
    // /alert PAIR PRICE → one-shot create
    const price = parseFloat(parts[2].replace(/,/g, ""));
    if (!isFinite(price) || price <= 0) return { text: `"<code>${parts[2]}</code>" isn't a valid price.` };
    delete store.pending[chatId];
    return { text: await createAlert(store, inst, price) };
  }

  return null;
}

// Poll Telegram for new commands / button taps / pending-price replies and act.
// Busy-guarded: slow commands (/ote, /status fetch many pairs) must not overlap
// with the next 5s tick, or the same message would be handled twice (the update
// offset is only saved at the end of a pass).
let polling = false;
export async function pollCommands(token) {
  if (polling) return;
  polling = true;
  try { await pollCommandsInner(token); } finally { polling = false; }
}

// Shared "/link <kind>" handler for both Channels (channel_post) and Groups
// (message). Groups may deliver the command as "/link@botname reals" when
// multiple bots share the group — strip the @mention before matching.
// Returns true if the text was a /link command (handled, whether or not it
// matched a known kind), false otherwise — callers use this to decide
// whether to fall through to normal command handling.
async function tryLink(token, rawText, cid) {
  const t = (rawText || "").trim().toLowerCase().replace(/^\/(link|unlink)@\S+/, "/$1");
  if (!cid) return false;
  if (t.startsWith("/unlink")) {
    const fields = ["oteChannelId", "realsChannelId", "derivChannelId", "alertsChannelId"];
    const cfg = loadConfig().telegram || {};
    const removed = fields.filter((f) => cfg[f] === cid);
    for (const f of removed) saveField(`telegram.${f}`, "");
    await tgSend(token, cid, removed.length
      ? `🔓 <b>Unlinked.</b> This chat no longer receives: ${removed.map((f) => f.replace("ChannelId", "")).join(", ")}.`
      : `This chat wasn't linked to any stream.`);
    return true;
  }
  if (!t.startsWith("/link")) return false;
  // Require an EXPLICIT keyword — a bare "/link" or a typo used to silently
  // default to "alerts" (mirror everything), which is almost never what was
  // meant and is easy to trigger by accident. Now it just explains the options.
  const kind = t.includes("ote") ? "ote" : t.includes("reals") ? "reals" : t.includes("deriv") ? "deriv" : t.includes("alerts") ? "alerts" : null;
  if (!kind) {
    await tgSend(token, cid,
      `Link this chat to a stream — pick one:\n` +
      `<code>/link reals</code> — Gold/Nasdaq/GBPJPY only\n` +
      `<code>/link deriv</code> — Deriv synthetics only\n` +
      `<code>/link ote</code> — A-grade OTE setups only\n` +
      `<code>/link alerts</code> — mirror of EVERYTHING (rarely what you want if you also linked reals/deriv elsewhere)`);
    return true;
  }
  const field = { ote: "oteChannelId", reals: "realsChannelId", deriv: "derivChannelId", alerts: "alertsChannelId" }[kind];
  saveField(`telegram.${field}`, cid);
  const msg = {
    ote: `🎯 <b>Linked.</b> This chat now receives <b>A-grade OTE setups only</b> (chart + levels). Nothing else will ever post here.`,
    reals: `🥇 <b>Linked.</b> This chat now receives every <b>Gold / Nasdaq / GBPJPY</b> alert (4H sweeps, OTE setups, first-sweep &amp; status digests).`,
    deriv: `🧲 <b>Linked.</b> This chat now receives every <b>Deriv synthetics</b> alert (the SOL-fib engine: armed / 0.618 / 0.886 taps).`,
    alerts: `🔗 <b>Linked.</b> This chat now mirrors <b>every alert</b> the bot sends — a clean archive, no command chatter.`,
  }[kind];
  await tgSend(token, cid, msg);
  return true;
}

async function pollCommandsInner(token) {
  const store = loadStore();
  let updates;
  try {
    const r = await fetch(`${TG(token, "getUpdates")}?timeout=0&offset=${store.offset + 1}&allowed_updates=%5B%22message%22%2C%22callback_query%22%2C%22channel_post%22%5D`);
    const j = await r.json();
    if (!j.ok) return;
    updates = j.result;
  } catch { return; }
  if (!updates || !updates.length) return;

  let changed = false;
  for (const u of updates) {
    if (u.update_id > store.offset) { store.offset = u.update_id; changed = true; }

    // (0) channel post → only /link is honored here. Posting "/link ote" in a
    // channel (bot must be admin) makes it the dedicated OTE channel; "/link
    // alerts" the mirror-of-everything channel; "/link reals" every Gold/
    // Nasdaq/GBPJPY alert; "/link deriv" every synthetics (SOL-fib) alert.
    // Self-serve wiring — no config editing needed.
    if (u.channel_post) {
      const cp = u.channel_post;
      const cid = cp.chat?.id ? String(cp.chat.id) : null;
      if (cid && await tryLink(token, cp.text, cid)) changed = true;
      continue;
    }

    // (0b) GROUP message → same /link handling as channels. Telegram delivers
    // group text as `message`, not `channel_post` — without this, "/link reals"
    // posted in a Group (as opposed to a Channel) silently falls through to the
    // unknown-command handler below and gets no reply at all.
    if (u.message && (u.message.chat?.type === "group" || u.message.chat?.type === "supergroup")) {
      const cid = String(u.message.chat.id);
      if (await tryLink(token, u.message.text, cid)) { changed = true; continue; }
    }

    // (1) button tap on the pair keyboard → step 1 complete, prompt for price
    if (u.callback_query) {
      const cq = u.callback_query;
      const chatId = cq.message?.chat?.id;
      const data = cq.data || "";
      await tgAnswerCallback(token, cq.id);
      if (chatId && data.startsWith("pair:")) {
        const inst = INSTRUMENTS.find((i) => i.key === data.slice(5));
        if (inst) { await promptForPrice(token, store, String(chatId), inst); changed = true; }
      }
      continue;
    }

    // (2) text message
    const msg = u.message;
    const text = msg?.text;
    const chatId = msg?.chat?.id;
    if (!text || !chatId) continue;
    const cid = String(chatId);

    if (text[0] === "/") {
      try {
        const out = await handleCommand(token, text, store, cid);
        if (out) await tgSend(token, cid, out.text, out.reply_markup);
        changed = true;
      } catch (e) { await tgSend(token, cid, `⚠️ ${e.message}`); }
      continue;
    }

    // (3) plain message while a pair is pending → treat it as the price (step 2)
    const pend = store.pending[cid];
    if (pend) {
      if (Math.floor(Date.now() / 1000) - (pend.at || 0) > PENDING_TTL) { delete store.pending[cid]; changed = true; continue; }
      const price = parseFloat(text.replace(/,/g, ""));
      const inst = INSTRUMENTS.find((i) => i.key === pend.instKey);
      if (!inst) { delete store.pending[cid]; changed = true; continue; }
      if (!isFinite(price) || price <= 0) { await tgSend(token, cid, `"<code>${text}</code>" isn't a valid price. Send a number like <code>3350</code>, or /cancel.`); continue; }
      delete store.pending[cid];
      try { await tgSend(token, cid, await createAlert(store, inst, price)); } catch (e) { await tgSend(token, cid, `⚠️ ${e.message}`); }
      changed = true;
    }
  }
  if (changed) saveStore(store);
}

// Check one instrument's latest candle against active price alerts. Fires the
// first ping the instant the level is touched, then repeats on subsequent calls
// until 3 pings are sent (so a fast wick can't be missed), then removes it.
// Returns an array of message strings to broadcast now.
export function checkPriceAlerts(inst, candle) {
  const store = loadStore();
  const mine = store.alerts.filter((a) => a.instKey === inst.key);
  if (!mine.length) return [];
  const out = [];
  let changed = false;
  for (const a of mine) {
    if (!a.triggered) {
      const hit = a.dir === "above" ? candle.high >= a.price : candle.low <= a.price;
      if (!hit) continue;
      a.triggered = true; a.triggeredAt = Math.floor(Date.now() / 1000);
      changed = true;
    }
    if (a.triggered && a.remaining > 0) {
      const n = 4 - a.remaining; // 1st, 2nd, 3rd
      const arrow = a.dir === "above" ? "⬆️" : "⬇️";
      out.push(
        `🔔 <b>PRICE ALERT ${n}/3</b> — ${idTag(inst)} ${arrow} <b>${fmt(a.price)}</b>\n` +
        `Now: <code>${fmt(candle.close)}</code> · target ${a.dir} <code>${fmt(a.price)}</code>\n` +
        `<i>alert #${a.id}${n === 3 ? " · done, removing" : ""}</i>`
      );
      a.remaining--; changed = true;
    }
  }
  store.alerts = store.alerts.filter((a) => !(a.triggered && a.remaining <= 0));
  if (changed) saveStore(store);
  return out;
}
