// Deriv WebSocket helper — real candle data, no API key, native WebSocket.
//
// dataSrc per instrument, decided by direct comparison against TradingView's
// own feed (the chart you actually trade off):
//   "deriv" — Deriv's candles matched TradingView/OANDA within noise (a few
//             cents on Gold, fractions of a pip on GBP/JPY). Safe to keep.
//   "tv"    — Deriv's candle diverged materially from TradingView/OANDA
//             (Nasdaq: ~$80/candle, inconsistent sign — not just a fixed
//             broker spread). Sourced directly from TradingView instead so
//             it is guaranteed to match what you see on your chart.
// `offset` = 4H bucket alignment in whole hours from UTC, PER INSTRUMENT.
//   Reals via Deriv frx* → 1  (verified: matches OANDA on TradingView, candles
//                              open 01/05/09/13/17/21 NY).
//   Deriv synthetics      → 0  (verified vs the user's TradingView R_100: those
//                              bucket on the plain UTC grid, 00/04/08/12/16/20 NY.
//                              Using 1 here shifted every synthetic candle 1h and
//                              produced phantom sweeps.)
//   TV-sourced (Nasdaq)   → n/a (TradingView bars are already correctly aligned).
// `emoji`/`short` = per-pair visual identity, leading every alert so a burst of
// simultaneous notifications is tellable apart from the lock screen alone.
// Circles = standard synthetics, squares = their (1s) variants; color = family.
export const INSTRUMENTS = [
  // real markets — sweeps here reflect genuine liquidity
  // Gold: pulled from TradingView's FOREXCOM:XAUUSD so candles match the user's
  // Forex.com chart EXACTLY — same feed, same session alignment (Forex.com's 4H
  // grid is +2h: 02:00/06:00/10:00… NY). The old Deriv frxXAUUSD feed sat on the
  // +1h OANDA grid and diverged by ~an hour and a few dollars — see the Gold
  // "doesn't rhyme with my chart" fix. tv bars self-align, so offset is unused.
  { key: "XAUUSD", sym: "frxXAUUSD", tvSym: "FOREXCOM:XAUUSD", label: "Gold", short: "GOLD", emoji: "🥇", dataSrc: "tv", offset: 0 },
  // Nasdaq: verified EXACT (to the decimal) against the user's own IG chart via
  // TradingView's public symbol-search API (symbol="NASDAQ", exchange="IG" —
  // NOT "NAS100"/"US100"/etc, which all return "invalid symbol"). If this ever
  // needs re-deriving: GET https://symbol-search.tradingview.com/symbol_search/v3/
  //   ?text=<name>&domain=production  (needs a browser-like User-Agent/Origin header)
  { key: "NAS100", sym: "OTC_NDX", tvSym: "IG:NASDAQ", label: "Nasdaq", short: "NASDAQ", emoji: "💻", dataSrc: "tv", offset: 0 },
  { key: "EURUSD", sym: "frxEURUSD", label: "EUR/USD", short: "EURUSD", emoji: "💶", dataSrc: "deriv", offset: 1 },
  { key: "GBPJPY", sym: "frxGBPJPY", label: "GBP/JPY", short: "GBPJPY", emoji: "💷", dataSrc: "deriv", offset: 1 },
  // synthetic indices — Deriv RNG random walks (no real liquidity behind a "sweep")
  { key: "V25", sym: "R_25", label: "Volatility 25", short: "V25", emoji: "🟢", dataSrc: "deriv", offset: 0 },
  { key: "V25S", sym: "1HZ25V", label: "Volatility 25 (1s)", short: "V25s", emoji: "🟩", dataSrc: "deriv", offset: 0 },
  { key: "V50", sym: "R_50", label: "Volatility 50", short: "V50", emoji: "🟡", dataSrc: "deriv", offset: 0 },
  { key: "V50S", sym: "1HZ50V", label: "Volatility 50 (1s)", short: "V50s", emoji: "🟨", dataSrc: "deriv", offset: 0 },
  { key: "V75", sym: "R_75", label: "Volatility 75", short: "V75", emoji: "🟣", dataSrc: "deriv", offset: 0 },
  { key: "V75S", sym: "1HZ75V", label: "Volatility 75 (1s)", short: "V75s", emoji: "🟪", dataSrc: "deriv", offset: 0 },
  { key: "V100", sym: "R_100", label: "Volatility 100", short: "V100", emoji: "🔴", dataSrc: "deriv", offset: 0 },
  { key: "V100S", sym: "1HZ100V", label: "Volatility 100 (1s)", short: "V100s", emoji: "🟥", dataSrc: "deriv", offset: 0 },
];

// Leading identity tag for every alert headline: "🥇 GOLD", "🟪 V75s"…
export const idTag = (inst) => `${inst.emoji || "▫️"} ${inst.short || inst.label}`;

const ENDPOINTS = [
  "wss://ws.derivws.com/websockets/v3?app_id=1089",
  "wss://ws.binaryws.com/websockets/v3?app_id=1089",
  "wss://blue.derivws.com/websockets/v3?app_id=1089",
];

// Fetch the last `count` candles at `granularity` seconds (14400 = 4H).
export function fetchCandles(sym, count = 200, granularity = 14400) {
  return new Promise((resolve, reject) => {
    let ep = 0, done = false;

    const connect = () => {
      if (done) return;
      if (ep >= ENDPOINTS.length) { done = true; return reject(new Error(`all endpoints failed for ${sym}`)); }

      let sock;
      try { sock = new WebSocket(ENDPOINTS[ep]); }
      catch { ep++; return connect(); }

      let dead = false;
      const detach = () => { dead = true; try { sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null; } catch {} };
      const fail = () => { if (dead) return; clearTimeout(timer); detach(); try { sock.close(); } catch {} ep++; connect(); };
      const timer = setTimeout(fail, 12000);

      sock.onopen = () => {
        if (dead || done || sock.readyState !== 1) return;
        try {
          sock.send(JSON.stringify({
            ticks_history: sym, end: "latest", count, style: "candles", granularity, adjust_start_time: 1, req_id: 1,
          }));
        } catch { fail(); }
      };
      sock.onmessage = (ev) => {
        if (dead || done) return;
        let d; try { d = JSON.parse(ev.data); } catch { return; }
        if (d.msg_type === "candles") {
          done = true; clearTimeout(timer); detach(); try { sock.close(); } catch {}
          resolve(d.candles.map((c) => ({ t: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close })));
        } else if (d.error) {
          done = true; clearTimeout(timer); detach(); try { sock.close(); } catch {}
          reject(new Error(d.error.message));
        }
      };
      sock.onerror = fail;
      sock.onclose = () => { if (!dead && !done) fail(); };
    };
    connect();
  });
}

export const utc = (epoch) =>
  new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

// Format an epoch in a display timezone given as a whole-hour offset from UTC.
export function fmtTime(epoch, offsetHours = 0, label = "UTC") {
  const s = new Date((epoch + offsetHours * 3600) * 1000).toISOString().replace("T", " ").slice(0, 16);
  return `${s} ${label}`;
}

// Trading session for a candle, by its UTC open hour. Recorded on every event
// so it can later be tested for whether it matters — not because it's assumed to.
export function sessionOf(epoch) {
  const h = new Date(epoch * 1000).getUTCHours();
  if (h >= 7 && h < 12) return "London";
  if (h >= 12 && h < 16) return "London/NY overlap";
  if (h >= 16 && h < 21) return "New York";
  if (h >= 2 && h < 7) return "Asian";
  return "Asian (early)"; // 21:00-02:00 UTC
}

// Next 4H boundary (epoch) for buckets aligned to `offsetHours` from UTC.
export function nextBoundary(offsetHours = 0) {
  const now = Math.floor(Date.now() / 1000);
  const off = ((((offsetHours % 4) + 4) % 4)) * 3600;
  return Math.ceil((now - off) / 14400) * 14400 + off;
}

// Fetch 4H candles aligned to `offsetHours` from UTC.
//   • offset a multiple of 4h (incl. 0) → native Deriv 4H candles (UTC boundaries, deeper history)
//   • otherwise → fetch 1H candles and aggregate into shifted 4H buckets
export async function fetchAligned4H(sym, want = 6, offsetHours = 0) {
  const offSec = ((((offsetHours % 4) + 4) % 4)) * 3600;
  if (offSec === 0) return fetchCandles(sym, want, 14400);

  const h1 = await fetchCandles(sym, Math.min(want * 4 + 8, 1000), 3600);
  const buckets = new Map();
  for (const c of h1) {
    const bs = Math.floor((c.t - offSec) / 14400) * 14400 + offSec;
    let b = buckets.get(bs);
    if (!b) { b = { t: bs, open: c.open, high: c.high, low: c.low, close: c.close }; buckets.set(bs, b); }
    else { b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}
