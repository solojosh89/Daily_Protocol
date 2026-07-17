// ─────────────────────────────────────────────────────────────────────────
// SOL → FIB RETRACEMENT ENGINE  (synthetics, 15m/30m/1H)
//
// Encodes the user's own charted playbook (Downloads/example, 2026-07-10):
//   • A SOL (sweep of liquidity): a prior swing high/low gets wicked through
//     and price closes back — that spike may span several candles; fib 1.0
//     anchors at the CLUSTER extreme (V25 June-12: the 2861 wick).
//   • The impulse leg that follows runs to the opposite extreme — fib 0.0.
//   • WHICH retrace level reacts is age-adaptive (calendar time, the user's
//     "long days" rule): fresh SOLs hold 0.618; aged SOLs (≥ longAgeHours
//     since the SOL — the V25 June case ran ~a month) go deep to 0.886.
//   • FVGs inside the 0.5–0.886 band mark the fine-tuned entry (IFVG idea).
//   • Invalidation is beyond the SOL extreme (1.0) — NOT a tight 0.786 stop.
//   • Old and new setups COEXIST (the June 0.886 reversed the July retrace),
//     so ALL dominant setups are tracked, not just the latest.
//
// Three alerts max per setup lifetime:
//   ARMED   — retrace has reached 0.5: fib map + expected level + FVGs.
//   TAP618  — first touch of 0.618 with price rejecting back.
//   TAP886  — first touch of 0.886 with rejection (the deep entry).
// Invalidation (wick beyond the SOL extreme) kills it silently.
//
// UNVALIDATED: the user's read, encoded honestly — geometry on RNG walks,
// no backtested edge claimed. The alert says so.
// ─────────────────────────────────────────────────────────────────────────

const K = 3;         // fractal half-width
const EXT = 30;      // depth: the top must be the extreme of the prior 30
const LOOKBACK = 60; // how far back the swept swing (S) may sit
const CONFIRM = 6;   // bars after the top for the close-back-through (the V25
                     // June-12 grind closed back below the swept level 2 bars
                     // after the 2860 top — a single-candle wick confirms at 0)

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 1; };

// Directional core — finds SHORT setups. Top-centric: a fractal TOP that (a)
// took out a prior swing high and (b) got rejected — price closed back below
// the swept level within CONFIRM bars. Covers both the one-candle wick sweep
// and the multi-day grind-then-collapse (the user's June-12 V25 case).
// LONGs are found by running this on price-mirrored candles.
function scanShorts(c, { minLeg, scale, tfMin, longAgeHours }) {
  const N = c.length, last = c[N - 1];
  const found = [];
  for (let i = Math.max(K, 10); i < N - K - 1; i++) {
    // the manipulation TOP: K3 fractal high, extreme of the prior EXT bars
    let isTop = true;
    for (let d = 1; d <= K; d++) if (c[i - d].high >= c[i].high || c[i + d].high >= c[i].high) { isTop = false; break; }
    if (!isTop) continue;
    let priorMax = -Infinity;
    for (let m = Math.max(0, i - EXT); m < i; m++) priorMax = Math.max(priorMax, c[m].high);
    if (c[i].high < priorMax) continue; // not the extreme → nothing swept
    // the swept swing S: highest prior fractal high below the top
    let S = -Infinity;
    for (let f = Math.max(K, i - LOOKBACK); f <= i - K; f++) {
      let isF = true;
      for (let d = 1; d <= K; d++) if (c[f - d].high >= c[f].high || c[f + d].high >= c[f].high) { isF = false; break; }
      if (isF && c[f].high < c[i].high && c[f].high > S) S = c[f].high;
    }
    if (S === -Infinity) continue; // no prior swing to sweep
    // rejection: a close back below the swept level within CONFIRM bars
    // (the top candle itself counts — the classic single-candle sweep)
    let conf = -1;
    for (let m = i; m <= Math.min(i + CONFIRM, N - 1); m++) if (c[m].close < S) { conf = m; break; }
    if (conf < 0) continue; // never rejected → continuation, not a SOL
    const solX = c[i].high, jEnd = i;
    // dominance: nothing after the top exceeds the SOL extreme
    let dom = true;
    for (let m = jEnd + 1; m <= N - 1; m++) if (c[m].high > solX) { dom = false; break; }
    if (!dom) continue;
    // leg extreme (fib 0.0): lowest low after the top
    let L = Infinity, l = -1;
    for (let m = jEnd + 1; m <= N - 1; m++) if (c[m].low < L) { L = c[m].low; l = m; }
    if (l < 0 || l === N - 1) continue; // no retrace yet
    const leg = solX - L;
    if (leg < minLeg) continue;
    found.push({ j: i, jEnd, l, solX, L, leg });
  }

  // Dedupe nested near-duplicates (several fractals under the same spike):
  // same leg extreme + 0.618 levels within 10% of the larger leg → keep the
  // outer (larger-leg) structure, which is the one a human draws.
  found.sort((a, b) => b.leg - a.leg);
  const kept = [];
  for (const f of found) {
    const e618 = f.L + 0.618 * f.leg;
    if (kept.some((g) => Math.abs((g.L + 0.618 * g.leg) - e618) < 0.1 * g.leg)) continue;
    kept.push(f);
  }

  return kept.map(({ j, jEnd, l, solX, L, leg }) => {
    const lv = {}; for (const f of [0.5, 0.618, 0.786, 0.886]) lv[f] = L + f * leg;
    let maxR = -Infinity; for (let m = l + 1; m <= N - 1; m++) maxR = Math.max(maxR, c[m].high);
    const firstTouch = (level) => { for (let m = l + 1; m <= N - 1; m++) if (c[m].high >= level) return m; return -1; };
    const t618 = firstTouch(lv[0.618]), t886 = firstTouch(lv[0.886]);
    const aged = ((N - 1 - jEnd) * tfMin) / 60 >= longAgeHours; // calendar-time rule
    return {
      dir: "SHORT", id: `SOLFIB:SHORT:${c[j].t}`, solT: c[j].t,
      solX, target: L, leg, dispX: leg / scale, levels: lv,
      legBars: l - jEnd, ageBars: (N - 1) - l, aged, expected: aged ? 0.886 : 0.618,
      armed: maxR >= lv[0.5],
      tap618: t618 === N - 1 && last.close < lv[0.618],
      tap886: t886 === N - 1 && last.close < lv[0.886],
      // touch epochs (null if the level was never reached) — the manipulation
      // confluence check needs WHEN the level responded, not just whether.
      t618T: t618 >= 0 ? c[t618].t : null,
      t886T: t886 >= 0 ? c[t886].t : null,
      fvgs: fvgsInZone(c, jEnd, Math.min(lv[0.5], lv[0.886]), Math.max(lv[0.5], lv[0.886]), lv),
      price: last.close,
    };
  });
}

// Returns ALL active setups, both directions (each dominant SOL structure).
export function detectSOLFib(candles, { dispMult = 2, tfMin = 60, longAgeHours = 240 } = {}) {
  const c = candles;
  if (!c || c.length < K * 2 + 10) return [];
  const scale = median(c.map((x) => x.high - x.low)) || 1;
  const opts = { minLeg: dispMult * scale, scale, tfMin, longAgeHours };

  const shorts = scanShorts(c, opts);

  // LONGs: mirror prices (× −1, swap high/low), scan shorts, mirror back.
  const mir = c.map((x) => ({ t: x.t, open: -x.open, high: -x.low, low: -x.high, close: -x.close }));
  const longs = scanShorts(mir, opts).map((s) => ({
    ...s,
    dir: "LONG", id: s.id.replace(":SHORT:", ":LONG:"),
    solX: -s.solX, target: -s.target, price: -s.price,
    levels: Object.fromEntries(Object.entries(s.levels).map(([f, v]) => [f, -v])),
    fvgs: s.fvgs.map((g) => ({ top: -g.bot, bot: -g.top, t: g.t, near: g.near })),
  }));

  return [...shorts, ...longs];
}

// FVGs (3-candle bearish gaps) after the SOL that overlap the 0.5–0.886 band,
// tagged with the nearest fib level — the "IFVG @ 0.618" pin from the charts.
// (On mirrored candles this correctly finds bullish gaps for longs.)
function fvgsInZone(c, jEnd, zLo, zHi, lv) {
  const found = [];
  for (let m = jEnd + 1; m < c.length - 1; m++) {
    const A = c[m - 1], C = c[m + 1];
    if (!(C.high < A.low)) continue; // bearish gap in this orientation
    const top = A.low, bot = C.high;
    if (Math.max(bot, zLo) < Math.min(top, zHi)) {
      const mid = (top + bot) / 2;
      let bestF = null, bestD = Infinity;
      for (const f of [0.5, 0.618, 0.786, 0.886]) { const d = Math.abs(lv[f] - mid); if (d < bestD) { bestD = d; bestF = f; } }
      found.push({ top, bot, t: c[m].t, near: bestF });
    }
  }
  return found.slice(-2); // the two most recent are the live ones
}
