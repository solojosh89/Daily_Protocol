// ─────────────────────────────────────────────────────────────────────────
// POLYMARKET MISPRICING SCAN
//
// One question: is there money sitting on the table right now that needs no
// opinion about the world?
//
// On a single binary market there never is. YES and NO share one order book,
// so buying both always costs 1.00 plus the spread. That arbitrage only
// exists between two separate venues, not here.
//
// Where it CAN exist is a multi-outcome event where exactly one outcome can
// win (Polymarket flags these as negRisk). Two free lunches are possible:
//
//   sum of best ASKS  < 1.00    buy every outcome. One pays 1.00. Profit.
//   sum of best BIDS  > 1.00    sell every outcome. One costs 1.00. Profit.
//
// Anything flagged is then checked against the real order book, because a
// two cent edge on nine dollars of size is not a business. The scan reports
// executable size, not headline edge.
//
//   node poly-arb.mjs              scan once
//   WATCH=6 node poly-arb.mjs      scan 6 times, 60s apart, report persistence
// ─────────────────────────────────────────────────────────────────────────
import { writeFileSync } from "fs";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const MIN_EDGE = 0.005;          // half a cent per dollar, before we even look
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(u, opts) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(u, opts);
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await sleep(500 * (a + 1));
  }
  return null;
}

// every open event that is genuinely one-winner-only
async function loadEvents() {
  const out = [];
  for (let offset = 0; offset < 3000; offset += 100) {
    const page = await getJson(`${GAMMA}/events?closed=false&active=true&limit=100&offset=${offset}&order=volume24hr&ascending=false`);
    if (!page || !page.length) break;
    for (const e of page) {
      if (!(e.negRisk || e.enableNegRisk)) continue;          // must be mutually exclusive
      const ms = (e.markets || []).filter((m) => m.enableOrderBook && m.acceptingOrders && !m.closed);
      if (ms.length < 2) continue;
      out.push({ id: e.id, title: e.title, slug: e.slug, endDate: e.endDate, volume24hr: +e.volume24hr || 0, markets: ms });
    }
    if (page.length < 100) break;
  }
  return out;
}

const tokens = (m) => { try { return JSON.parse(m.clobTokenIds); } catch { return []; } };

// walk a real book: how many dollars can actually be bought below `limit`
function fillable(levels, limit, side) {
  let cost = 0, shares = 0;
  const sorted = [...levels].sort((a, b) => (side === "ask" ? +a.price - +b.price : +b.price - +a.price));
  for (const l of sorted) {
    const p = +l.price, sz = +l.size;
    if (side === "ask" ? p > limit : p < limit) break;
    cost += p * sz; shares += sz;
  }
  return { cost, shares };
}

async function scan() {
  const events = await loadEvents();
  const flagged = [];
  for (const e of events) {
    let sumAsk = 0, sumBid = 0, fee = 0, ok = true;
    for (const m of e.markets) {
      const ask = m.bestAsk == null ? null : +m.bestAsk;
      const bid = m.bestBid == null ? null : +m.bestBid;
      if (ask == null || bid == null || !(ask > 0) || !(bid >= 0)) { ok = false; break; }
      sumAsk += ask; sumBid += bid;
      // Polymarket's real fee, which is NOT the takerBaseFee field (that reads
      // 1000 on every market, including the ones labelled zero_fees). It lives
      // in feeSchedule: rate * min(p, 1-p)^exponent per share, takers only.
      let sch = m.feeSchedule;
      if (typeof sch === "string") { try { sch = JSON.parse(sch); } catch { sch = null; } }
      if (m.feesEnabled && sch && sch.rate) fee += sch.rate * Math.pow(Math.min(ask, 1 - ask), sch.exponent ?? 1);
    }
    if (!ok) continue;
    // Mutually exclusive is not the same as exhaustive. If none of the listed
    // outcomes can win, buying all of them guarantees nothing, and a big
    // "edge" is just the market pricing that. The tell is the mid prices: in
    // a genuinely exhaustive market they add up to about 1.00.
    const sumMid = (sumAsk + sumBid) / 2;
    const exhaustive = sumMid > 0.97 && sumMid < 1.06;
    const buyAllEdge = 1 - sumAsk;          // >0 means buying every outcome locks a profit
    const sellAllEdge = sumBid - 1;         // >0 means selling every outcome locks a profit
    const gross = Math.max(buyAllEdge, sellAllEdge);
    if (gross > MIN_EDGE)
      flagged.push({ ...e, sumAsk, sumBid, sumMid, exhaustive, buyAllEdge, sellAllEdge, gross, fee, net: gross - fee, n: e.markets.length });
  }
  return { events, flagged };
}

// confirm a flagged event against the live order books, with real depth
async function confirm(ev) {
  const side = ev.buyAllEdge > ev.sellAllEdge ? "buy" : "sell";
  const rows = [];
  for (const m of ev.markets) {
    const [yes] = tokens(m);
    if (!yes) return null;
    const book = await getJson(`${CLOB}/book?token_id=${yes}`);
    if (!book) return null;
    rows.push({ q: m.groupItemTitle || m.question, asks: book.asks || [], bids: book.bids || [] });
    await sleep(120);
  }
  // how much can be executed while the whole basket still locks a profit
  let worstSize = Infinity, cost = 0;
  for (const r of rows) {
    const lv = side === "buy" ? r.asks : r.bids;
    if (!lv.length) return null;
    const best = side === "buy" ? Math.min(...lv.map((l) => +l.price)) : Math.max(...lv.map((l) => +l.price));
    const f = fillable(lv, best, side === "buy" ? "ask" : "bid");
    worstSize = Math.min(worstSize, f.shares);
    cost += best;
  }
  const edge = side === "buy" ? 1 - cost : cost - 1;
  return { side, edge, shares: worstSize, dollars: worstSize * (side === "buy" ? cost : 1), rows: rows.length };
}

const runs = +(process.env.WATCH || 1);
const history = [];
for (let i = 0; i < runs; i++) {
  const t0 = Date.now();
  const { events, flagged } = await scan();
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`\n[${stamp}] scanned ${events.length} one-winner events, ${events.reduce((s, e) => s + e.markets.length, 0)} outcomes. ${flagged.length} showed a headline edge over ${(MIN_EDGE * 100).toFixed(1)}c.`);

  const real = flagged.filter((f) => f.exhaustive);
  const notExhaustive = flagged.filter((f) => !f.exhaustive);
  const survives = real.filter((f) => f.net > 0);
  console.log(`  ${notExhaustive.length} are NOT exhaustive markets, so their "edge" is not free money. Biggest: ${notExhaustive.sort((a, b) => b.buyAllEdge - a.buyAllEdge).slice(0, 2).map((f) => `${f.title.slice(0, 32)} (prices add to ${f.sumMid.toFixed(2)})`).join("; ") || "none"}`);
  console.log(`  ${real.length} are genuine one-winner markets with a gap. ${survives.length} of those are bigger than the taker fee needed to take them.`);
  const confirmed = [];
  for (const f of (survives.length ? survives : real).slice(0, 14)) {
    const c = await confirm(f);
    const days = Math.max(0.2, (Date.parse(f.endDate) - Date.now()) / 86400000);
    if (!c) { console.log(`  ${f.title.slice(0, 50).padEnd(52)} book unavailable`); continue; }
    const net = c.edge - f.fee;
    const perYear = net > 0 ? (Math.pow(1 + net, 365 / days) - 1) * 100 : 0;
    confirmed.push({ title: f.title, slug: f.slug, n: f.n, days, perYear, fee: f.fee, net, ...c, headline: f.gross });
    console.log(`  ${f.title.slice(0, 46).padEnd(48)} ${String(f.n).padStart(3)} out  book ${(c.edge * 100).toFixed(1)}c  fee ${(f.fee * 100).toFixed(1)}c  NET ${((net) * 100).toFixed(1)}c  $${c.dollars.toFixed(0).padStart(5)}  ${days.toFixed(0).padStart(3)}d  ${perYear > 0 ? perYear.toFixed(0) + "%/yr" : "dead"}`);
  }
  history.push({ at: new Date().toISOString(), events: events.length, flagged: flagged.length, confirmed });
  if (i < runs - 1) await sleep(Math.max(0, 60000 - (Date.now() - t0)));
}

// what survived across repeated scans
if (runs > 1) {
  const counts = new Map();
  for (const h of history) for (const c of h.confirmed) counts.set(c.title, (counts.get(c.title) || 0) + 1);
  console.log(`\nPersistence across ${runs} scans a minute apart:`);
  for (const [title, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
    console.log(`  ${String(n).padStart(2)}/${runs}  ${title.slice(0, 70)}`);
}

writeFileSync(process.env.OUT || "poly.json", JSON.stringify({ built: new Date().toISOString(), runs, history }, null, 1));
console.log(`\nheadline = edge from the quoted best prices. real = edge after reading the actual order book.`);
console.log(`size = dollars you could execute before the edge is gone. That number, not the headline, is the business.`);
console.log(`\nwrote ${process.env.OUT || "poly.json"}`);
