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

## 2. Run it

```
node monitor.mjs
```
…or double-click **`start.bat`** (auto-restarts if it ever drops). Leave it running.
You'll get a "monitor live" message, then an alert each time a 4H candle closes as a sweep.

Test commands:
- `node monitor.mjs --once` — evaluate the most recent/forming candle right now and exit.
- `node scan.mjs 30` — list every 4H double-sweep in the last ~30 days to verify against your chart.
- `node review.mjs XAUUSD 5` — last 5 setups on an instrument **with their 15m entry (SOL) times**.

### Timing — heads-up 15 min before the close
4H candles close every **4 hours** (00/04/08/12/16/20 in your chart's clock). The monitor:
1. **⏳ FORMING** — ~15 min before the close (configurable via `alertLeadMinutes`), if the
   still-forming candle has already swept both sides and is closing directionally, it pings you
   so you can **get to the chart and watch it close.** This is *provisional* — the last 15 min can change it.
2. **✅ CONFIRMED / ⚠️ FIZZLED** — at the actual close it tells you whether the sweep held
   (`confirmAtClose`, on by default).

Set `"alertLeadMinutes": 0` if you only want the confirmed alert at close.

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

Across all 9 instruments you'll see **~10–15 alerts/day**. To cut it down:

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
| **Nasdaq** | ~~Deriv `OTC_NDX`~~ → **TradingView `OANDA:NAS100USD`** | vs `OANDA:NAS100USD` | Deriv's `OTC_NDX` diverged by **~$80/candle**, with the sign flipping between O/H/L and C — not a fixed broker spread, the price paths genuinely differ. So Nasdaq now pulls **directly from TradingView's feed** (`tv.mjs`), guaranteeing it's the literal data your chart shows. |

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
- `deriv.mjs` — Deriv WebSocket data + instrument list (with verified `dataSrc` per instrument)
- `tv.mjs` — TradingView's own data feed (no login) — used for instruments where Deriv diverged
- `source.mjs` — routes each instrument to Deriv or TradingView based on `dataSrc`
- `config.mjs` — shared settings loader
- `scan.mjs` — historical scan to validate detections
- `review.mjs` — recent setups with their 15m entry times
- `config.json` — your settings (created from `config.example.json`)
