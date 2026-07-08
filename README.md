# 4H Sweep Monitor

Watches the 4-hour candle on real markets (Gold, Nasdaq, EUR/USD, GBP/JPY) **and**
Deriv synthetics (V25/V50/V75/V25s/V75s), and pings your phone via Telegram the
instant a candle **sweeps BOTH sides of the previous candle** (takes its high *and*
its low) and closes directionally — the double-sided liquidity purge.

It only **detects and notifies**. The chart read (structure to the left, etc.) is yours.

- **Required:** the candle's high > prior high **and** its low < prior low — both liquidity pools taken (an outside bar). One-sided sweeps are ignored.
- **🟢 BULLISH** — closed **up** (bullish body) → the **low** sweep was the manipulation, intent is up.
- **🔴 BEARISH** — closed **down** (bearish body) → the **high** sweep was the manipulation, intent is down.
- **⭐ STRONG** — the close cleared the previous candle's **open** (engulfing), the body is ≥50% of the range (your "huge body close"), **and** the sweeping candle's body is *bigger* than the former candle's body (the second move shows more conviction than the first). Flagged so you look at them first.

> OHLC alone can't prove which wick formed first inside the candle, so the close direction is the standard proxy for which side was the manipulation.

Real candle data comes free, no API key, no dependencies — Gold and GBP/JPY from
Deriv's WebSocket, Nasdaq directly from TradingView's own feed (see "Feed accuracy" below).

---

## 1. One-time Telegram setup (~2 min)

1. In Telegram, open a chat with **@BotFather** → send `/newbot` → follow prompts.
   It gives you a **token** like `8123456789:AAH...`.
2. Copy the config and paste your token:
   ```
   copy config.example.json config.json
   ```
   Open `config.json` and put the token in `telegram.token`.
3. **Send your new bot any message** (e.g. "hi") in Telegram so it's allowed to DM you.
4. Run setup — it finds your chat id, saves it, and sends a test message:
   ```
   node monitor.mjs --setup
   ```
   You should get "✅ Sweep monitor connected" on your phone.

> No Telegram yet? The monitor still runs and prints alerts to the console (DRY mode).

---

## 1b. Optional: also get alerts on WhatsApp (~10 min, one-time)

Uses Meta's official, free WhatsApp Cloud API — no third-party service, no cost. Runs
**alongside** Telegram (both fire on every alert), not instead of it.

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App** →
   choose type **Business** → give it any name.
2. In the app dashboard, add the **WhatsApp** product (Add Product → WhatsApp → Set up).
3. On the **API Setup** page you'll see:
   - A **temporary access token** (valid 24h — fine to start; for a permanent one, create a
     System User under Business Settings → System Users, generate a token with `whatsapp_business_messaging` permission).
   - A **Phone number ID** (Meta gives you a free test sender number).
4. Under **To**, add your own WhatsApp number as a test recipient (Meta sends you a verification code).
5. Copy the token and Phone number ID into `config.json`:
   ```json
   "whatsapp": {
     "token": "paste the access token",
     "phoneNumberId": "paste the phone number id",
     "toNumber": "234801XXXXXXX",   // your number, digits only, no + or leading 0
     "enabled": true
   }
   ```
6. **Send the bot's WhatsApp number a message first** (e.g. "hi") — required once to open the messaging window.
7. Run:
   ```
   node monitor.mjs --setup-whatsapp
   ```
   You should get a test message on WhatsApp.

### The one real limitation — read this
WhatsApp only allows free-form messages within a **24-hour window** that opens when you message
the bot's number. If you go quiet for 24h+, alerts stop landing on WhatsApp until you message it
again (Telegram is unaffected — it has no such window). **Practical fix: message the bot "hi" once
a day** (e.g. first thing when you check your phone). When the window is closed, the console logs
`whatsapp: 24h window closed — message the bot's WhatsApp number to re-open it` instead of failing silently.

Set `"enabled": false` under `whatsapp` to turn it off without deleting your credentials.

---

## 2. Run it

```
node monitor.mjs
```
…or double-click **`start.bat`** (auto-restarts if it ever drops). Leave it running.
You'll get a "monitor live" message, then an alert each time a 4H candle closes as a sweep.

Test / research commands:
- `node monitor.mjs --once` — evaluate the most recent/forming candle right now and exit.
- `node scan.mjs 30` — list every 4H double-sweep in the last ~30 days to verify against your chart.
- `node review.mjs XAUUSD 5` — last 5 setups on an instrument **with their 15m entry (SOL) times**.
- `node stats.mjs` — query the accumulated event log: sweeps and protocol-valid rate **by session and by H4 candle**.

### Progressive phases + the event log (your research assistant)
Every notification is tagged with the **phase** of the H4 lifecycle it represents, plus the
**session** and **which H4 candle** it is:
- 🟠 **Phase 2 · first sweep** — a side was taken (manipulation candidate).
- 🔵 **Phase 3 · status** — one factual progress snapshot while waiting for the opposite side (see below).
- 🟢 **Phase 4 · second sweep** — both sides swept, closing (the FORMING heads-up).
- 🔵 **Phase 5 · H4 closed · protocol VALID** — confirmed at close (or 🔴 **INVALID** if it fizzled). This carries the richest payload: a **📋 Candle B summary** (number of sweeps, first side, largest/major sweep, body & range vs A), a **🎬 Narrative** (a timestamped chronological replay of every sweep in Candle B — the true measured order, e.g. `21:00 swept HIGH 2.7 / 21:15 swept LOW 7.3 / … / 00:45 swept LOW 62.9 ← largest / 01:00 closed BEARISH`), and the **▶ Execution — Candle C** block: the candle just closed is your **bias** candle (B); the *next* candle (C) is execution. It gives the high-attention window — the **first 75 min of Candle C** — to watch M15/H1 for a sweep/displacement entry. Data-backed: ~66% of the best entries land in that window (vs ~53% random), so it's a *priority* window, not a wall (`executionWindowMin`).

Every one of those events is also appended to **`events.jsonl`** with its full measurements,
session, and H4-candle time. That file is the database the bot builds for you 24/7 — run
`node stats.mjs` any time to see which sessions and which H4 candles actually produce your
setups. After a few months it can tell you things like "only the London and overlap candles
are worth trading" — from *your* logged data, not assumption.

### Timing — heads-up 15 min before the close
4H candles close every **4 hours** (00/04/08/12/16/20 in your chart's clock). The monitor:
1. **⏳ FORMING** — ~15 min before the close (configurable via `alertLeadMinutes`), if the
   still-forming candle has already swept both sides and is closing directionally, it pings you
   so you can **get to the chart and watch it close.** This is *provisional* — the last 15 min can change it.
2. **✅ CONFIRMED / ⚠️ FIZZLED** — at the actual close it tells you whether the sweep held
   (`confirmAtClose`, on by default).

Set `"alertLeadMinutes": 0` if you only want the confirmed alert at close.

### Stage 2 — first-sweep heads-up (mid-candle)
Before the double-sweep completes, the monitor pings you the instant the forming H4
candle **first takes the prior high or low** — the "manipulation candidate" moment — with a
structured snapshot:

```
🔔 Gold — H4 first sweep (manipulation candidate)
LOW taken @ 01:00 NY  ·  sweep at 0% of the H4
Distance: 5.41 (1% of prior candle)
So far — body 74% · upper wick 25% · lower wick 1% · close 1% · red
Watch opposite side — high 3999.62 — for the setup to complete
📊 only ~21% of sweeps this early complete the opposite side before close
```

It also carries **relative geometry** — Candle B (the forming candle) measured against Candle A
(the prior candle) as the reference stick, all as % of A's range, no opinion:
- **Coverage of A** — how much of A's territory B has explored (capped at 100%).
- **Extension beyond A** — how far past A's high/low the sweep pushed (aggression), kept separate from coverage.
- **B range vs A** — B's volatility relative to A (can exceed 100%).
- **Body / price position** — body as % of A, and where price sits within A (0=low, 100=high).
- **Body vs A (body-relative)** — **dominance** (B's body vs A's body; >100% = B overpowers A), **% of A's body reclaimed** (how much of A's body B has traded through), and B's close vs A's body close. This is the "1st/2nd H4 body close" read, measured.
- **Remaining to opposite liquidity** — how far price still has to travel to take the other side, in points and % of A.

**Progress engine** — it also answers *how far has B got, versus how much time it's used*:
- **Time used** vs **price covered** (B's range as % of A) and their ratio, **efficiency** — >100% means B is unfolding faster than the clock, <100% means it's spent its life doing little.

**Phase 3 · status** is a single factual snapshot fired once the candle passes `statusUpdatePct`
(default 50% = the 2-hour mark) *if* one side is swept but not both — so you know, without opening
the chart: time used, price covered, efficiency, coverage of A, and distance still to the opposite
side. It's pure facts, no prediction (`statusUpdateEnabled` to toggle).

Honest by design: the first-sweep alert carries the **real base rate** (from `conditional-gap.mjs`,
624 candles) that the opposite side completes before close — which is low. It's a *state* notification, not
a trade signal. To keep it from spamming, it only fires for a **fresh** breach and only while
the candle is within `firstSweepMaxElapsedPct` (default 50%) — past halfway, completion odds
fall to ~7% then ~2%, so it goes quiet. Set `"firstSweepAlert": false` to turn it off entirely.

### 15m entry plan (the SOL finder)
The 4H sweep gives you **bias**; your entry is a **15m Sweep Of Liquidity (SOL)**. Each alert
now includes that automatically:
- the **former** and **sweeping** 4H candle times, mapped to your clock,
- the **former-candle level** to hunt (its high for bearish bias, its low for bullish), and
- the **exact 15m time** a SOL took that level and closed back the other way — your entry trigger.

It scans 15m from ~1h before the sweeping candle opens to ~1h after it closes (`ltfBufferHours`).
Use `node review.mjs <INSTRUMENT> <n>` to see this for past setups and study what followed.

This points you to the right candle at the right time — the continuation-vs-reversal read on the
15m structure is still yours (your "full body = conviction" rule; the alert shows the body %).

### Keep it running 24/7
Pick one:
- **Continuous (recommended):** leave `start.bat` open in a window — it auto-restarts if it drops.
- **Task Scheduler, always-on:** Create Task → Trigger "At log on" → Action: Program `node`,
  Arguments `monitor.mjs`, Start in `C:\Users\hp\Documents\sweep-monitor`.
- **Scheduled per-candle (no process kept open):** Task Scheduler → trigger **Daily, repeat every
  4 hours** starting **00:05 UTC** → Action `node` with Arguments `monitor.mjs --once`. It fetches,
  confirms the just-closed candle, alerts if it's a sweep, and exits.

---

## 3. Tune the noise (`config.json`)

**Burst digest (automatic):** because all instruments share the 4H grid, first-sweep (Phase 2)
and status (Phase 3) alerts would otherwise fire for every pair at once. When more than one fires
in the same cycle they're consolidated into a **single digest message**, sorted by closeness to
completing the double-sweep (`toOpp` ascending) — so the ones about to become setups are at the
top. If only one pair fires, you get its full detailed message instead.

To cut volume further:

| Setting | Effect |
|---|---|
| `"alertLevel": "strong"` | Only the ⭐ huge-body engulfing sweeps (your best setups). |
| `"minBodyPct": 0.5` | Only sweeps whose body fills ≥50% of the candle. |
| `"instruments": ["XAUUSD","NAS100","EURUSD","GBPJPY"]` | Real markets only — drop the synthetics. |
| `"alertLeadMinutes": 15` | Minutes before the close for the provisional heads-up (`0` = only alert at close). |
| `"confirmAtClose": true` | Also send a confirmed/fizzled note when the candle actually closes. |
| `"ltfEnabled": true` | Add the 15m entry plan (former/sweep times + SOL) to each alert. |
| `"ltfBufferHours": 1` | How far before/after the sweeping candle to scan 15m for the SOL. |
| `"pollSeconds": 60` | How often it checks (catches the lead window and the close within ~1 min). |

Instrument keys: `XAUUSD, NAS100, EURUSD, GBPJPY, V25, V50, V75, V25S, V75S`.

### Match your chart's timezone & candle alignment
So the alert points at the **same candle you see**:

| Setting | Meaning |
|---|---|
| `"displayTzOffset": -4` | Show alert times in your clock. New York = `-4`. Just relabels times; doesn't move candles. |
| `"displayTzLabel": "NY"` | The text tag shown after times. |
| `"bucketOffsetHours": 1` | Where the 4H candle boundaries fall, for Deriv-sourced instruments. **Confirmed correct** — see "Feed accuracy" below. |

---

## Feed accuracy — verified directly against TradingView

Rather than asking you to eyeball it, the candle alignment and prices were checked
**programmatically against TradingView's own data feed** (the same one your charts render,
via its public WebSocket — no login needed). Findings:

| Instrument | Source | Check | Result |
|---|---|---|---|
| **Gold** | Deriv `frxXAUUSD` | vs `OANDA:XAUUSD` | Matches within noise (cents). 4H candles open at **01/05/09/13/17/21 NY**, not 00/04/08/12/16/20 — fixed via `bucketOffsetHours: 1`. |
| **GBP/JPY** | Deriv `frxGBPJPY` | vs `OANDA:GBPJPY` | Matches within a fraction of a pip. Same `bucketOffsetHours: 1` grid. |
| **Nasdaq** | **`IG:NASDAQ`** (TradingView) | vs the user's actual IG "US Tech 100 Cash" chart | Went through two corrections: (1) Deriv's `OTC_NDX` diverged ~$80/candle from any real broker → moved to TradingView. (2) The generic `OANDA`/`FOREXCOM` Nasdaq feeds *also* differed enough from the user's real broker (IG) to miss a real double-sweep. Found IG's exact ticker via TradingView's symbol-search API (it's `NASDAQ`, not `NAS100`/`US100`) and verified **to the decimal** against the user's own chart. IG's 4H candles open on their own grid (03/07/11/15/19/23 NY) — different from every other broker checked; since it's TradingView-sourced, no manual offset is needed. |

This is why `dataSrc` is set per-instrument in `deriv.mjs`'s `INSTRUMENTS` list — `"deriv"` for
Gold/GBPJPY (validated match), `"tv"` for Nasdaq (switched after the mismatch was found). The
9-row table earlier omits this detail since it's about noise tuning, not sourcing.

> If your TradingView is on a different broker than OANDA for any of these three, the alignment/prices may differ — tell me and it's a one-line symbol change in `deriv.mjs`.

---

## Honest note on the synthetics
The V-pairs (V25/V50/V75…) are engineered **random walks** — a "sweep" there is just
volatility and carries no real liquidity meaning. They're included because you asked to
watch everything, but the pattern is only *meaningful* on the real markets (Gold, Nasdaq, FX).

## Files
- `monitor.mjs` — live monitor + Telegram alerts
- `detector.mjs` — the 4H double-sweep rule (pure, testable)
- `ltf.mjs` — the 15m entry / Sweep-Of-Liquidity finder
- `firstsweep.mjs` — Stage-2 mid-candle first-sweep snapshot + completion odds
- `narrative.mjs` — Candle B multi-sweep catalogue + chronological narrative
- `execution-window.mjs` — research: does the best Candle-C entry cluster in the first ~75 min?
- `geometry.mjs` — relative geometry of candle B vs candle A (coverage, extension, position, remaining)
- `log.mjs` — appends every event to `events.jsonl` (the research database)
- `whatsapp.mjs` — Meta WhatsApp Cloud API sender + HTML-to-WhatsApp-markdown converter
- `stats.mjs` — queries `events.jsonl` by session / H4 candle
- `conditional-gap.mjs`, `timing-study.mjs`, `state-transition.mjs`, `features.mjs` — research scripts (sweep timing, state, feature dataset → `features.csv`)
- `deriv.mjs` — Deriv WebSocket data + instrument list (with verified `dataSrc` per instrument)
- `tv.mjs` — TradingView's own data feed (no login) — used for instruments where Deriv diverged
- `source.mjs` — routes each instrument to Deriv or TradingView based on `dataSrc`
- `config.mjs` — shared settings loader
- `scan.mjs` — historical scan to validate detections
- `review.mjs` — recent setups with their 15m entry times
- `config.json` — your settings (created from `config.example.json`)
