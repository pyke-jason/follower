# Stock Selection & Analysis

## The Selection Pipeline

Stock selection is a multi-stage filtering process. Start broad and narrow aggressively. Your goal is not to find "good" trades -- it is to find the 2-5 best trades of the day and ignore everything else.

```
Scanners (broad net, 50-100+ stocks)
  -> Screeners (filter by criteria, 10-20 stocks)
    -> Chart analysis (manual review, 5-10 stocks)
      -> Watchlist (ready to trade, 2-5 stocks)
        -> Entry (market confirms, 1-3 trades)
```

## Three Types of Lists

### Watchlist (Static, Updated Nightly)
Build this every evening or pre-market. Include:
- Stocks you have been tracking that are approaching key levels
- Stocks from scanner results that look promising for tomorrow
- Stocks you are familiar with and trade regularly
- Categorize and label each entry. Set alert lines on their charts at entry points.

**Setting alerts is non-negotiable.** Draw trendlines, mark horizontal S/R, place alerts at key levels. When an alert fires during the day, you already have context on the stock.

### Scanners (Constantly Running)
Scanners update automatically throughout the day. Your scanner list should change constantly -- the stocks presenting opportunities at 10am are different from those at 1pm.

**For RS/RW scanning, configure for:**
- Relative Strength vs SPY (proportional to stock price and ATR, not simple correlation)
- Volume: Relative Volume > 1.5 (150% of average)
- Price above previous day high (longs) or below previous day low (shorts)
- Price above $10, float above 50 million, volume above 1 million

**Scanner platforms ranked:**
1. **OptionStalker** -- built around RS/RW. Best-in-class for this methodology. Pre-configured and custom searches.
2. **TC2000** -- comprehensive scan features including sequence scans. "Volume Buzz" measures relative volume vs same time of day (critical).
3. **ThinkorSwim** -- decent scan inputs but results are unreliable for RS/RW (uses simple correlation).
4. **Finviz.com (free)** -- good screener for evening prep. S&P heatmap for visual RS identification during the day.

### Screeners (On-Demand Custom Searches)
Run these manually to adapt to changing market conditions. Example when SPY is compressing:
- Relative Volume on D1 > 1.5
- Price above previous day high
- RS to SPY on D1
- Currently in compression on 2hr chart
- Place alert lines on top of compressions; get notified when stocks break out as SPY breaks out.

## The Mandatory Checklist

Every trade must satisfy ALL of these before entry. No exceptions.

### 1. Market Confirmation
- Identify today's market type (Bullish Trend, Bearish Trend, Chop, Dangerous Chop).
- Trade only in the direction of the market. Long on up days, short on down days.
- Do not trade in the first 45 minutes. Use that time to read the market and build your watchlist.
- Wait for at least one SPY pullback before going long. This reveals true RS and provides better entries.

### 2. Daily Chart Quality
Treat the D1 chart as if it were an M5 chart. Would you trade it?

**Look for:**
- Obvious trend direction (use HA candles for clarity)
- Price above all major SMAs (50, 100, 200) for longs; below all for shorts
- No nearby resistance (longs) or support (shorts) within 1% -- the "Daily Void"
- Clean, orderly price action. No gappy, choppy, or super-extended candles.
- At least 2 consecutive HA continuation candles (flat bottom for longs, flat top for shorts) on D1

**Reject if:**
- Gappy candles (action happening outside market hours, unpredictable)
- Choppy, mixed overlapping candles (too much fluctuation)
- Super extended (typically > 10% from 8 EMA, though volatile stocks can stretch further)
- Price trapped between nearby S/R levels with < 1% room to move

### 3. Relative Strength/Weakness to SPY
The stock must demonstrate RS (for longs) or RW (for shorts) on both the D1 and M5 timeframes.
- D1 RS: stock outperforming SPY over the past 5 trading days
- M5 RS: stock holding up or rising when SPY pulls back intraday
- When SPY prints a red candle, your RS stock should print green or a small-body candle. When SPY bounces, the RS stock should surge.

### 4. Volume Confirmation
The stock must be actively pushed by institutional buying/selling, not just drifting.
- Relative Volume > 1.2 (20% above average for that time of day). Ideally > 1.5.
- Volume should increase when the stock breaks technical levels.
- Higher relative volume on green candles (longs) or red candles (shorts).
- If volume is low but rising as levels break, acceptable. If volume is low and flat, pass.

### 5. VWAP Alignment
- Do not go long on a stock below VWAP on M5.
- Do not short a stock above VWAP on M5.
- VWAP acts as intraday support/resistance. If the stock breaks below VWAP and the candle closes below it, the bullish thesis is weakening.

## High-Conviction Enhancers (Need at Least One)

These turn a solid trade into an exceptional one. Each signals strong institutional involvement.

### All-Time High / All-Time Low
No bag holders exist above an ATH (longs) or below an ATL (shorts). There is no overhead supply / demand to absorb the move. The stock has a void to run into.

### D1 Technical Event
In order of strength:
1. **Algo line break** (strongest) -- price breaking through a multi-touch trendline drawn from significant highs/lows on the daily chart
2. **SMA break** -- price clearing a major SMA (50, 100, 200) that has acted as resistance
3. **Horizontal S/R break** -- price breaking through a well-established horizontal level

### Compression Break
If the D1 chart has been in a tight range (compression) for multiple days/weeks and breaks out, the move can be explosive. Requires serious volume confirmation. Use Bollinger Bandwidth expansion as a confirming signal.

### HA Continuation
Three or more consecutive HA candles of the same color with a flat side (flat bottom for bullish, flat top for bearish) on the D1 chart. Simple, reliable trend confirmation.

### Stacked Sector Strength
The stock has RS to its sector AND the sector has RS to SPY. This ensures you are at the crest of institutional rotation, not riding speculative news. Check this on a 5-day rolling basis.

## How to Find These Stocks Step-by-Step

### Step 1: Scan by Event/Trait
Run scans for stocks exhibiting the enhancers above: ATH/ATL, compression breaks, algo line breaks, HA continuation. Also scan for stocks at their high/low of the day -- stocks at extremes are usually doing something interesting.

### Step 2: Sort by Relative Volume and Sector Strength
This narrows your list from hundreds to a manageable number. Only chart-review stocks with volume and sector confirmation.

### Step 3: Check D1 Charts
- Stocks that COULD be good if they break a level: set alerts and move on.
- Stocks that ARE good now: add to your active watchlist.

### Step 4: Repeat All Day
Your watchlist is not static. Keep scanning, keep trimming, keep adding. The best trade at 2pm might not have shown up at 10am.

### Step 5: Wait for Confirmation
Have your top 2-5 stocks loaded and ready. Wait for the right market conditions and the best entry on each.

## Leaning on the Daily Chart

"Leaning on the daily" means using the D1 chart to justify holding a trade through intraday noise. This is one of the most powerful and misunderstood concepts in the method.

### When to Lean
- The D1 chart is bullish (above SMAs, HA continuation, RS to SPY, volume)
- Your trade is going against you intraday but the D1 thesis has NOT been violated
- The market is in a trend day (not chop) that supports your direction

### When NOT to Lean
- The D1 closes as a reversal candle with high volume, closing below yesterday's low (longs)
- A D1 trendline or algo line is breached in the opposite direction of your trade
- The market has shifted against your thesis (bear trend day when you are long)

### Position Sizing for Swings
Enter at "swingable size" -- half your normal intraday position. This gives you room to:
- Add on pullbacks if you mistimed entry
- Add to winners when the trend is strong
- Hold overnight without excessive risk

### Managing the Position
- **3/8 EMA cross:** A bearish cross above VWAP is a profit-taking signal. A bullish cross after consolidation is an adding signal.
- **VWAP:** If the stock breaks below VWAP and closes below it, the bullish intraday thesis is weakening. Consider reducing.
- **High of Day:** If the stock makes a new HOD on good volume as SPY pulls back, that is pure strength. Consider adding.

### Taking the Loss
The basis of your entry was the strong D1 chart. If the D1 breaks down (closes below key support, reversal candle on high volume, algo line violated), take the loss. Do not find new reasons to stay in a trade.

## Reading Price Action on the Stock

### Context Comes First
Before reading any M5 chart, establish the D1 context:
- Is the stock in a strong trend or a trading range?
- Did price arrive here via a Lamborghini (stacked candles, strong) or a bicycle (mixed, overlapping, weak)?
- Are candles of a single color (strong trend) or mixed (weak trend)?
- Is there overlap between consecutive candles (weak) or are they stacked (strong)?

### What Candles Tell You
- **Long green candle with no top wick:** Aggressive buying, closed at highs. Bullish.
- **Long red candle with no bottom wick:** Aggressive selling, closed at lows. Bearish.
- **Doji (small body, long wicks):** Indecision. Buyers and sellers are face-off. High volume doji = significant battle.
- **Bullish engulfing after a dip:** Buyers overwhelmed sellers. Support confirmed.
- **Bearish hammer at resistance:** Sellers rejected the rally. Resistance holding.

### How Price Gets From A to B Matters
Two stocks can both go from $100 to $105. One does it with stacked green candles on rising volume (strong, trustworthy). The other does it with mixed overlapping candles, long wicks, and erratic volume (weak, likely to reverse). The path matters as much as the destination.

**Strong trend characteristics:**
- Stacked candles of one color
- Minimal overlap between candles
- Volume increasing in the direction of the trend
- Pullbacks are shallow, brief, and disorganized (mixed candles, low volume)

**Weak trend / reversal warning:**
- Mixed overlapping candles
- Volume declining on rallies / increasing on dips
- Long wicks rejecting new highs/lows
- Organized selling (stacked red candles with little overlap)

### Trading Breakouts: Good vs Bad

Not all breakouts are equal. Before buying a breakout to a new high of day:

**Check for orderly D1 price action.** If the D1 is turbulent with mixed overlapping candles and heavy retracement, the breakout is suspect. (Example: a stock that has been choppy for weeks suddenly breaks out -- but the path to the breakout was a mess.)

**Check for gap behavior.** If the market was strong yesterday and the stock barely gained, an overnight gap fill is a warning sign. Strong stocks should not need a bid check when the market is bullish.

**Buy dips, not breakouts (especially if your win rate is < 75%).** Set multiple alerts below the current price. When alerts trigger, evaluate: was the pullback brief, shallow, disorganized? Did VWAP hold? Did the stock maintain RS during the dip? If yes, buy when it bounces. If the pullback has stacked red candles and is organized, set lower alerts and wait.

**Scale in on confirmation.** You do not have to enter the full position at once. Buy some at the dip, add on follow-through.

### The "Walk Away" Analysis
Go back through your recent trades. For each loser, check: did the stock eventually become profitable? The answer is almost always yes (95%+). Your picks are right. The problem is timing, position sizing, and impatience. RS/RW combined with the D1 chart shortens the "when" from weeks to hours.

## Fine-Tuning Your Choices

### The Ranking Exercise
For every trade you find, rank it 1-5 (1 = looks okay, 5 = can't-miss conviction). Log the rank alongside the trade. After 100+ trades, group by rank and calculate average profit per group. The results should be linear (higher rank = higher profit). If they are not, you are misjudging what makes a trade great vs mediocre.

### The Averaging Up Practice
On trend days, practice averaging up into winners instead of taking early profits:
1. Open with 1/4 your normal position size.
2. At the halfway profit target, double to 1/2 size.
3. At your normal profit target, double to full size.
4. Set a new profit target one increment higher.

This rewires the instinct to take profits too early and trains you to add to winners.

### Common Mistakes to Avoid
- **Counter-trend trading.** Going long when the market is down because "this stock has RS." RS provides a cushion, not immunity. Very few stocks tread water during a sustained market drop.
- **Trading the first 30-45 minutes.** The open is chaotic. Wait for the market to settle and reveal its hand.
- **Buying breakouts at HOD without confirmation.** If your win rate is < 75%, buy dips, not breakouts.
- **Holding a "day trade gone bad" overnight.** Less than 5% of your day trades should convert to swings. If the number is higher, your entries are poor.
- **Finding new reasons to stay in a losing trade.** If your D1 thesis is violated, exit. Period.
- **Following another trader's thesis instead of your own.** Their risk tolerance, position size, timeframe, and conviction are different from yours. Form your own thesis from the same principles.

### The Highest-Probability Setup (Combining Everything)

When ALL of these align simultaneously, you have the maximum edge:

1. Market is trending in your direction (not chop)
2. D1 chart is clean, trending, above/below all SMAs, HA continuation, with a void of at least 1%
3. Stock has RS/RW to SPY on both D1 and M5
4. Relative Volume > 1.2 and rising
5. Stock is above VWAP (longs) or below VWAP (shorts)
6. Stacked sector RS/RW (stock > sector > SPY)
7. At least one enhancer: ATH/ATL, algo line break, compression break, or D1 event

Take 1-5 of these per day. Sit on your hands the rest of the time. A 92% win rate on these setups is achievable and documented.

**"Our objective is not to trade but to make money. Trades are just the vehicle."** -- u/onewyse

---

## Sources

Articles synthesized from r/RealDayTrading wiki, authored by u/HSeldon2020 (Hari), u/OptionStalker (Pete), u/lilsgymdan (Dan), u/onewyse (Dave), and u/AwkwardAlien85:

- "Simple and Effective Day Trading Method" (2021-06-14)
- "A Simple Strategy" (2021-07-25)
- "Screeners/Scanners/Watchlists" (2021-07-18)
- "Method for Picking the Best Trades" (2022-04-12)
- "Method for Highest Probability Trades" (2022-04-02)
- "These Trade Criteria Work Really, Really Well" (2022-04-23)
- "Trading only Highest Probability Setup Trades" (2022-07-10)
- "Highest Probability Trade Setups Dec01-23" (2022-12-26)
- "This Criteria for Reading the Market" (2022-07-09)
- "How to Lean on the Daily Chart" (2022-08-27)
- "How To Read Price Action - Lesson" (2022-06-24)
- "How To Day Trade Relative Strength - Step-By-Step Guide" (2021-12-01)
- "Great D1 and Great M5 - Should I Buy the Breakout?" (2023-03-05)
- "Keeping it Really Simple" (2022-02-18)
- "Five Simple Rules for Trading Right Now" (2022-06-09)
- "Very Confused" (2022-09-11)
- "How the Stock Gets From Point A to Point B Matters!" (2023-08-16)
- "Anatomy of a Trade - Part 1" (2021-12-24)
- "You Trade Analysis Starts Here" (2021-08-02)
- "Time Your Trades and Improve Your Win Rate" (2022-01-14)
- "Align Your Trades With The Market" (2021-08-02)
- "Traditional Technical Analysis is becoming less effective - What to do about it" (2022-02-03)
- "Stick to the Process" (2022-09-11)
- "How Having An Early Thesis Impacts Your Trading" (2022-06-25)
- "The Great Imbalance And How To Fix It" (2022-01-29)
