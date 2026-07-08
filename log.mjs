// ─────────────────────────────────────────────────────────────────────────
// EVENT LOG — the "research assistant" database
//
// Every notified event (first sweep, forming double-sweep, confirmed, fizzled)
// is appended as one JSON line to events.jsonl, with its full measurements,
// session, and which H4 candle it was. This is what turns the bot from a
// notifier into an observation-collector: after a few months you can load
// events.jsonl and ask which sessions / H4 candles / features actually matter.
//
// JSONL (one JSON object per line) is used instead of CSV because event types
// carry different fields — it stays append-only and trivially parseable later.
// ─────────────────────────────────────────────────────────────────────────
import { appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const LOG = join(dirname(fileURLToPath(import.meta.url)), "events.jsonl");

export function logEvent(row) {
  try { appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n"); }
  catch (e) { /* logging must never crash the monitor */ }
}
