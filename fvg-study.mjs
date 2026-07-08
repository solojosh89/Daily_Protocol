// ─────────────────────────────────────────────────────────────────────────
// FVG / DISPLACEMENT-CONTINUATION STUDY — the user's V100s observation:
// "B almost took A's low, then closed with a HUGE body up, leaving a 4H gap
//  (FVG). That body is too huge to neglect — can we trade CONTINUATION?"
//
// Two testable claims:
//  TEST 1 (the framework): 3-candle FVG after a huge-body impulse.
//     A = candle before impulse, B = impulse (body ≥ dispMult× median range),
//     C = candle after. Bullish FVG exists if low(C) > high(A).
//     Entry  = first later touch of the zone top (low of C)
//     Stop   = zone bottom (high of A)
//     Target = impulse extreme H = max(high B, high C)
//     → does price fill the gap and CONTINUE? win rate + expectancy in R.
//  TEST 2 (the chase): buy the CLOSE of the huge-body candle immediately.
//     MFE vs MAE over the next 3 candles — does chasing displacement pay,
//     or is the retrace-entry the whole trade?
//  Both directions, pooled. REAL vs RNG control as always.
// ─────────────────────────────────────────────────────────────────────────
import { fetch4H } from "./source.mjs";
import { loadConfig } from "./config.mjs";

const cfg = loadConfig();
const REALI = [
  { key: "Gold", sym: "frxXAUUSD", dataSrc: "deriv", offset: 1 },
  { key: "Silver", sym: "frxXAGUSD", dataSrc: "deriv", offset: 1 },
  { key: "EURUSD", sym: "frxEURUSD", dataSrc: "deriv", offset: 1 },
  { key: "GBPUSD", sym: "frxGBPUSD", dataSrc: "deriv", offset: 1 },
  { key: "USDJPY", sym: "frxUSDJPY", dataSrc: "deriv", offset: 1 },
  { key: "GBPJPY", sym: "frxGBPJPY", dataSrc: "deriv", offset: 1 },
  { key: "EURJPY", sym: "frxEURJPY", dataSrc: "deriv", offset: 1 },
  { key: "AUDUSD", sym: "frxAUDUSD", dataSrc: "deriv", offset: 1 },
  { key: "USDCAD", sym: "frxUSDCAD", dataSrc: "deriv", offset: 1 },
  { key: "EURGBP", sym: "frxEURGBP", dataSrc: "deriv", offset: 1 },
  { key: "Nasdaq", sym: "OTC_NDX", tvSym: "IG:NASDAQ", dataSrc: "tv", offset: 0 },
];
const SYNTHI = [
  { key: "V25", sym: "R_25", dataSrc: "deriv", offset: 0 },
  { key: "V25S", sym: "1HZ25V", dataSrc: "deriv", offset: 0 },
  { key: "V50", sym: "R_50", dataSrc: "deriv", offset: 0 },
  { key: "V75", sym: "R_75", dataSrc: "deriv", offset: 0 },
  { key: "V100", sym: "R_100", dataSrc: "deriv", offset: 0 },
  { key: "V100S", sym: "1HZ100V", dataSrc: "deriv", offset: 0 },
];
const DISP = 2.0;        // impulse: body ≥ 2× median 4H range ("huge body")
const ENTRY_WIN = 12;    // candles after C to wait for the gap tap
const OUT_WIN = 24;      // candles to resolve the trade
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 1; };
const pct = (n, d) => (d ? Math.round(100 * n / d) : 0);

function study(c) {
  const scale = median(c.map((x) => x.high - x.low)) || 1;
  const minBody = DISP * scale;
  const r = { setups: 0, filled: 0, wins: 0, losses: 0, rrSum: 0, chaseMFE: [], chaseMAE: [] };

  for (let i = 1; i < c.length - 2; i++) {
    const A = c[i - 1], B = c[i], C = c[i + 1];
    const body = Math.abs(B.close - B.open);
    if (body < minBody) continue;
    const bull = B.close > B.open;

    // TEST 2 — chase the close of B: MFE/MAE next 3 candles, in R of B's body
    {
      const nxt = c.slice(i + 1, i + 4);
      if (nxt.length === 3) {
        const mfe = bull ? Math.max(...nxt.map((x) => x.high)) - B.close : B.close - Math.min(...nxt.map((x) => x.low));
        const mae = bull ? B.close - Math.min(...nxt.map((x) => x.low)) : Math.max(...nxt.map((x) => x.high)) - B.close;
        r.chaseMFE.push(mfe / body); r.chaseMAE.push(mae / body);
      }
    }

    // TEST 1 — FVG continuation
    let zoneTop, zoneBot, target;
    if (bull && C.low > A.high) { zoneTop = C.low; zoneBot = A.high; target = Math.max(B.high, C.high); }
    else if (!bull && C.high < A.low) { zoneTop = C.high; zoneBot = A.low; target = Math.min(B.low, C.low); } // mirrored: "top" = entry edge
    else continue;
    r.setups++;

    // wait for the tap (entry at the zone's entry edge), then resolve
    let entered = -1;
    for (let m = i + 2; m <= Math.min(i + 1 + ENTRY_WIN, c.length - 1); m++) {
      const tapped = bull ? c[m].low <= zoneTop : c[m].high >= zoneTop;
      if (!tapped) continue;
      // swept straight through the whole zone on the same candle = instant loss risk;
      // conservative: if the same candle also broke the zone bottom, count loss.
      const broke = bull ? c[m].low < zoneBot : c[m].high > zoneBot;
      entered = m; r.filled++;
      const entry = zoneTop, stop = zoneBot;
      const rr = Math.abs(target - entry) / Math.abs(entry - stop);
      if (broke) { r.losses++; r.rrSum += -1; break; }
      let done = false;
      for (let k = m + 1; k <= Math.min(m + OUT_WIN, c.length - 1); k++) {
        const hitStop = bull ? c[k].low <= stop : c[k].high >= stop;
        const hitTgt = bull ? c[k].high >= target : c[k].low <= target;
        if (hitStop && hitTgt) { r.losses++; r.rrSum += -1; done = true; break; } // ambiguous → count loss (honest)
        if (hitStop) { r.losses++; r.rrSum += -1; done = true; break; }
        if (hitTgt) { r.wins++; r.rrSum += rr; done = true; break; }
      }
      break; // one entry per FVG
    }
  }
  return r;
}

const run = async () => {
  const pool = async (insts) => {
    const agg = { setups: 0, filled: 0, wins: 0, losses: 0, rrSum: 0, chaseMFE: [], chaseMAE: [] };
    for (const inst of insts) {
      try {
        const c = await fetch4H(inst, 600, inst.offset ?? cfg.bucketOffsetHours);
        const r = study(c);
        for (const k of ["setups", "filled", "wins", "losses", "rrSum"]) agg[k] += r[k];
        agg.chaseMFE = agg.chaseMFE.concat(r.chaseMFE); agg.chaseMAE = agg.chaseMAE.concat(r.chaseMAE);
      } catch (e) { console.log(`${inst.key}: ${e.message}`); }
    }
    return agg;
  };
  console.log(`Impulse = 4H body ≥ ${DISP}× median range ("huge body close"). Both directions pooled.\n`);
  for (const [label, insts] of [["REAL", REALI], ["SYNTH (RNG)", SYNTHI]]) {
    const p = await pool(insts);
    const n = p.wins + p.losses;
    const exp = n ? p.rrSum / n : 0;
    console.log(`${label}:`);
    console.log(`  TEST 1 — FVG continuation: ${p.setups} FVGs · tapped within ${ENTRY_WIN} candles: ${pct(p.filled, p.setups)}%`);
    console.log(`           resolved trades ${n} · win ${pct(p.wins, n)}% · expectancy ${(exp >= 0 ? "+" : "")}${exp.toFixed(2)}R per trade`);
    console.log(`  TEST 2 — chase the close: median MFE ${median(p.chaseMFE).toFixed(2)}x body vs median MAE ${median(p.chaseMAE).toFixed(2)}x body (n=${p.chaseMFE.length})`);
    console.log("");
  }
  console.log("Read: TEST 1 positive expectancy on REAL but ≈0 on RNG = real continuation edge.");
  console.log("TEST 2 MFE≈MAE = chasing is a coin flip → the retrace entry IS the trade.");
};
run().catch((e) => { console.error(e); process.exit(1); });
