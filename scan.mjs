// Proof / validation: scan recent real 4H history and list every sweep the
// detector finds, so you can eyeball them on your chart before trusting alerts.
//   node scan.mjs            → last ~30 days, all instruments
//   node scan.mjs 90         → last ~90 days
import { INSTRUMENTS, fmtTime } from "./deriv.mjs";
import { fetch4H } from "./source.mjs";
import { detectSweep, fmt } from "./detector.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const days = Number(process.argv[2] || 30);
const count = Math.min(Math.ceil((days * 24) / 4) + 5, 1000); // 6 candles/day

const arrow = (s) => (s.dir === "BULL" ? "🟢 BULL" : "🔴 BEAR");
const T = (epoch) => fmtTime(epoch, cfg.displayTzOffset, cfg.displayTzLabel);

const run = async () => {
  console.log(`Scanning last ~${days} days of 4H candles for DOUBLE-SIDED sweeps (swept prior high AND low).`);
  console.log(`Times in ${cfg.displayTzLabel} (UTC${cfg.displayTzOffset >= 0 ? "+" : ""}${cfg.displayTzOffset}), 4H align: ${cfg.bucketOffsetHours ? "UTC+" + cfg.bucketOffsetHours + "h" : "UTC grid"}.\n`);
  let total = 0, strong = 0;
  for (const inst of INSTRUMENTS) {
    let candles;
    try { candles = await fetch4H(inst, count, cfg.bucketOffsetHours); }
    catch (e) { console.log(`  ${inst.label}: fetch failed (${e.message})`); continue; }

    const hits = [];
    for (let i = 1; i < candles.length - 1; i++) {       // exclude the still-forming last candle
      const s = detectSweep(candles[i - 1], candles[i]);
      if (s) hits.push({ ...s, at: candles[i].t });
    }
    total += hits.length;
    strong += hits.filter((h) => h.strength === "STRONG").length;

    const srcTag = inst.dataSrc === "tv" ? inst.tvSym : inst.sym;
    console.log(`━━ ${inst.label} (${srcTag}) — ${hits.length} double-sweeps ${hits.length ? "" : "(none)"}`);
    for (const h of hits.slice(-6)) {                     // show the most recent few
      console.log(
        `   ${T(h.at)}  ${arrow(h)} ${h.strength === "STRONG" ? "⭐STRONG" : "normal "}` +
        `  swept H ${fmt(h.sweptHigh)} / L ${fmt(h.sweptLow)}  manip:${h.manipSide}` +
        `  close ${fmt(h.cur.close)}  body ${(h.bodyPct * 100).toFixed(0)}%${h.engulf ? " engulf" : ""}` +
        `  vs-prev-body ${h.biggerBody ? "bigger✓" : "smaller✗"} (${fmt(h.body)} vs ${fmt(h.prevBody)})`
      );
    }
    console.log("");
  }
  console.log(`Done. ${total} sweeps total, ${strong} STRONG (engulfing + big body).`);
};
run().catch((e) => { console.error(e); process.exit(1); });
