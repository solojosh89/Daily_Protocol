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
export const INSTRUMENTS = [
  // real markets — sweeps here reflect genuine liquidity
  { key: "XAUUSD", sym: "frxXAUUSD", label: "Gold", dataSrc: "deriv" },
  { key: "NAS100", sym: "OTC_NDX", tvSym: "OANDA:NAS100USD", label: "Nasdaq", dataSrc: "tv" },
  { key: "EURUSD", sym: "frxEURUSD", label: "EUR/USD", dataSrc: "deriv" },
  { key: "GBPJPY", sym: "frxGBPJPY", label: "GBP/JPY", dataSrc: "deriv" },
  // synthetic indices — random walks; pattern fires but carries no real meaning
  { key: "V25", sym: "R_25", label: "Volatility 25", dataSrc: "deriv" },
  { key: "V50", sym: "R_50", label: "Volatility 50", dataSrc: "deriv" },
  { key: "V75", sym: "R_75", label: "Volatility 75", dataSrc: "deriv" },
  { key: "V25S", sym: "1HZ25V", label: "Volatility 25 (1s)", dataSrc: "deriv" },
  { key: "V75S", sym: "1HZ75V", label: "Volatility 75 (1s)", dataSrc: "deriv" },
];

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
