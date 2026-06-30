// ─────────────────────────────────────────────────────────────────────────
// TRADINGVIEW DATA FEED (public, no login)
//
// Speaks TradingView's own chart WebSocket protocol — the same one their
// charts use — so candles match EXACTLY what you see on tradingview.com.
// Used for instruments where the Deriv feed was found to diverge materially
// (see README "Feed accuracy" section).
// ─────────────────────────────────────────────────────────────────────────

const TV_WS = "wss://data.tradingview.com/socket.io/websocket?from=&date=";

function genSession(prefix) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return prefix + s;
}
function packMsg(m) {
  const s = JSON.stringify(m);
  return `~m~${s.length}~m~${s}`;
}

// granularitySeconds → TradingView resolution string ("240" = 4h, "15" = 15m).
function toResolution(granularitySeconds) {
  const mins = Math.round(granularitySeconds / 60);
  return String(mins);
}

// Fetch `count` candles for a TradingView symbol like "OANDA:NAS100USD".
// Returns the same shape as deriv.mjs's fetchCandles: { t, open, high, low, close }.
export function fetchTVCandles(tvSymbol, count = 200, granularitySeconds = 14400) {
  const resolution = toResolution(granularitySeconds);
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(TV_WS, { headers: { Origin: "https://www.tradingview.com" } }); }
    catch (e) { return reject(e); }

    const chartSession = genSession("cs_");
    const quoteSession = genSession("qs_");
    let bars = [];
    let done = false;
    const timer = setTimeout(() => { if (done) return; done = true; try { ws.close(); } catch {} reject(new Error(`TV timeout for ${tvSymbol}`)); }, 20000);

    const send = (m) => { try { ws.send(packMsg(m)); } catch {} };

    ws.onopen = () => {
      send({ m: "set_auth_token", p: ["unauthorized_user_token"] });
      send({ m: "chart_create_session", p: [chartSession, ""] });
      send({ m: "quote_create_session", p: [quoteSession] });
      send({ m: "resolve_symbol", p: [chartSession, "sds_sym_1", `={"symbol":"${tvSymbol}","adjustment":"splits"}`] });
      send({ m: "create_series", p: [chartSession, "sds_1", "s1", "sds_sym_1", resolution, count] });
    };

    ws.onmessage = (ev) => {
      if (done) return;
      const parts = String(ev.data).split(/~m~\d+~m~/).filter(Boolean);
      for (const part of parts) {
        if (part.startsWith("~h~")) continue; // heartbeat, no ack required for one-shot fetch
        let msg;
        try { msg = JSON.parse(part); } catch { continue; }

        if (msg.m === "timescale_update" || msg.m === "du") {
          const sds = msg.p && msg.p[1] && msg.p[1].sds_1;
          if (sds && sds.s) {
            bars = sds.s.map((x) => ({ t: x.v[0], open: x.v[1], high: x.v[2], low: x.v[3], close: x.v[4] }));
          }
        }
        if (msg.m === "series_completed") {
          done = true; clearTimeout(timer); try { ws.close(); } catch {}
          bars.sort((a, b) => a.t - b.t);
          resolve(bars);
          return;
        }
        if (msg.m === "critical_error" || msg.m === "protocol_error" || msg.m === "symbol_error") {
          done = true; clearTimeout(timer); try { ws.close(); } catch {}
          reject(new Error(`TV error for ${tvSymbol}: ${JSON.stringify(msg.p)}`));
          return;
        }
      }
    };
    ws.onerror = () => { if (done) return; done = true; clearTimeout(timer); reject(new Error(`TV websocket error for ${tvSymbol}`)); };
  });
}
