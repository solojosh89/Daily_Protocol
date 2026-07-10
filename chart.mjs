// ─────────────────────────────────────────────────────────────────────────
// OTE CHART SNAPSHOT — renders a 1H candlestick picture of an OTE setup
// (swing/sweep/displacement structure + shaded entry zone + stop/target
// lines) and returns a PNG URL that Telegram sendPhoto can use directly.
//
// Rendering is done by QuickChart.io (free chart API, Chart.js v3 +
// chartjs-chart-financial). Deliberate trade-off: the server has no drawing
// library and this keeps us dependency-free. If QuickChart is ever down the
// caller falls back to the TEXT alert — the image is a bonus, never the
// thing the alert depends on.
//
// NOTE: detection runs on 4H (the validated timeframe). The chart is drawn
// in 1H purely so the formation is visible in detail.
// ─────────────────────────────────────────────────────────────────────────
import { fmt, dec } from "./detector.mjs";

// How many 1H candles the picture needs: from a little before the sweep
// (context) to now, clamped to a readable range.
export function chartCandleCount(ote) {
  const hoursSinceSweep = Math.ceil((Date.now() / 1000 - ote.sweepT) / 3600);
  return Math.min(Math.max(hoursSinceSweep + 48, 60), 240);
}

// Build the chart and return a hosted PNG URL, or null on any failure.
export async function renderOTEChart(inst, o, candles1h) {
  try {
    if (!candles1h || candles1h.length < 10) return null;
    const d = Math.max(dec(o.stop), dec(o.target));
    const data = candles1h.map((b) => ({ x: b.t * 1000, o: b.open, h: b.high, l: b.low, c: b.close }));
    const zoneLo = Math.min(o.entryNear, o.entryFar);
    const zoneHi = Math.max(o.entryNear, o.entryFar);

    const config = {
      type: "candlestick",
      data: {
        datasets: [{
          label: inst.short,
          data,
          color: { up: "#26a69a", down: "#ef5350", unchanged: "#999" },
          borderColor: { up: "#26a69a", down: "#ef5350", unchanged: "#999" },
        }],
      },
      options: {
        plugins: {
          legend: { display: false },
          title: { display: true, text: o.title || `${inst.short} 1H — OTE ${o.dir} (detected on 4H) · disp ${o.dispX.toFixed(1)}x` },
          annotation: {
            annotations: {
              zone: {
                type: "box", yMin: zoneLo, yMax: zoneHi,
                backgroundColor: "rgba(255,193,7,0.22)", borderColor: "rgba(255,160,0,0.9)", borderWidth: 1,
                label: { enabled: true, display: true, content: "OTE zone", position: { x: "start", y: "center" }, color: "#7a5c00", backgroundColor: "rgba(255,255,255,0.7)", font: { size: 11 } },
              },
              stop: {
                type: "line", yMin: o.stop, yMax: o.stop,
                borderColor: "#e53935", borderWidth: 2, borderDash: [6, 4],
                label: { enabled: true, display: true, content: `stop ${fmt(o.stop, d)}`, position: "end", backgroundColor: "#e53935", color: "#fff", font: { size: 11 } },
              },
              target: {
                type: "line", yMin: o.target, yMax: o.target,
                borderColor: "#2e7d32", borderWidth: 2, borderDash: [6, 4],
                label: { enabled: true, display: true, content: `target ${fmt(o.target, d)}`, position: "end", backgroundColor: "#2e7d32", color: "#fff", font: { size: 11 } },
              },
              sweep: {
                type: "point", xValue: o.sweepT * 1000, yValue: o.stop, // the swept level IS the stop
                backgroundColor: "rgba(229,57,53,0.9)", radius: 5,
                label: { enabled: true, display: true, content: "sweep", position: "bottom", font: { size: 10 } },
              },
              // FVG confluence box (only when a gap overlaps the entry zone):
              // the fine-tuned entry inside the zone — tapped 82% of the time.
              ...(o.fvg ? {
                fvg: {
                  type: "box", yMin: o.fvg.bot, yMax: o.fvg.top,
                  backgroundColor: "rgba(156,39,176,0.20)", borderColor: "rgba(123,31,162,0.9)", borderWidth: 1,
                  label: { enabled: true, display: true, content: "FVG", position: { x: "end", y: "center" }, color: "#4a148c", backgroundColor: "rgba(255,255,255,0.7)", font: { size: 11 } },
                },
              } : {}),
            },
          },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8, color: "#555" }, grid: { display: false } },
          y: { position: "right", ticks: { color: "#555" } },
        },
      },
    };

    const r = await fetch("https://quickchart.io/chart/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "3", width: 900, height: 520, backgroundColor: "#ffffff", format: "png", chart: config }),
    });
    const j = await r.json();
    return j && j.success && j.url ? j.url : null;
  } catch {
    return null;
  }
}

// 15m SOL-check chart: 15m candles with the swept 4H level drawn (the user's
// blue "SOL" line), the opposite level dashed for context, and a marker on
// the breaching bar. Same QuickChart pipeline and same fallback contract.
export async function renderSweep15Chart(inst, s, prev) {
  try {
    if (!s.c15win || s.c15win.length < 10) return null;
    const data = s.c15win.map((b) => ({ x: b.t * 1000, o: b.open, h: b.high, l: b.low, c: b.close }));
    const d = dec(s.level);
    const opposite = s.side === "high" ? prev.low : prev.high;
    const config = {
      type: "candlestick",
      data: {
        datasets: [{
          label: inst.short, data,
          color: { up: "#26a69a", down: "#ef5350", unchanged: "#999" },
          borderColor: { up: "#26a69a", down: "#ef5350", unchanged: "#999" },
        }],
      },
      options: {
        plugins: {
          legend: { display: false },
          title: { display: true, text: `${inst.short} 15m — first ${s.side.toUpperCase()} of prior 4H taken` },
          annotation: {
            annotations: {
              sol: {
                type: "line", yMin: s.level, yMax: s.level,
                borderColor: "#2962ff", borderWidth: 2,
                label: { enabled: true, display: true, content: `SOL ${fmt(s.level, d)}`, position: "start", backgroundColor: "#2962ff", color: "#fff", font: { size: 11 } },
              },
              opp: {
                type: "line", yMin: opposite, yMax: opposite,
                borderColor: "#9e9e9e", borderWidth: 1, borderDash: [4, 4],
                label: { enabled: true, display: true, content: `opposite ${fmt(opposite, d)}`, position: "start", backgroundColor: "#9e9e9e", color: "#fff", font: { size: 10 } },
              },
              breach: {
                type: "point", xValue: s.breachT * 1000, yValue: s.level,
                backgroundColor: "rgba(41,98,255,0.9)", radius: 5,
              },
            },
          },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8, color: "#555" }, grid: { display: false } },
          y: { position: "right", ticks: { color: "#555" } },
        },
      },
    };
    const r = await fetch("https://quickchart.io/chart/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "3", width: 900, height: 520, backgroundColor: "#ffffff", format: "png", chart: config }),
    });
    const j = await r.json();
    return j && j.success && j.url ? j.url : null;
  } catch { return null; }
}

// 4H context chart for the sweep alerts: ~56 4H candles with the prior
// candle's swept level solid blue (the SOL) and the opposite level dashed.
// Gives the "zoomed out" structure view next to the 15m detail shot.
export async function render4HContext(inst, candles4h, prev, side, both = false) {
  try {
    const c = (candles4h || []).slice(-56);
    if (c.length < 10) return null;
    const level = side === "high" ? prev.high : prev.low;
    const opposite = side === "high" ? prev.low : prev.high;
    const d = dec(level);
    const oppStyle = both
      ? { borderColor: "#2962ff", borderWidth: 2, dash: undefined, label: `swept ${fmt(opposite, d)}`, bg: "#2962ff" }
      : { borderColor: "#9e9e9e", borderWidth: 1, dash: [4, 4], label: `opposite ${fmt(opposite, d)}`, bg: "#9e9e9e" };
    const config = {
      type: "candlestick",
      data: {
        datasets: [{
          label: inst.short,
          data: c.map((b) => ({ x: b.t * 1000, o: b.open, h: b.high, l: b.low, c: b.close })),
          color: { up: "#26a69a", down: "#ef5350", unchanged: "#999" },
          borderColor: { up: "#26a69a", down: "#ef5350", unchanged: "#999" },
        }],
      },
      options: {
        plugins: {
          legend: { display: false },
          title: { display: true, text: `${inst.short} 4H — structure context (${both ? "BOTH sides of prior candle taken" : side.toUpperCase() + " of prior candle taken"})` },
          annotation: {
            annotations: {
              sol: {
                type: "line", yMin: level, yMax: level,
                borderColor: "#2962ff", borderWidth: 2,
                label: { enabled: true, display: true, content: `${both ? "swept" : "SOL"} ${fmt(level, d)}`, position: "start", backgroundColor: "#2962ff", color: "#fff", font: { size: 11 } },
              },
              opp: {
                type: "line", yMin: opposite, yMax: opposite,
                borderColor: oppStyle.borderColor, borderWidth: oppStyle.borderWidth, ...(oppStyle.dash ? { borderDash: oppStyle.dash } : {}),
                label: { enabled: true, display: true, content: oppStyle.label, position: "start", backgroundColor: oppStyle.bg, color: "#fff", font: { size: 10 } },
              },
            },
          },
        },
        scales: {
          x: { ticks: { maxTicksLimit: 8, color: "#555" }, grid: { display: false } },
          y: { position: "right", ticks: { color: "#555" } },
        },
      },
    };
    const r = await fetch("https://quickchart.io/chart/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: "3", width: 900, height: 520, backgroundColor: "#ffffff", format: "png", chart: config }),
    });
    const j = await r.json();
    return j && j.success && j.url ? j.url : null;
  } catch { return null; }
}

// Send several photos as ONE Telegram album; the caption rides on the first.
export async function tgSendAlbum(token, chatId, photoUrls, caption) {
  const media = photoUrls.map((u, i) => ({ type: "photo", media: u, ...(i === 0 ? { caption, parse_mode: "HTML" } : {}) }));
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, media }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error("Telegram sendMediaGroup failed: " + (j.description || r.status));
}

// Send a photo (by URL) to a Telegram chat with an HTML caption.
export async function tgSendPhoto(token, chatId, photoUrl, caption) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, parse_mode: "HTML" }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error("Telegram sendPhoto failed: " + (j.description || r.status));
}
