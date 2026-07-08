// Shared config loader. Reads config.json (falls back to config.example.json)
// and fills in defaults so the rest of the code can rely on every field existing.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DIR = dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = join(DIR, "config.json");

export function loadConfig() {
  const path = existsSync(CONFIG_PATH) ? CONFIG_PATH : join(DIR, "config.example.json");
  const c = JSON.parse(readFileSync(path, "utf8"));
  return {
    telegram: { token: "", chatId: "", ...(c.telegram || {}) },
    // Meta WhatsApp Cloud API — official, free. toNumber = YOUR number in
    // international format e.g. "2348012345678" (no +, no leading 0).
    // Note: free-form messages need the 24h window kept open (message the
    // bot's WhatsApp number occasionally) — see README.
    whatsapp: { token: "", phoneNumberId: "", toNumber: "", enabled: true, ...(c.whatsapp || {}) },
    instruments: c.instruments ?? "all",
    alertLevel: c.alertLevel ?? "all",
    minBodyPct: c.minBodyPct ?? 0,
    pollSeconds: c.pollSeconds ?? 60,
    // minutes BEFORE the 4H close to send the provisional "forming" alert (0 = off)
    alertLeadMinutes: c.alertLeadMinutes ?? 15,
    // also send a confirmation (or "fizzled") note once the candle actually closes
    confirmAtClose: c.confirmAtClose ?? true,
    // include the 15m entry plan (former/sweep candle times + SOL) in each alert
    ltfEnabled: c.ltfEnabled ?? true,
    ltfBufferHours: c.ltfBufferHours ?? 1,
    // Stage-2 "first sweep" heads-up mid-candle (manipulation candidate). Noisy by
    // nature — most first sweeps never complete — so suppressed once the candle is
    // past firstSweepMaxElapsedPct, where completion odds crater (see firstsweep.mjs).
    // Default OFF: mid-candle first-sweep heads-up is the chattiest alert and most
    // first sweeps never complete. The A-grade OTE alert replaces it as the signal
    // worth pinging for. Flip to true if you want the raw first-sweep firehose back.
    firstSweepAlert: c.firstSweepAlert ?? false,
    firstSweepMaxElapsedPct: c.firstSweepMaxElapsedPct ?? 50,
    // Phase-3 status update: one factual progress snapshot (time vs price vs remaining)
    // once the candle passes statusUpdatePct elapsed, IF one side is swept but not both.
    // Default OFF for the same noise reason.
    statusUpdateEnabled: c.statusUpdateEnabled ?? false,
    statusUpdatePct: c.statusUpdatePct ?? 50,
    // Progress milestones: after sweep1, alert when B's extreme crosses these %
    // of the way back toward the un-swept side, plus an instant alert at 100%
    // (double-sweep completes mid-candle). Odds shown are MEASURED per threshold
    // (progress-study.mjs, 635 real candles): 50%→36%, 70%→56%, 90%→83%.
    progressAlerts: c.progressAlerts ?? true,
    // Only the near-completion milestone by default (was [50,70,90]) — far fewer pings.
    progressThresholds: c.progressThresholds ?? [90],
    // Candle C execution window: after B confirms bias, the high-attention window
    // to watch M15/H1 for an entry = first N minutes of the next candle. Data-backed
    // (~66% of best entries land here vs ~53% random) — a priority window, not a wall.
    executionWindowMin: c.executionWindowMin ?? 75,
    // Candle B narrative: factual multi-sweep catalogue + chronological replay,
    // appended to the confirmed (Phase 5) alert.
    narrativeEnabled: c.narrativeEnabled ?? true,
    // A-GRADE OTE / structure setup (ote.mjs). The one edge that beat the RNG
    // control in the backtest. Rare by design (~3/week across all pairs) — only
    // STRONG-displacement setups qualify. Fires once per setup, both directions.
    oteAlert: c.oteAlert ?? true,
    oteDispMult: c.oteDispMult ?? 2.5,   // min displacement leg, in median-4H-range units
    oteLookback: c.oteLookback ?? 60,    // 4H candles pulled for structure detection
    // Inbound Telegram commands (/alert PAIR PRICE → 3 pings when hit). getUpdates
    // polling; no webhook. Alerts persist in price-alerts.json.
    commandsEnabled: c.commandsEnabled ?? true,
    // Risk engine: account balance (USD) + % risked per setup. Set via /risk.
    // 0 balance = sizing lines hidden. One stop-out = exactly riskPct of account.
    account: { balance: 0, riskPct: 1, ...(c.account || {}) },
    // Weekly performance report — auto-sent once a week (default Sunday 18:00 in
    // displayTz) with your real win rate + expectancy in R from the trade log.
    weeklyReport: c.weeklyReport ?? true,
    reportDow: c.reportDow ?? 0,     // 0=Sunday … 6=Saturday (display-tz local)
    reportHour: c.reportHour ?? 18,  // hour (display-tz local) to send it
    // Timing clock (measured, sweeptiming-study.mjs): completion-zone reminders.
    // OPEN when the first side is taken in hour 1 (82% of completions start so);
    // CLOSED at 3h15 with no completion (90% of completions would have arrived).
    timingClock: c.timingClock ?? true,
    // 15m SOL check on the FIRST side taken. Default OFF (user: "too much") —
    // one-side takes are 74% continuation noise. The chart album + 15m SOL
    // verdict now ride on the BOTH-SIDES-TAKEN alert instead (the real setup).
    sweep15Alert: c.sweep15Alert ?? false,
    // 4H bucket alignment, in whole hours from UTC, for Deriv-sourced instruments.
    // Confirmed against TradingView/OANDA: their 4H candles open at 01/05/09/13/
    // 17/21 NY, i.e. UTC+1h grid — so 1 is correct here, not 0 (the plain UTC grid
    // is 1h off). TradingView-sourced instruments (dataSrc:"tv") ignore this — their
    // bars are already correctly aligned by definition.
    bucketOffsetHours: c.bucketOffsetHours ?? 1,
    // how alert/scan times are DISPLAYED
    displayTzOffset: c.displayTzOffset ?? 0,
    displayTzLabel: c.displayTzLabel ?? "UTC",
    _exists: existsSync(CONFIG_PATH),
  };
}

// Persist a single field (used to save the resolved Telegram chat id).
export function saveField(key, value) {
  const base = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    : JSON.parse(readFileSync(join(DIR, "config.example.json"), "utf8"));
  // shallow set, supports "telegram.chatId"
  if (key.includes(".")) {
    const [a, b] = key.split(".");
    base[a] = { ...(base[a] || {}), [b]: value };
  } else base[key] = value;
  writeFileSync(CONFIG_PATH, JSON.stringify(base, null, 2));
}
