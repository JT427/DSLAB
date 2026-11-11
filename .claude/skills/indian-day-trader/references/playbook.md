# Intraday playbook for Indian equities

Rates, timings and regulations below change. Treat them as a starting point and tell the user to
confirm with their broker, the NSE/SEBI circulars, or a chartered accountant (for tax).

## When NOT to trade

**Market conditions**
- India VIX at or above 25, or up more than 10% in a day.
- Nifty gapped more than 1% - wait at least 30 minutes; if it is whipsawing, skip the day.
- Nifty already up or down 2% or more: stops slip, and index circuit breakers (10% / 15% / 20%) become possible.
- Flat, low-volume day (Nifty stuck in a tiny range, VIX under 11): breakouts fail repeatedly.
- Event days: Union Budget, RBI policy (wait until after the announcement), election counting,
  major global shock, and the hours before US Fed / US CPI when the market is waiting.
- Index derivatives expiry day afternoon, and the last trading day before a long weekend.
- Special sessions (Muhurat, Saturday mock/DR sessions): thin and erratic.

**Time of day (IST)**
- 09:15-09:30: opening auction noise, wide spreads. Watch only.
- 11:30-13:30: volume dries up. A-grade setups only, half size.
- After 14:45: not enough time; brokers auto-square-off MIS around 15:15-15:20 at market price
  and usually charge a fee for it.

**The stock**
- Results, board meeting or big corporate action today; in F&O ban; under ASM/GSM surveillance;
  trade-to-trade (T2T/BE series - intraday not allowed at all); SME listings.
- Locked or nearly locked at a circuit limit (2/5/10/20% bands): you may not be able to exit.
  If you are short a stock that hits upper circuit you cannot buy back, the position goes to
  auction and the penalty can be large.
- Opened with a gap over 3%, or already moved more than its average daily range.
- Illiquid: turnover under Rs 100 crore a day, visible gaps in the order book, price under Rs 100.
- You are entering because of a tip, a WhatsApp/Telegram channel, or a finfluencer video.
  Pump-and-dump operators target exactly these stocks.

**You**
- Hit the daily loss limit (1.5-2% of capital) or lost 3 trades in a row: stop for the day.
- Trying to win back a loss, bored, angry, sleep-deprived, or trading from a phone in a meeting.
- Using borrowed money, rent/EMI money, or money you need within a year.
- Cannot watch the screen for the duration of the trade and have no stop-loss order in the system.
- No written plan (entry, stop, target, quantity) before the order.

## Risk rules

| Rule | Value |
|---|---|
| Risk per trade | 0.5% of capital (1% max; beginners 0.25-0.5%) |
| Daily loss limit | 3 x risk per trade, at most 2% of capital - then stop |
| Weekly drawdown brake | Down 5% in a week: halve size. Down 10% from peak: stop and review |
| Trades per day | 3 at most; 2 open positions at most, not in the same sector |
| Leverage | Regulatory ceiling for intraday equity is about 5x (20% margin). Use 1-3x. Leverage multiplies losses, not skill |
| Reward:risk | At least 1.5 after charges; otherwise skip |
| Stop-loss | Placed as an SL order right after entry. Never widened, never removed. Use SL-limit with a buffer or SL-M where allowed; a stop can still slip in a fast move |
| Averaging down | Never |
| Exit | Half at 1R and move stop to entry; rest at 2R, or on a 5-min close back through VWAP, or at 15:10 - whichever first |
| Carrying overnight | An intraday loser is not converted to delivery to "wait for recovery" |

Position size = (capital x risk%) / (entry - stop + slippage and charges per share), then capped
by leverage. Use `daytrader.py size`.

## Risks to state to the user

- **Base rate.** SEBI's study of FY2022-23 found about 71% of individual intraday traders in the
  equity cash segment made losses, with frequent traders doing worse. In equity F&O roughly 9 in
  10 individuals lost. Most profitable volume belongs to proprietary desks and algorithms.
- **Gap and slippage risk.** A stop-loss is a trigger, not a guarantee of price.
- **Leverage risk.** At 5x, a 2% adverse move is a 10% hit to the margin used.
- **Liquidity and circuit risk.** See above; the worst losses come from being unable to exit.
- **Short-delivery risk.** Intraday shorts in the cash segment must be bought back the same day.
- **Cost drag.** Charges plus slippage typically take 0.05-0.1% of turnover per round trip.
  Ten trades a day at that rate needs a large edge just to break even.
- **Data risk.** Free data feeds are delayed; the scanner's levels may already be stale.
- **Technology risk.** Broker outages happen on the most volatile days. Keep the broker's
  call-and-trade number handy.
- **Model risk.** The scanner's rules are common discretionary heuristics (opening-range
  breakout, VWAP, relative volume, relative strength). They have not been backtested here and
  have no guaranteed edge.

## Charges for equity intraday on NSE (indicative)

| Charge | Rate |
|---|---|
| Brokerage | 0.03% or Rs 20 per executed order, whichever is lower (discount brokers) |
| STT | 0.025% on the sell side |
| Exchange transaction charge | about 0.00297% of turnover |
| SEBI turnover fee | Rs 10 per crore |
| Stamp duty | 0.003% on the buy side |
| GST | 18% on brokerage + exchange + SEBI charges |

These are coded in `scripts/daytrader.py`; update the constants when rates change.
Use `daytrader.py costs` to show break-even per share.

## Market mechanics

- NSE/BSE equity hours: pre-open 09:00-09:15, continuous trading 09:15-15:30, closing session
  after that. Monday to Friday except exchange holidays (check the NSE holiday list).
- Product type for intraday is MIS (auto-squared-off); CNC is delivery. Settlement is T+1.
- F&O stocks have no fixed daily price band but a dynamic one; other stocks have 2/5/10/20% bands.
- Short selling in cash is intraday only.

## Tax (India, indicative)

- Intraday equity profit is **speculative business income**, taxed at the slab rate - not capital gains.
- Speculative losses can be set off only against speculative gains and carried forward 4 years,
  if the return is filed on time.
- ITR-3 is normally required; a tax audit can apply depending on turnover and profit.
  Advise the user to consult a CA.

## Setups the scanner uses

**Opening-range breakout (live mode).** Range = high/low of 09:15-09:30. Long on a 5-minute close
above the range high while price is above VWAP and volume is running above normal; short is the
mirror image. Stop at the opposite side of the range, capped at half the daily ATR. Skip if the
price is already more than 1R beyond the trigger - wait for a pullback to VWAP instead of chasing.

**Previous-day high/low break (plan mode).** For stocks whose daily trend, 5-day relative strength
and the Nifty bias agree: long above yesterday's high, short below yesterday's low, valid only
after 09:30 with volume, and void if the stock gaps past the level at the open.

In both, trade with the index: longs when Nifty is firm, shorts when it is weak.
