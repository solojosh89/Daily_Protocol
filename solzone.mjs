// ─────────────────────────────────────────────────────────────────────────
// SOL ZONE — the user's own setup, alerted live.
//
// On the SETUP timeframe (4H by default):
//   SOL    two untaken relative highs, the LEFT one higher by at most half an
//          ATR and at least 3 candles apart. The move takes both (over up to 8
//          candles) and the candle that takes the left one, or the next, closes
//          back below it. Mirrored for lows.
//   BOS    one close through the most recent opposite swing known before the
//          SOL. One is enough.
//   fib    1 = the SOL extreme (also the line that kills the setup),
//          0 = the furthest point the move reached before pulling back.
//
// On the TRIGGER timeframe (1H by default), price pulls back through a ladder:
// 0.5, 0.618, 0.786, 0.886. A level is BROKEN when a candle body closes beyond
// it. The alert fires at the first unbroken level where two candles do this
// (for a sell; buys are the mirror):
//   A   green, its high reaches the level, with an upper wick
//   B   the next candle, red, closes BELOW the level, with an upper wick
//   both have upper wicks, and one is longer than the other (either one:
//   on the user's own Gold trade it was B that dug deeper)
// Entry is B's close. Stop just above the higher of the two wicks. Target fib 0.
//
// Everything is judged only on closed candles. Pure functions, no I/O.
// ─────────────────────────────────────────────────────────────────────────

export const SZ = {
  LEVELS: [0.5, 0.618, 0.786, 0.886],
  PAIR_TOL: 0.5, PAIR_GAP: 3, LOOK: 120, SPAN: 8,
  BOS_WIN: 30,        // setup-timeframe candles allowed between SOL and BOS
  MAX_AGE: 60,        // setup-timeframe candles a setup stays alive after the SOL
};

function atrAt(bars, i, n = 14) {
  if (i < n + 1) return NaN;
  let s = 0;
  for (let k = i - n; k < i; k++) {
    const b = bars[k], p = bars[k - 1];
    s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  return s / n;
}
// a 3-candle swing at m is only known once m+1 has closed
function swings(bars) {
  const H = [], L = [];
  for (let m = 1; m < bars.length - 1; m++) {
    if (bars[m].high > bars[m - 1].high && bars[m].high > bars[m + 1].high) H.push({ idx: m, known: m + 2, price: bars[m].high });
    if (bars[m].low < bars[m - 1].low && bars[m].low < bars[m + 1].low) L.push({ idx: m, known: m + 2, price: bars[m].low });
  }
  return { H, L };
}

// Every SOL + BOS setup in closed setup-timeframe bars.
// Returns [{ dir, solT, bosT, fib1, solIdx, bosIdx, left, right }]
// tfSec is the setup timeframe: a BOS is only KNOWN once its candle has
// closed, so bosT is that close time, and nothing may trigger before it.
export function findSetups(bars, tfSec = 14400) {
  const sw = swings(bars);
  const out = [];
  for (const dir of ["SHORT", "LONG"]) {
    const short = dir === "SHORT";
    const tops = short ? sw.H : sw.L, floors = short ? sw.L : sw.H;
    const beyond = (a, b) => (short ? a - b : b - a);
    const live = [];
    let ti = 0;
    for (let j = 20; j < bars.length; j++) {
      while (ti < tops.length && tops[ti].known <= j) { live.push({ ...tops[ti] }); ti++; }
      for (let k = live.length - 1; k >= 0; k--) if (live[k].idx < j - SZ.LOOK || live[k].taken) live.splice(k, 1);
      const B = bars[j], N = bars[j + 1];
      const a = atrAt(bars, j);
      let sol = null;
      if (live.length >= 2 && Number.isFinite(a)) {
        for (let x = live.length - 1; x >= 1 && !sol; x--) for (let y = x - 1; y >= 0; y--) {
          const right = live[x], left = live[y];
          if (right.idx - left.idx < SZ.PAIR_GAP) continue;
          const d = beyond(left.price, right.price);
          if (!(d > 0 && d <= SZ.PAIR_TOL * a)) continue;
          const takesLeft = left.takenAt == null && (short ? B.high > left.price : B.low < left.price);
          const rightGone = right.takenAt != null ? right.takenAt >= j - SZ.SPAN : true;
          const onB = short ? B.close < left.price : B.close > left.price;
          const onN = N && (short ? N.close < left.price : N.close > left.price);
          if (takesLeft && rightGone && (onB || onN)) { sol = { left, right, known: onB ? j : j + 1 }; break; }
        }
      }
      for (const t of live) if (t.takenAt == null && (short ? B.high > t.price : B.low < t.price)) t.takenAt = j;
      for (const t of live) if (t.takenAt != null && t.takenAt < j - SZ.SPAN) t.taken = true;
      if (!sol) continue;
      const fib1 = short ? Math.max(B.high, N ? N.high : B.high) : Math.min(B.low, N ? N.low : B.low);
      const prior = floors.filter((f) => f.known <= j && f.idx < j);
      if (!prior.length) continue;
      const lvl = prior[prior.length - 1].price;
      for (let k = sol.known + 1; k <= j + SZ.BOS_WIN && k < bars.length; k++) {
        if (short ? bars[k].high > fib1 : bars[k].low < fib1) break;
        if (short ? bars[k].close < lvl : bars[k].close > lvl) {
          out.push({ dir, solIdx: j, solT: B.t, bosIdx: k, bosT: bars[k].t + tfSec, fib1, left: sol.left.price, right: sol.right.price, bosLevel: lvl });
          break;
        }
      }
    }
  }
  return out;
}

// Walk the trigger-timeframe candles after the BOS. Returns
//   { status: "dead" }                       fib 1 was taken
//   { status: "waiting", fib0, levels }      nothing yet
//   { status: "trigger", ... }               A and B formed at a level
// minLevel: levels already alerted for this setup. Only deeper levels count, so
// when a 0.618 rejection fails the setup can still alert at 0.786 or 0.886.
export function ladder(setup, ltf, tfSec, minLevel = 0) {
  const short = setup.dir === "SHORT";
  const H = setup.fib1;
  // fib 0: the furthest point since the SOL, frozen once the pullback starts
  let start = ltf.findIndex((b) => b.t >= setup.solT);
  if (start < 0) return { status: "waiting" };
  let fib0 = short ? Infinity : -Infinity, ext = start;
  // levels a candle body closed through BEFORE candle A. A's own close does
  // not count: A pushing past a level and B closing back is the rejection.
  let broken = new Set(), brokenBeforeA = new Set();
  const lvl = (f) => (short ? fib0 + f * (H - fib0) : fib0 - f * (fib0 - H));
  for (let k = start; k < ltf.length; k++) {
    const b = ltf[k];
    if (short ? b.high > H : b.low < H) return { status: "dead", at: b.t };
    const newExt = short ? b.low < fib0 : b.high > fib0;
    if (newExt) { fib0 = short ? b.low : b.high; ext = k; broken = new Set(); brokenBeforeA = new Set(); continue; }
    const A = ltf[k - 1];
    // A/B pattern with B = this candle, A = the one before, both after the extreme
    if (b.t >= setup.bosT && k - 1 > ext) {
      const aUp = short ? A.close > A.open : A.close < A.open;
      const bDn = short ? b.close < b.open : b.close > b.open;
      const wick = (c) => (short ? c.high - Math.max(c.open, c.close) : Math.min(c.open, c.close) - c.low);
      if (aUp && bDn && wick(A) > 0 && wick(b) > 0 && wick(A) !== wick(b)) {
        // deepest unbroken level A reached and B closed back through
        for (const f of [...SZ.LEVELS].reverse()) {
          if (brokenBeforeA.has(f) || f <= minLevel) continue;
          const L = lvl(f);
          const reached = short ? A.high >= L : A.low <= L;
          const closedBack = short ? b.close < L : b.close > L;
          if (reached && closedBack) {
            const stop = short ? Math.max(A.high, b.high) : Math.min(A.low, b.low);
            const entry = b.close;
            const risk = Math.abs(stop - entry);
            if (!(risk > 0)) break;
            return {
              status: "trigger", level: f, levelPrice: L, fib0, fib1: H, entry, stop, target: fib0,
              rr: Math.abs(fib0 - entry) / risk, aT: A.t, bT: b.t, closedAt: b.t + tfSec,
            };
          }
        }
      }
    }
    // after checking the pattern, record which levels this candle's body closed
    // through. Next round this candle is A, so the "before A" set lags one behind.
    brokenBeforeA = new Set(broken);
    if (k > ext) for (const f of SZ.LEVELS) if (short ? b.close > lvl(f) : b.close < lvl(f)) broken.add(f);
  }
  return { status: "waiting", fib0, levels: Object.fromEntries(SZ.LEVELS.map((f) => [f, lvl(f)])) };
}
