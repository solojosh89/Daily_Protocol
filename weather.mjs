// ---------------------------------------------------------------------------
// MARKET WEATHER: how big the next few hours are likely to be.
//
// This is the ONE forecast engine. vol-forecast.mjs (the study that proved it
// works) and the /weather Telegram command both call it, so what the chat
// shows is exactly what was tested, not a lookalike.
//
// WHAT IT KNOWS: every direction study failed, but real markets have one
// strong, non-random habit. Wild candles come in bunches, and some hours of the
// day are always busier than others. So the SIZE of upcoming candles is
// predictable even though their DIRECTION is not.
//
// THE FORECAST (only candles that have already closed are used):
//   naive     average candle size over the last 200 candles
//   recent    average candle size over the last 20 candles
//   clock     for each upcoming candle, the average size at that same time of
//             day over the last 20 days
//   combined  clock x (recent / naive): "this hour, in today's weather"
// Candle size is measured as a PERCENT of price, so a month of price drift
// cannot distort it.
//
// TESTED (vol-forecast.mjs, about 10 months of 1H candles, next 4 hours):
//   combined was 13% (Gold), 29% (Nasdaq), 15% (GBP/JPY) closer to what really
//   happened than assuming "normal". When it read stormy, the next 4 hours
//   were 1.7 to 2.2 times the size of when it read calm. On a generated random
//   walk it did nothing, as it should. On 15m candles it was NOT reliable.
//
// It never says which way price will go.
// ---------------------------------------------------------------------------

export const FAST = 20;
export const SLOW = 200;
export const CLOCK_DAYS = 20;

export const pctRange = (b) => (b.high - b.low) / b.close;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// Walk the candles once, in order. At every candle j that has enough history,
// call onPoint(j, { naive, recent, clock, combined }). Nothing after j is used
// except the TIMES of the next `horizon` candles (which hour of the day they
// fall in). When those candles do not exist yet, their times are projected.
export function forecastWalk(bars, tfMin, horizon, onPoint) {
  const step = tfMin * 60;
  const perDay = Math.round(1440 / tfMin);
  const slotOf = (t) => Math.floor((((t % 86400) + 86400) % 86400) / step);
  const size = bars.map(pctRange);
  const bySlot = new Map();
  let fSum = 0, sSum = 0;
  for (let j = 0; j < bars.length; j++) {
    fSum += size[j]; sSum += size[j];
    if (j >= FAST) fSum -= size[j - FAST];
    if (j >= SLOW) sSum -= size[j - SLOW];
    const sl = slotOf(bars[j].t);
    if (!bySlot.has(sl)) bySlot.set(sl, []);
    bySlot.get(sl).push(size[j]);
    if (j < SLOW + CLOCK_DAYS * perDay) continue;

    let clockSum = 0, ok = true;
    for (let k = 1; k <= horizon; k++) {
      const t = j + k < bars.length ? bars[j + k].t : bars[j].t + k * step;
      const seen = (bySlot.get(slotOf(t)) || []).slice(-CLOCK_DAYS);
      if (seen.length < 5) { ok = false; break; }
      clockSum += mean(seen);
    }
    if (!ok) continue;
    const naive = sSum / SLOW, recent = fSum / FAST, clock = clockSum / horizon;
    if (!(naive > 0) || !(clock > 0)) continue;
    onPoint(j, { naive, recent, clock, combined: clock * (recent / naive) });
  }
}

// The live report, from 1H candles.
//   now       seconds; lets tests fix the clock. The candle still forming at
//             `now` is DROPPED, so the report only ever uses closed candles.
//   survival  the stop suggestion is the distance that 4 hours of ordinary
//             noise did NOT reach this fraction of the time, measured on this
//             instrument's own recent history, both directions.
export function weatherReport(allBars, { tfMin = 60, horizon = 4, now = Math.floor(Date.now() / 1000), survival = 0.8 } = {}) {
  const step = tfMin * 60;
  const bars = (allBars || []).filter((b) => b.t + step <= now);
  const needed = SLOW + CLOCK_DAYS * Math.round(1440 / tfMin) + 100;
  if (bars.length < needed) return { ok: false, reason: "not enough history" };
  const last = bars[bars.length - 1];
  if (now - (last.t + step) > 3 * step) return { ok: false, closed: true, lastClose: last.t + step, reason: "market closed" };

  const pts = [];
  forecastWalk(bars, tfMin, horizon, (j, f) => pts.push({ j, ...f }));
  const cur = pts.length && pts[pts.length - 1].j === bars.length - 1 ? pts[pts.length - 1] : null;
  const hist = pts.filter((p) => p.j + horizon < bars.length);
  if (!cur || hist.length < 100) return { ok: false, reason: "not enough history" };

  // how lively is right now, compared with the recent past?
  const ratioNow = cur.combined / cur.naive;
  const percentile = hist.filter((p) => p.combined / p.naive < ratioNow).length / hist.length;
  const label = percentile < 1 / 3 ? "calm" : percentile < 2 / 3 ? "normal" : "stormy";

  // how far did price wander AGAINST a trade within the next `horizon`
  // candles, measured in forecast candle sizes? (long and short both)
  const mult = [];
  for (const p of hist) {
    const c0 = bars[p.j].close;
    const unit = p.combined * c0;
    if (!(unit > 0)) continue;
    let lo = Infinity, hi = -Infinity;
    for (let k = 1; k <= horizon; k++) {
      const b = bars[p.j + k];
      if (b.low < lo) lo = b.low;
      if (b.high > hi) hi = b.high;
    }
    mult.push(Math.max(0, c0 - lo) / unit, Math.max(0, hi - c0) / unit);
  }
  mult.sort((a, b) => a - b);
  const stopMult = mult[Math.min(mult.length - 1, Math.floor(survival * mult.length))];
  const price = last.close;

  return {
    ok: true,
    label,
    percentile,
    price,
    asOf: last.t + step,
    candleNow: cur.combined * price,
    candleNormal: cur.naive * price,
    vsNormal: ratioNow,
    stopMult,
    stopDist: stopMult * cur.combined * price,
    survival,
    horizon,
    tfMin,
    histDays: (bars[hist[hist.length - 1].j].t - bars[hist[0].j].t) / 86400,
  };
}
