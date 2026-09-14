// ─────────────────────────────────────────────────────────────────────────
// ICT LIQUIDITY ENGINE — sweeps of resting liquidity, the way ICT defines them.
//
// Liquidity pools (where stop orders rest):
//   swing    3-candle swing highs/lows (ICT short-term highs/lows), untaken
//   equal    two untaken swings within 0.1 ATR of each other (relative equal highs/lows)
//   pair     two relative highs where the LEFT one sticks out a little further
//            (within 0.5 ATR, at least 3 candles apart); lows mirrored. Taking
//            both is the user's remembered SOL setup. The pool sits at the left one.
//   asia     the Asian session range, 19:00 to 00:00 New York time
//   london   the London session range, 02:00 to 05:00 New York time
//   pdh/pdl  the previous trading day's high/low (the day rolls at 17:00 New York)
//   extreme  the very top/bottom: the highest high (lowest low) of the last
//            EXT_N candles, at least 3 candles old. Off unless asked for in
//            opts.pools, so live alerts and earlier results are unchanged.
//
// Sweep: price trades through a pool and closes back inside it, on the same
//   candle, or closes through and back inside on the very next candle.
//   Closing through and staying through is a RUN, not a sweep.
//
// Market structure shift (MSS): within 10 candles, a candle body closes past
//   the last swing point formed before the sweep, with displacement: the move
//   leaves a fair value gap and the MSS candle's body is at least half its
//   range. If price takes the sweep extreme first, the setup is dead.
//
// Entry model (ICT 2022 mentorship): limit at the consequent encroachment (50%)
//   of the displacement's fair value gap; stop just beyond the sweep extreme;
//   target the nearest untaken liquidity on the other side.
//
// Everything is causal: a pool exists only after the candles that define it
// have closed, and each candle is judged only on what was known at its close.
// ─────────────────────────────────────────────────────────────────────────

export const ICT = {
  MSS_WIN: 10,     // candles allowed between the sweep and the structure shift
  LOOK: 120,       // untaken swing pools older than this many candles expire
  MIN_AGE: 3,      // a swing pool must be at least this many candles old to be swept
  EQ_TOL: 0.1,     // equal highs/lows: within this many ATRs
  PAIR_TOL: 0.5,   // relative pair: the left swing is beyond the right one by at most this many ATRs
  EXT_N: 120,      // "extreme" pool window (120 1H candles is about 5 trading days)
  STOP_BUF: 0.1,   // stop sits this many ATRs beyond the sweep extreme
  ATR_N: 14,
  pools: ["swing", "equal", "pair", "asia", "london", "pdh"],   // "pdh" switches on both pdh and pdl
};
export const RANK = { extreme: 6, pdh: 5, pdl: 5, london: 4, asia: 4, pair: 3.5, equal: 3, swing: 1 };
const SWING_TYPES = new Set(["swing", "equal", "pair"]);
export const HTF_POOLS = ["pdh", "pdl", "asia", "london"];

// New York wall-clock time for a unix timestamp, daylight saving included.
const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const offsets = new Map();
export function nyTime(t) {
  const bucket = Math.floor(t / 3600);
  let off = offsets.get(bucket);
  if (off === undefined) {
    const p = Object.fromEntries(NY.formatToParts(new Date(bucket * 3600 * 1000)).map((x) => [x.type, x.value]));
    off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) / 1000 - bucket * 3600;
    offsets.set(bucket, off);
  }
  const L = new Date((t + off) * 1000);
  return { h: L.getUTCHours(), minutes: L.getUTCHours() * 60 + L.getUTCMinutes(), date: L.toISOString().slice(0, 10) };
}
// The trading day a candle belongs to: 17:00 New York starts the next day.
export const tradingDay = (t) => nyTime(t + 7 * 3600).date;
export function sessionOfNY(t) {
  const m = nyTime(t).minutes;
  return m >= 1140 ? "asia" : m >= 120 && m < 300 ? "london" : m >= 420 && m < 600 ? "nyam" : null;
}

export function analyzeLiquidity(bars, opts = {}) {
  const o = { ...ICT, ...opts };
  const use = new Set(o.pools);
  const n = bars.length;

  // ATR at candle i = average true range of the 14 candles BEFORE it
  const atr = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const tr = i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low;
    if (i >= o.ATR_N) atr[i] = sum / o.ATR_N;
    sum += tr;
    if (i >= o.ATR_N) {
      const p = bars[i - o.ATR_N], pp = i - o.ATR_N ? bars[i - o.ATR_N - 1] : null;
      sum -= pp ? Math.max(p.high - p.low, Math.abs(p.high - pp.close), Math.abs(p.low - pp.close)) : p.high - p.low;
    }
  }

  const levels = [];               // active pools: { price, side: "high"|"low", type, idx }
  const swingsH = [], swingsL = []; // every confirmed swing, for structure references
  const open = [];                 // sweeps waiting for a structure shift
  let pending = [];                // pools closed through on the last candle
  const sweeps = [];
  let day = null, dayHi = -Infinity, dayLo = Infinity;
  let sess = null, sessHi = -Infinity, sessLo = Infinity;

  const addSwing = (side, idx, price, j) => {
    (side === "high" ? swingsH : swingsL).push({ idx, price });
    const a = Number.isFinite(atr[j]) ? atr[j] : 0;
    const same = (L) => L.side === side && SWING_TYPES.has(L.type);
    if (use.has("equal")) {
      const eq = levels.find((L) => same(L) && Math.abs(L.price - price) <= o.EQ_TOL * a);
      if (eq) {
        eq.type = "equal";
        eq.price = side === "high" ? Math.max(eq.price, price) : Math.min(eq.price, price);
        return;
      }
    }
    if (use.has("pair")) {
      // the nearest older untaken swing that sticks out a little beyond this one
      let left = null;
      for (const L of levels) {
        if (!same(L) || idx - L.idx < 3) continue;
        const beyond = side === "high" ? L.price - price : price - L.price;
        if (beyond > 0 && beyond <= o.PAIR_TOL * a && (!left || L.idx > left.idx)) left = L;
      }
      if (left) left.type = "pair";
    }
    if (use.has("swing") || use.has("pair")) levels.push({ price, side, type: "swing", idx });
  };

  for (let j = 0; j < n; j++) {
    const b = bars[j];
    const ny = nyTime(b.t);
    const session = ny.minutes >= 1140 ? "asia" : ny.minutes >= 120 && ny.minutes < 300 ? "london" : ny.minutes >= 420 && ny.minutes < 600 ? "nyam" : null;
    const td = tradingDay(b.t);

    // 1. knowledge that became final at the previous candle's close
    if (j >= 3) {
      const a = bars[j - 3], m = bars[j - 2], c = bars[j - 1];
      if (m.high > a.high && m.high > c.high) addSwing("high", j - 2, m.high, j);
      if (m.low < a.low && m.low < c.low) addSwing("low", j - 2, m.low, j);
    }
    if (session !== sess) {
      if ((sess === "asia" || sess === "london") && use.has(sess) && sessHi > -Infinity) {
        levels.push({ price: sessHi, side: "high", type: sess, idx: j - 1 }, { price: sessLo, side: "low", type: sess, idx: j - 1 });
      }
      sess = session; sessHi = -Infinity; sessLo = Infinity;
    }
    if (td !== day) {
      for (let k = levels.length - 1; k >= 0; k--) if (HTF_POOLS.includes(levels[k].type)) levels.splice(k, 1);
      if (day !== null && use.has("pdh") && dayHi > -Infinity) {
        levels.push({ price: dayHi, side: "high", type: "pdh", idx: j - 1 }, { price: dayLo, side: "low", type: "pdl", idx: j - 1 });
      }
      day = td; dayHi = -Infinity; dayLo = Infinity;
    }
    for (let k = levels.length - 1; k >= 0; k--) {
      const L = levels[k];
      if (SWING_TYPES.has(L.type) && j - L.idx > o.LOOK) levels.splice(k, 1);
    }
    // the very top/bottom of the last EXT_N closed candles, once it is 3+ candles old
    if (use.has("extreme") && j > o.EXT_N) {
      for (const side of ["high", "low"]) {
        let best = side === "high" ? -Infinity : Infinity, at = -1;
        for (let k = j - o.EXT_N; k < j; k++) {
          const p = side === "high" ? bars[k].high : bars[k].low;
          if (side === "high" ? p > best : p < best) { best = p; at = k; }
        }
        const cur = levels.findIndex((L) => L.type === "extreme" && L.side === side);
        if (cur >= 0) levels.splice(cur, 1);
        if (at <= j - o.MIN_AGE) levels.push({ price: best, side, type: "extreme", idx: at });
      }
    }

    // 2. open sweeps: dead if the extreme is taken, confirmed on a displaced body close past structure
    for (let k = open.length - 1; k >= 0; k--) {
      const w = open[k], short = w.dir === "SHORT";
      if (short ? b.high > w.extreme : b.low < w.extreme) { open.splice(k, 1); continue; }
      if (j - w.idx > o.MSS_WIN) { open.splice(k, 1); continue; }
      const body = Math.abs(b.close - b.open), range = b.high - b.low;
      const broke = short ? b.close < w.ref && b.close < b.open : b.close > w.ref && b.close > b.open;
      if (!broke || body < 0.5 * range) continue;
      let fvg = null;                                   // the gap's middle candle is the sweep candle or later
      for (let m = j; m >= w.idx + 1 && m >= 2; m--) {
        const c1 = bars[m - 2], c3 = bars[m];
        if (short && c1.low > c3.high) { fvg = { top: c1.low, bottom: c3.high, idx: m }; break; }
        if (!short && c1.high < c3.low) { fvg = { top: c3.low, bottom: c1.high, idx: m }; break; }
      }
      if (!fvg) continue;                               // no displacement yet: keep waiting
      fvg.ce = (fvg.top + fvg.bottom) / 2;
      const stop = short ? w.extreme + o.STOP_BUF * w.atr : w.extreme - o.STOP_BUF * w.atr;
      const opp = levels
        .filter((L) => L.side === (short ? "low" : "high") && (short ? L.price < fvg.ce : L.price > fvg.ce))
        .sort((x, y) => (short ? y.price - x.price : x.price - y.price));
      w.mss = { idx: j, t: b.t, close: b.close, fvg, entry: fvg.ce, stop, target: opp[0]?.price ?? null, targetType: opp[0]?.type ?? null };
      open.splice(k, 1);
    }

    // 3. pools closed through last candle: a sweep if this candle closes back inside, else a run
    const found = [];
    for (const p of pending) {
      if (p.side === "high" ? b.close < p.price : b.close > p.price) found.push({ ...p, twoCandle: true });
    }
    pending = [];

    // 4. pools this candle trades through (taken either way; a sweep only if it closes back inside)
    for (let k = levels.length - 1; k >= 0; k--) {
      const L = levels[k];
      const through = L.side === "high" ? b.high > L.price : b.low < L.price;
      if (!through) continue;
      levels.splice(k, 1);
      if (SWING_TYPES.has(L.type) && j - L.idx < o.MIN_AGE) continue;
      const inside = L.side === "high" ? b.close < L.price : b.close > L.price;
      (inside ? found : pending).push({ side: L.side, price: L.price, type: L.type });
    }

    // 5. one sweep event per side per candle
    for (const side of ["high", "low"]) {
      const g = found.filter((x) => x.side === side);
      if (!g.length) continue;
      const short = side === "high";
      const two = g.some((x) => x.twoCandle);
      const extreme = short ? Math.max(b.high, two ? bars[j - 1].high : -Infinity) : Math.min(b.low, two ? bars[j - 1].low : Infinity);
      const start = two ? j - 1 : j;
      const refs = short ? swingsL : swingsH;              // structure protecting the move into the sweep
      let ref = null;
      for (let r = refs.length - 1; r >= 0; r--) if (refs[r].idx < start) { ref = refs[r]; break; }
      const top = g.reduce((a, x) => (RANK[x.type] > RANK[a.type] ? x : a));
      const ev = {
        dir: short ? "SHORT" : "LONG", idx: j, t: b.t, close: b.close, extreme,
        type: top.type, levels: g.map((x) => ({ type: x.type, price: x.price })), twoCandle: two,
        session, killzone: session === "london" || session === "nyam",
        atr: atr[j], ref: ref ? ref.price : null, mss: null,
      };
      sweeps.push(ev);
      if (ref && Number.isFinite(atr[j])) open.push(ev);
    }

    dayHi = Math.max(dayHi, b.high); dayLo = Math.min(dayLo, b.low);
    if (sess === "asia" || sess === "london") { sessHi = Math.max(sessHi, b.high); sessLo = Math.min(sessLo, b.low); }
  }
  return { sweeps, levels, atr };
}
