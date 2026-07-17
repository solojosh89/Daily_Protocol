// ─────────────────────────────────────────────────────────────────────────
// ALERT TTL CLEANUP — auto-delete old bot messages so chats stay readable.
//
// Every alert the monitor sends gets its {chat, message_id, ts} appended to
// sent-log.json. A periodic purge deletes messages older than alertTtlDays
// via the Bot API and drops them from the log.
//
// Telegram constraint worth knowing: in GROUPS/CHANNELS where the bot is an
// admin it can delete its old messages at any age; in the PRIVATE chat the
// API refuses deletes past 48h. So private-chat messages are purged at
// min(TTL, 47h) — past that they're permanently undeletable by the bot.
//
// events.jsonl (the research log) is NOT touched — that's the measurement
// database and it's tiny; deleting Telegram messages doesn't delete data.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "sent-log.json");
const PRIVATE_CAP_S = 47 * 3600; // stay under Telegram's 48h private-chat limit

function load() {
  if (!existsSync(FILE)) return [];
  try { return JSON.parse(readFileSync(FILE, "utf8")).rows || []; } catch { return []; }
}
function save(rows) { try { writeFileSync(FILE, JSON.stringify({ rows })); } catch {} }

// Record a sent message for future cleanup. Accepts a single Telegram message
// object or an array (albums). Never throws — cleanup must not break sending.
export function logSent(chatId, msg) {
  if (!msg) return;
  try {
    const rows = load();
    const now = Math.floor(Date.now() / 1000);
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (m && m.message_id) rows.push({ c: String(chatId), m: m.message_id, ts: now });
    }
    save(rows);
  } catch {}
}

// Delete everything past its TTL. Rows are dropped after ONE delete attempt,
// success or not (a failed delete would fail forever — no retry storms).
export async function purgeSent(token, ttlDays) {
  if (!token || !ttlDays || ttlDays <= 0) return;
  const rows = load();
  if (!rows.length) return;
  const now = Math.floor(Date.now() / 1000);
  const ttlS = ttlDays * 86400;
  const keep = [];
  let deleted = 0;
  for (const r of rows) {
    const isPrivate = !String(r.c).startsWith("-");
    const limit = isPrivate ? Math.min(ttlS, PRIVATE_CAP_S) : ttlS;
    if (now - r.ts < limit) { keep.push(r); continue; }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: r.c, message_id: r.m }),
      });
      const j = await res.json();
      if (j.ok) deleted++;
    } catch {}
  }
  save(keep);
  if (deleted) console.log(`🧹 alert cleanup: deleted ${deleted} message${deleted > 1 ? "s" : ""} older than ${ttlDays}d (private capped at 47h)`);
}
