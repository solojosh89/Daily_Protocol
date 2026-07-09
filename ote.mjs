// ─────────────────────────────────────────────────────────────────────────
// OTE / STRUCTURE SETUP DETECTOR  (the A-grade, rare, factual alert)
//
// This is the setup validated in ote-study.mjs: on REAL markets it beat the RNG
// control in 11 of 12 parameter combinations, and the edge GREW with stronger
// displacement — so we only flag STRONG-displacement setups (≥ dispMult× the
// instrument's median 4H range). Long AND short (mirror image).
//
// It fires ONLY when every condition is already a FACT on the chart — no
// prediction, no mid-candle "maybe":
//   1. a fractal swing low/high formed and was SWEPT (closed back through it)
//   2. a real DISPLACEMENT leg followed (≥ dispMult× median range)
//   3. price has ALREADY retraced into the 0.618–0.786 OTE zone, without
//      breaking the swept level (which would invalidate it)
//
// Returns the single most-recent ACTIVE setup as of the last candle (or null).
// `id` is stable (direction + sweep-candle time) so the monitor fires once.
// ─────────────────────────────────────────────────────────────────────────

const K = 3;            // fractal half-width
const SWEEP_WIN = 20;   // candles after the fractal to find the sweep
const LEG_WIN = 24;     // candles after the sweep to build the displacement leg
const RETRACE_WIN = 24; // max candles from the leg extreme to "now" (freshness)
const EXT = 30;         // depth window: swing == extreme of prior 30 candles → A+ grade
                        // (extreme-study.mjs: deep 5/5 vs shallow 46% real — small n,
                        // so it's a GRADE on the alert, not a filter; forward data decides)

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 1; };

export function detectOTE(candles, { dispMult = 2.5, fibNear = 0.618, fibFar = 0.786 } = {}) {
  const c = candles;
  if (!c || c.length < K * 2 + 6) return null;
  const scale = median(c.map((x) => x.high - x.low)) || 1;
  const minDisp = dispMult * scale;
  const N = c.length;
  const last = c[N - 1];
  let best = null; // keep the most-recent (largest sweep index) active setup

  const consider = (cand) => { if (cand && (!best || cand.j > best.j)) best = cand; };

  for (let i = K; i < N - K - 1; i++) {
    // ── BULLISH: fractal swing low → sweep → up-displacement → retrace to zone
    let isLow = true;
    for (let d = 1; d <= K; d++) if (c[i - d].low <= c[i].low || c[i + d].low <= c[i].low) { isLow = false; break; }
    if (isLow) {
      const swingLow = c[i].low;
      // depth: was this swing ALSO the lowest low of the prior EXT candles?
      let priorMin = Infinity;
      for (let m = Math.max(0, i - EXT); m < i; m++) priorMin = Math.min(priorMin, c[m].low);
      const deep = i >= 10 && swingLow <= priorMin;
      let j = -1;
      for (let m = i + K + 1; m <= Math.min(i + K + SWEEP_WIN, N - 1); m++) {
        if (c[m].low < swingLow && c[m].close > swingLow) { j = m; break; }
        if (c[m].close < swingLow) break; // broke and stayed below → structure gone
      }
      if (j >= 0) {
        const sweepLow = c[j].low;
        // leg high = highest high from the sweep candle up to now (within window)
        let H = c[j].high, hIdx = j;
        const end = Math.min(j + LEG_WIN + RETRACE_WIN, N - 1);
        for (let m = j + 1; m <= end; m++) { if (c[m].high > H) { H = c[m].high; hIdx = m; } }
        const leg = H - sweepLow;
        const near = H - fibNear * leg;   // shallow edge (higher price)
        const far = H - fibFar * leg;     // deep edge (lower price)
        if (
          leg >= minDisp &&                       // strong displacement
          hIdx < N - 1 &&                          // the high is in the past
          (N - 1) - hIdx <= RETRACE_WIN &&         // fresh
          last.low <= near && last.close < H &&    // price has dipped into the zone
          last.low > sweepLow                      // not invalidated (stop not hit)
        ) {
          consider({
            dir: "LONG", j, id: `LONG:${c[j].t}`, deep,
            entryNear: near, entryFar: far, stop: sweepLow, target: H,
            leg, dispX: leg / scale, sweepT: c[j].t, price: last.close,
          });
        }
      }
    }

    // ── BEARISH: fractal swing high → sweep → down-displacement → retrace to zone
    let isHigh = true;
    for (let d = 1; d <= K; d++) if (c[i - d].high >= c[i].high || c[i + d].high >= c[i].high) { isHigh = false; break; }
    if (isHigh) {
      const swingHigh = c[i].high;
      let priorMax = -Infinity;
      for (let m = Math.max(0, i - EXT); m < i; m++) priorMax = Math.max(priorMax, c[m].high);
      const deep = i >= 10 && swingHigh >= priorMax;
      let j = -1;
      for (let m = i + K + 1; m <= Math.min(i + K + SWEEP_WIN, N - 1); m++) {
        if (c[m].high > swingHigh && c[m].close < swingHigh) { j = m; break; }
        if (c[m].close > swingHigh) break;
      }
      if (j >= 0) {
        const sweepHigh = c[j].high;
        let L = c[j].low, lIdx = j;
        const end = Math.min(j + LEG_WIN + RETRACE_WIN, N - 1);
        for (let m = j + 1; m <= end; m++) { if (c[m].low < L) { L = c[m].low; lIdx = m; } }
        const leg = sweepHigh - L;
        const near = L + fibNear * leg;   // shallow edge (lower price)
        const far = L + fibFar * leg;     // deep edge (higher price)
        if (
          leg >= minDisp &&
          lIdx < N - 1 &&
          (N - 1) - lIdx <= RETRACE_WIN &&
          last.high >= near && last.close > L &&
          last.high < sweepHigh
        ) {
          consider({
            dir: "SHORT", j, id: `SHORT:${c[j].t}`, deep,
            entryNear: near, entryFar: far, stop: sweepHigh, target: L,
            leg, dispX: leg / scale, sweepT: c[j].t, price: last.close,
          });
        }
      }
    }
  }
  if (best) best.fvg = findFVG(c, best);
  return best;
}

// ─────────────────────────────────────────────────────────────────────────
// 61.8% FIB REVERSAL  (the SYNTHETICS variant — experimental, UNVALIDATED)
//
// Deriv synthetics are RNG random walks: there is no liquidity/order-flow behind
// a level, so the sweep-based OTE above has no basis here. This is a pure
// geometric fib-retracement reversal, by request — treat it as geometry, not a
// proven edge, until backtested. Every condition is a FACT on the last candle:
//   1. an impulse leg (fractal swing low→high, or high→low, ≥ dispMult× median range)
//   2. price retraced to the 0.618 level (wicked into it)
//   3. the last candle CLOSED back in the impulse direction (rejected 0.618)
//   4. it has NOT broken past 0.786 (that level is the invalidation / stop)
// Entry 0.618 · Stop 0.786 · Target the leg extreme. Mirror for long/short.
// Returns the most-recent active setup (or null); stable id → fires once.
// ─────────────────────────────────────────────────────────────────────────
export function detectFibReversal(candles, { dispMult = 1.5, fib = 0.618, invalidate = 0.786 } = {}) {
  const c = candles;
  if (!c || c.length < K * 2 + 6) return null;
  const scale = median(c.map((x) => x.high - x.low)) || 1;
  const minLeg = dispMult * scale;
  const N = c.length, last = c[N - 1];
  let best = null;
  const consider = (cand) => { if (cand && (!best || cand.h > best.h)) best = cand; };

  for (let i = K; i < N - K - 1; i++) {
    // fractal swing LOW at i → look for a swing HIGH after it → up-leg → retrace down to 0.618
    let isLow = true;
    for (let d = 1; d <= K; d++) if (c[i - d].low <= c[i].low || c[i + d].low <= c[i].low) { isLow = false; break; }
    if (isLow) {
      const low = c[i].low;
      let H = -Infinity, h = -1;
      for (let m = i + 1; m <= Math.min(i + LEG_WIN, N - 1); m++) if (c[m].high > H) { H = c[m].high; h = m; }
      if (h > i) {
        const leg = H - low;
        const l618 = H - fib * leg, l786 = H - invalidate * leg;
        if (
          leg >= minLeg &&
          (N - 1) - h <= RETRACE_WIN &&                 // fresh leg
          last.low <= l618 && last.close > l618 &&       // reached 0.618 and closed back above (reversal)
          last.low > l786                                // not broken past 0.786 (still valid)
        ) consider({ dir: "LONG", kind: "fib618", h, id: `FIB618:LONG:${c[h].t}`, deep: false,
          entryNear: l618, entryFar: l786, stop: l786, target: H, leg, dispX: leg / scale, sweepT: c[h].t, price: last.close });
      }
    }
    // fractal swing HIGH at i → swing LOW after it → down-leg → retrace up to 0.618
    let isHigh = true;
    for (let d = 1; d <= K; d++) if (c[i - d].high >= c[i].high || c[i + d].high >= c[i].high) { isHigh = false; break; }
    if (isHigh) {
      const high = c[i].high;
      let L = Infinity, h = -1;
      for (let m = i + 1; m <= Math.min(i + LEG_WIN, N - 1); m++) if (c[m].low < L) { L = c[m].low; h = m; }
      if (h > i) {
        const leg = high - L;
        const l618 = L + fib * leg, l786 = L + invalidate * leg;
        if (
          leg >= minLeg &&
          (N - 1) - h <= RETRACE_WIN &&
          last.high >= l618 && last.close < l618 &&
          last.high < l786
        ) consider({ dir: "SHORT", kind: "fib618", h, id: `FIB618:SHORT:${c[h].t}`, deep: false,
          entryNear: l618, entryFar: l786, stop: l786, target: L, leg, dispX: leg / scale, sweepT: c[h].t, price: last.close });
      }
    }
  }
  return best;
}

// FVG confluence: a 3-candle fair value gap formed during the leg that overlaps
// the 0.62–0.79 entry zone. Measured (fvg-study.mjs): the naked FVG entry has
// no standalone edge (≈RNG), but gaps get tapped 82% of the time — so inside a
// valid OTE zone it serves as the fine-tuned entry, not as its own signal.
// Returns the most recent overlapping gap, or null.
function findFVG(c, o) {
  const lo = Math.min(o.entryNear, o.entryFar), hi = Math.max(o.entryNear, o.entryFar);
  let found = null;
  for (let m = o.j + 1; m < c.length - 1; m++) {
    const A = c[m - 1], C = c[m + 1];
    if (o.dir === "LONG" && C.low > A.high) {
      const top = C.low, bot = A.high;
      if (Math.max(bot, lo) < Math.min(top, hi)) found = { top, bot, t: c[m].t };
    } else if (o.dir === "SHORT" && C.high < A.low) {
      const top = A.low, bot = C.high;
      if (Math.max(bot, lo) < Math.min(top, hi)) found = { top, bot, t: c[m].t };
    }
  }
  return found;
}
