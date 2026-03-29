# Options Strategies

Options are leverage tools. Within the RDT method, you use them when you cannot afford enough shares to make a trade worthwhile, or when a specific spread structure gives you an edge that stock alone cannot. Every strategy below assumes you already have a directional thesis from the daily chart, relative strength/weakness, and market analysis. Options do not replace that work -- they amplify it.

## When to Use Options vs. Stock

Stock is almost always simpler: you buy at the bid, sell at the ask, and theta never touches you. Choose options when one of these conditions applies:

- **Leverage needed.** The stock is too expensive to get meaningful share count (AMZN, GOOG, NVDA-class names). Options let you participate with less capital.
- **A spread structure fits the setup better.** You are neutral-to-slightly-bullish, or want defined risk, or want to exploit time decay -- spreads accommodate these views better than stock.
- **Friday lotto.** A specific end-of-week play where options near expiry trade at or near parity.

If you have unlimited capital and a clear directional bias, use stock. Options add complexity that must be justified.

## Options Basics (ELI5)

An option is a contract giving you the right -- not the obligation -- to buy (call) or sell (put) 100 shares at a set price (strike) by a set date (expiration). You pay a premium for this right. That premium has two components:

- **Intrinsic value.** How much the option is "in the money." A $95 call on a $100 stock has $5 of intrinsic value.
- **Extrinsic value (premium).** What you pay on top of intrinsic for time and volatility. This is the part that decays.

The Greeks that matter most:

| Greek | What it means to you |
|-------|---------------------|
| **Delta** | For every $1 the stock moves, your option moves this much. A delta of 0.80 means $0.80 per dollar. Also loosely indicates probability of finishing ITM. |
| **Theta** | How much value your option loses per day. When buying, theta is your enemy. When selling, it is your friend. |
| **Vega** | Sensitivity to implied volatility. High before earnings, collapses after (IV crush). |
| **Gamma** | Rate of change of delta. Accelerates gains/losses as options move deeper ITM or OTM. |

The deeper in-the-money your option, the higher the delta and the closer to 1:1 leverage you get. Far OTM options have tiny deltas and are essentially lottery tickets.

## 10 Tips for Options Trading

1. **Know how much premium you are actually paying.** For ITM: (strike + option price) - stock price = premium over real value. For OTM: the entire option price is premium.
2. **Stop thinking of delta as "probability."** Think of it as leverage: delta of 0.85 means you capture $0.85 of every $1 stock move.
3. **Stop buying OTM options.** They are cheap for a reason. You are not getting a deal -- you are gambling. Use ITM options with delta >= 0.65.
4. **Make sure your option has volume.** Low volume means wide bid-ask spreads. If nobody wants it, neither should you.
5. **Do not sell puts unless you want to own the stock.** The Wheel Strategy is Martingale in disguise. Only sell puts at prices where you are genuinely happy to be assigned.
6. **Do not buy options over earnings.** IV crush will destroy your position even if you get the direction right. The move must overcome the volatility collapse -- and it usually does not.
7. **Learn spreads.** No matter your outlook, there is a spread that fits. Spreads give you defined risk and can reduce capital requirements.
8. **Use ATR and Bollinger Bandwidth.** ATR tells you the stock's typical range. Use it to set realistic strike targets. BBandwidth tells you when a volatility expansion is likely.
9. **Options require the same RS/RW analysis as stock.** Only buy calls on stocks with relative strength to SPY. Only buy puts on stocks with relative weakness. Market first, always.
10. **Check VXX.** It reflects option pricing conditions broadly. When VXX is elevated, premiums are expensive across the board.

## The Option Trap (and How to Avoid It)

The trap: you buy a $5 option, take $1 profit when it works, but ride losers to zero. At those numbers, you need an 83% win rate just to break even.

The math that fixes it:

| Avg win | Avg loss | Required win rate |
|---------|----------|-------------------|
| $1 | $5 (full loss) | 83.3% |
| $1 | $3 | 75.0% |
| $2 | $5 | 71.5% |
| $3 | $5 | 62.5% |
| $3 | $4 | 57.3% |

The solution: be more selective. Only take high-probability setups where you can hold for $3+ profit on a $5 option. Let winners run -- the asymmetry of long options (finite loss, theoretically infinite gain) only helps you if you actually capture that upside. Cut losers when the option hits $1 remaining value instead of riding to zero. Have more faith in your winners than in your losers.

---

## Strategy: Straight Calls and Puts

**When to use:** You have a clear directional bias, the daily chart supports it, and you want leverage on a stock you cannot afford enough shares of.

**Construction checklist:**
- [ ] Delta >= 0.65 (preferably 0.70-0.80)
- [ ] Expiration 1-3 weeks out (not the current week)
- [ ] ITM strike -- never OTM for directional plays
- [ ] Confirm RS (for calls) or RW (for puts) vs. SPY on 5-minute chart
- [ ] Daily chart shows orderly trend with HA continuation candles
- [ ] Stock has cleared significant support/resistance levels
- [ ] Relative volume above 1.5

**Exit rules:**
- Exit when the stock thesis breaks: loss of RS/RW, violation of key support/resistance
- Target at least $3 profit per $5 option cost to maintain favorable math
- If the option declines to $1 remaining value, close it -- do not ride to zero

**Why ITM over OTM:** Fewer contracts at higher delta gives better risk/reward. A $1.50 stock move yields ~$1.20 on a 0.80 delta ITM option vs. ~$0.78 on a 0.52 delta ATM option. The ITM option also has lower theta and survives adverse moves longer.

---

## Strategy: Call/Put Debit Spreads (CDS/PDS)

**When to use:** Premium is too expensive for straight calls/puts; you want defined risk and are willing to cap upside; you want to day-trade options with high win rate.

**Construction checklist:**
- [ ] ATM long leg, OTM short leg -- both expire THIS week
- [ ] Debit paid is less than 50% of the distance between strikes (non-negotiable)
- [ ] Stock is up 3-5%+ on the day and holding gains after the first hour
- [ ] Stock has RS (for CDS) or RW (for PDS) vs. SPY
- [ ] Daily chart supports the direction

**Day-trading profit targets by day of week:**

| Day | Target credit (% above debit) |
|-----|------------------------------|
| Monday | 10-15% |
| Tuesday | 15-25% |
| Wednesday | 25-35% |
| Thursday | 35-50% |
| Friday | 50%+ |

**Execution:** Enter the spread, immediately place a limit sell at your target credit. The closer to expiration, the faster premium burns away and the wider the gap between intrinsic values of your two legs.

**Widening the spread:** If you have a very strong directional bias, widen the strikes (e.g., $300/$280 PDS instead of $300/$295) to increase upside. The 50% debit rule still applies.

**Loss management:** If the stock reverses, recognize it and take the loss. If you paid $2.00 debit, accept $1.50 credit -- do not let the spread go to zero hoping for a reversal.

**When to prefer straight calls/puts instead:** When you are very bullish/bearish and do not want to cap upside. When expiration is more than a week out. When bid-ask spreads are tight and volatility is low (more intrinsic value in straight options).

---

## Strategy: OTM Put Credit Spread (Bullish)

**When to use:** After a market pullback that has recovered. You want a high-probability, low-return play that profits from time decay and requires the stock to merely stay above support.

**Construction checklist:**
- [ ] SPY has pulled back and confirmed recovery (e.g., two consecutive closes above SMA 50)
- [ ] Stock is above SMA 50, 100, and 200 with HA continuation candles
- [ ] No earnings for 3-4 weeks
- [ ] Short strike has at least two major support levels above it
- [ ] Credit received is at least $0.20 per $1 between strikes (25% ROI target)
- [ ] Expiration 3-4 weeks out

**Win-rate math:** At 25% ROI, you risk $0.80 to make $0.20. Break-even win rate is 80%. These plays historically win 95%+ when properly structured, making them consistently profitable.

**Exit/adjustment:** If the stock breaks below your short strike with both a weak market and weak stock, you have two options:
1. Close the spread for a partial loss (preferred for beginners)
2. Buy back the short put and let the long put run -- but ONLY if you are confident both market and stock will continue dropping. This converts a non-directional trade into a directional one. If the decline stalls, close the long put immediately.

---

## Strategy: WATM (Weekly ATM)

**When to use:** You find a neutral-to-bullish stock with weekly options and 6+ weeks until earnings. You want to harvest weekly put premium with downside protection.

**Construction checklist:**
- [ ] Stock has weekly options, 6+ weeks to earnings
- [ ] Neutral to bullish daily chart with bullish catalyst from last earnings
- [ ] Last earnings produced above-average volume
- [ ] ATM weekly put premium is >= 1% of stock price
- [ ] Stock price $50+ (avoid low-priced volatile names)
- [ ] Buy a protective long put 8-12 weeks out (preferably just past next earnings date), 1-2 strikes below ATM

**Weekly management cycle:**
1. Sell ATM puts expiring this week
2. If stock rises: next week sell higher-strike ATM puts
3. If stock is flat: sell same strike again
4. If stock dips but support holds: buy back current short puts at a loss, sell same strike for next week (recapture the loss plus new premium)
5. If stock breaks support: buy back short puts, let long puts run as protection

**Exit rules:**
- Close within 3 weeks of earnings
- Close if you can no longer collect 1% premium on ATM puts
- Take profit after a parabolic up-move (risk widens as stock rises far above long put strike)
- Typical holding period: 4-6 weeks. Usually profitable after 2 weeks.

---

## Strategy: Fig Leaf (Leveraged Covered Call / PMCC)

**When to use:** You are long-term bullish on a stock, want passive weekly income, but cannot afford 100 shares.

**Construction checklist:**
- [ ] Buy LEAP call (12+ months to expiration), delta >= 0.75
- [ ] Best entry: after SPY has pulled back and confirmed support
- [ ] Diversify across sectors -- do not stack AAPL + MSFT; choose NVDA, HD, MRNA, AMZN-type spread
- [ ] Each week: sell a call with delta <= 0.10 against the LEAP

**Income math:** ~$100-150/week per LEAP on high-IV names. After ~6 weeks of premium collection, the LEAP cost is covered and you own it free and clear.

**If stock finishes above your short call:** Broker exercises the LEAP (buy shares at LEAP strike), sells to the short call holder at short call strike. Profit = (short strike - LEAP strike) - LEAP cost + all premiums collected. Then buy a new LEAP and repeat.

**Danger:** If the stock drops significantly, weekly premium collection will not offset LEAP value loss. The LEAP's 12+ month duration gives you time to recover, but a sustained technical breakdown means you exit.

**Hedging your Fig Leaf portfolio:** If you hold multiple bullish Fig Leafs, buy SPY puts or VXX calls (LEAP-dated) as portfolio insurance.

---

## Strategy: Calendar/Time Spreads Over Earnings

**When to use:** You want a direction-neutral earnings play that exploits the IV differential between this week's and next week's options.

**Construction checklist:**
- [ ] Stock reports earnings tonight or before tomorrow's open
- [ ] Enter just before earnings release
- [ ] Sell ATM call (or put) expiring this week
- [ ] Buy same-strike call (or put) expiring next week
- [ ] Pay a debit (this is your max risk)
- [ ] Choose call vs. put based on whichever gives the better entry price

**Profit mechanism:** After earnings, IV crushes both options -- but the near-term option loses IV faster and also bleeds more theta. The far-term option retains more value. You close the spread for a credit higher than your debit.

**Execution:** Place a limit close order for 20-30% profit before the open after earnings. The wide bid-ask at the open gives you the best chance of a fill. If you do not get filled, gradually reduce your ask -- but do not leg out of the spread.

**Best candidates:** Stocks that historically do not make outsized moves on earnings. Extreme gap moves (up or down) push both legs deep ITM or OTM, collapsing the spread value.

---

## Strategy: Bracketing Butterflies

**When to use:** You believe a volatile stock will make a big move in either direction by end of week, but do not know which way. Stocks like TSLA, GOOG, AMZN that swing $15-30+ per week.

**Construction (bullish butterfly):**
- [ ] Estimate a target price above current (e.g., +$30 on TSLA)
- [ ] Buy 1 call at (target - range), sell 2 calls at target, buy 1 call at (target + range)
- [ ] Example: TSLA at $1080 -> 1170/1200/1230 call butterfly

**Construction (bearish butterfly):**
- [ ] Estimate a target price below current (e.g., -$30 on TSLA)
- [ ] Buy 1 put at (target + range), sell 2 puts at target, buy 1 put at (target - range)
- [ ] Example: 1110/1080/1050 put butterfly

**Bracket both:** Enter both butterflies. Combined debit is your total risk. If either target is approached, you profit. Potential return: 9-10x on the winning butterfly.

**Management:**
- Immediately set limit orders for 200-300% profit on each butterfly
- Monitor closely mid-week. If by Wednesday the stock is trending toward one butterfly, you may adjust the other
- Always expire same week -- butterflies do not pay off until the final days
- On volatile stocks, you can sometimes profit on one side, then profit on the other after a reversal

---

## Strategy: OTM Strangles for Major Events (CPI, FOMC)

**When to use:** A major macro event (CPI release, FOMC decision) is imminent. You know SPY will move but have no directional edge. This is rare -- use sparingly.

**Construction checklist:**
- [ ] Buy OTM calls on SPY (e.g., $12+ above current price)
- [ ] Buy OTM puts on SPY (e.g., $12+ below current price)
- [ ] Same expiration (this week or 0DTE)
- [ ] Enter before the event, ideally the day before

**Exit after the event:** Immediately close the losing side (it will be near zero). The winning side should have moved enough to cover both legs plus profit. Target: the winning leg covers the total debit plus meaningful profit.

**When NOT to use:** After the event has already occurred. If the market has already priced in a direction. This is a pure volatility play, not a directional one.

---

## Strategy: OTM CDS Over Earnings

**When to use:** A stock is reporting earnings and you want a statistical-edge play that exploits the expected move range without exposure to IV crush.

**Construction checklist:**
- [ ] Calculate expected move: ATM call price + ATM put price = +/- range
- [ ] Buy an OTM call debit spread with both strikes within the upper portion of that range
- [ ] Debit should be $3.50 or less for a $10-wide spread
- [ ] Expiration: same week as earnings (Friday)

**Statistical edge:** ~70% of stocks go up after earnings. ~50% reach the upper end of the projected range by Friday expiration. A $2.70 debit on a $10 spread yields $7.30 profit (2.7x ROI) -- you only need to win 27% of the time to break even. The spread structure neutralizes IV crush because you are both long and short options.

**Key filter:** Check the stock's historical tendency to hit the upper end of its projected earnings range. Use this as your go/no-go gate.

---

## Strategy: Friday Lotto Options

**When to use:** Friday, final hour of trading. You want a high-risk, high-reward play on a stock with strong intraday RS or RW.

**Execution checklist:**
- [ ] Wait for a SPY pullback roughly 60 minutes before close
- [ ] Identify stocks that held up during the dip (for calls) or dropped harder (for puts)
- [ ] Wait for SPY to begin rebounding
- [ ] Buy ATM or slightly OTM calls/puts expiring TODAY for $0.05-0.20
- [ ] Small position size only -- these are lottery tickets
- [ ] Tell your broker you are monitoring to prevent early liquidation

**Exit:** These move fast. Take profit as the option approaches or crosses ITM. A $0.20 option can become $4.50 in minutes on a stock like TSLA. But many will expire worthless -- the winners must pay for the losers.

**The one exception to the OTM rule:** Lotto options are the one time buying ATM/slightly-OTM is acceptable, because with minutes to expiration, premium is negligible and you are essentially trading at parity.

---

## How to Exit a Losing Spread Trade

This applies primarily to OTM bullish put spreads that have gone wrong.

**Decision framework:**
1. Has your thesis on the stock changed, or just on the market? Stock-specific bad news is more dangerous than a market-wide dip.
2. How much time remains? More than a week = no hurry, you will get chances. Less than a week with the spread ITM = dangerous, act quickly.
3. Is the stock showing relative weakness? You need RW confirmed before legging out.

**Option A (beginners): Close the spread as a spread.** Accept the partial loss. You will rarely take max loss if you act before expiration.

**Option B (experienced): Leg out.**
- Buy back the short put
- Let the long put run
- Your confidence in continued decline must be VERY HIGH -- both market and stock must be weak
- Set a target for the long put equal to what you paid to buy back the short put
- If the decline stalls, close the long put immediately -- do not turn a defined-risk trade into an open-ended one

**Critical rule:** Legging out converts a non-directional position into a directional one. Your opinion of the market and/or stock must have changed substantially to justify this.

---

## Hedging with Options

**When to hedge:** When your portfolio is heavily directional and SPY is volatile. Hedges let you carry swing positions through uncertainty instead of liquidating everything.

**Three types of hedges:**

**1. Overall hedge (portfolio-level)**
- VXX calls are ~3x more effective than SPY puts for hedging bullish portfolios (VXX amplifies volatility moves)
- Buy ATM VXX calls as insurance; worst case you lose ~50% of the hedge if SPY goes up
- Alternative: SPY puts or short S&P futures

**2. Individual position hedge**
- Sell calls against your long calls (creates a spread, caps upside, provides downside cushion)
- Sell covered calls against stock holdings
- Tradeoff: protection costs you upside

**3. Balancing hedge**
- Add positions in the opposite direction using RS/RW
- Example: bullish portfolio + puts on a relatively weak stock
- Advantage: both the hedge and original positions can profit simultaneously if you pick genuine RW

**Sizing the hedge:** Calculate your realistic downside (not max theoretical loss). A $5,000 bullish portfolio might lose $2,000 on a $4 SPY drop. Size your hedge to cover roughly half that downside.

---

## Using a Balanced Portfolio to Swing Trade

Swinging positions overnight is essential for capturing daily-chart moves. The fear of overnight exposure kills swing trades prematurely -- and often turns winners into losses.

**Balancing rules:**
1. Tilt your overnight portfolio only when you have strong market conviction. Otherwise stay balanced between longs and shorts.
2. Hedge with similar sectors when possible. Long RS financials, short RW financials. This insulates you from sector rotation.
3. Size swing positions smaller than day trades. They will move more, and oversized positions trigger emotional exits.
4. Pre-define your mental stop on the daily chart. Only change it if market conditions warrant. If the daily chart breaks down, exit.

---

## Source Articles

1. "Options Trading - Explain It Like I Am Five Years Old" -- u/HSeldon2020, 2021-09-12
2. "10 Tips on Using Options" -- u/HSeldon2020, 2021-08-01
3. "Options - Day Trading" -- u/HSeldon2020, 2021-06-20
4. "How to Set Up Charts and Buy Options" -- u/HSeldon2020, 2022-01-20
5. "Option Spreads I Like To Use And Why" -- u/HSeldon2020, 2021-11-21
6. "How To Exit A Losing Spread Trade" -- u/OptionStalker, 2022-08-30
7. "Bracketing Butterflies" -- u/HSeldon2020, 2020-11-01
8. "Friday Lotto Options - How They Work" -- u/HSeldon2020, 2021-11-15
9. "Fig Leaf Strategy Explained" -- u/HSeldon2020, 2022-01-25
10. "Hedging" -- u/HSeldon2020, 2021-12-16
11. "The Option Trap and Solution" -- u/HSeldon2020, 2023-01-27
12. "CPI Tomorrow and OTM Strangles for the Current Market" -- u/HSeldon2020, 2022-06-09
13. "Using a Balanced Portfolio to Swing Trade" -- u/anonymousrussb, 2022-02-06
14. "Using Debit Spreads a Profitable Day Trading Strategy" -- u/onewyse, 2021-07-25
15. "Profiting from Time Spreads (Calendar Spreads) over Earnings" -- u/onewyse, 2021-10-28
16. "When I Use Weekly Debit Spreads vs Straight Calls or Puts" -- u/onewyse, 2022-01-15
17. "WATM Trading Strategy (Weekly ATM)" -- u/onewyse, 2022-02-21
18. "WATM Trading Strategy (Weekly ATM) - Updated" -- u/onewyse, 2023-02-26
19. "New Type of Trade! OTM CDS - Earnings" -- u/HSeldon2020, 2023-07-25
