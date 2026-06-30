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
