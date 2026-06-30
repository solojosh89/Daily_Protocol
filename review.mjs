// Study recent 4H double-sweeps with their 15m entry (SOL) timing.
//   node review.mjs              → last 5 setups on Gold
//   node review.mjs NAS100 8     → last 8 setups on Nasdaq
//   node review.mjs GBPJPY       → last 5 on GBP/JPY
import { INSTRUMENTS, fmtTime } from "./deriv.mjs";
import { fetch4H } from "./source.mjs";
import { detectSweep, fmt } from "./detector.mjs";
import { analyzeLTF, ltfLines } from "./ltf.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const key = (process.argv[2] || "XAUUSD").toUpperCase();
const n = Number(process.argv[3] || 5);
const inst = INSTRUMENTS.find((i) => i.key === key) || INSTRUMENTS.find((i) => i.key === "XAUUSD");

const run = async () => {
  const candles = await fetch4H(inst, 180, cfg.bucketOffsetHours);
  const setups = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const s = detectSweep(candles[i - 1], candles[i]);
    if (s) setups.push({ s, prev: candles[i - 1], cur: candles[i] });
  }
  const recent = setups.slice(-n);
  console.log(`Last ${recent.length} 4H double-sweeps on ${inst.label} — with 15m entry (SOL) timing. Times in ${cfg.displayTzLabel}.\n`);
  for (const { s, prev, cur } of recent) {
    const arrow = s.dir === "BULL" ? "🟢 BULL" : "🔴 BEAR";
    console.log(`■ ${arrow} ${s.strength}  4H opens ${fmtTime(cur.t, cfg.displayTzOffset, cfg.displayTzLabel)}  body ${(s.bodyPct * 100) | 0}%${s.engulf ? " engulf" : ""}  vs-prev-body ${s.biggerBody ? "bigger✓" : "smaller✗"}  (swept H ${fmt(s.sweptHigh)} / L ${fmt(s.sweptLow)}, close ${fmt(cur.close)})`);
    const a = await analyzeLTF(inst, prev, cur, s.dir, { bufferHours: cfg.ltfBufferHours });
    for (const l of ltfLines(a, cfg)) console.log("     " + l);
    console.log("");
  }
};
run().catch((e) => { console.error(e); process.exit(1); });
