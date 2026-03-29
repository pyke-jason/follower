# Trading Techniques & Patterns

Process-oriented reference for trendlines, algo lines, compression trading, gap analysis, bear market techniques, scalping, swing transitions, and specific chart patterns. Synthesized from the r/RealDayTrading wiki.

---

## Trendline Terms and Basics

OptionStalker defines four trendline types using a compact notation:

| Type | Connects | Direction | Signal on Breach |
|------|----------|-----------|-----------------|
| **High-** | Highs | Descending | Bullish breakout (trend reversal) |
| **High+** | Highs | Ascending | Bullish breakout (continuation) |
| **Low+** | Lows | Ascending | Bearish breakdown (trend reversal) |
| **Low-** | Lows | Descending | Bearish breakdown (continuation) |

### Contra vs. Continuation Trendlines

**Contra trendlines (High- and Low+)** go "against the grain." They signal trend reversals.
- A shallow, long-term High- (less than 45 degrees) indicates the downtrend is losing power. A breakout above it is a strong reversal signal.
- A steep High- (greater than 45 degrees) indicates a strong downtrend. Do not fade it. Join it instead.

**Continuation trendlines (High+ and Low-)** follow the prevailing trend. They catch pullback entries.
- High+ breakouts can signal buying climaxes. Watch for "High+ Tops" as potential reversal signs.
- Low- breakdowns near the end of steep drops can be selling climaxes. Watch for "Low- Bottoms" as potential reversal signs.

### Fakes
- **High- Fake:** Stock breaks above a descending resistance trendline, then drops back below it. The breakout was a dead cat bounce.
- **Low+ Fake:** Stock breaks below an ascending support trendline, then recovers above it. The breakdown was just profit-taking.

### Validation Rules
- Two points create a "tentative" trendline. A third touch makes it "valid."
- The most important factor is HOW a trendline is breached: a long candle closing convincingly through it on heavy volume is a strong signal. A wick poking through on light volume is not.
- Use daily charts with a 1-year view to keep the X axis consistent for visually estimating angles.

---

## Algo Lines

### What They Are (onewyse)
Algo lines are trendlines that institutional algorithms use to identify support and resistance. They follow specific rules:

1. Connect the tops of candles (for resistance) or bottoms (for support) that represent isolated highs/lows -- candles without other candles at the same level nearby.
2. The line must not cut through any candle bodies (with one exception, see below).
3. The more candle tops/bottoms touched by the line, and the longer the line, the stronger the level.
4. The initiating candle should NOT be from a massive volume event like earnings or news.

### The Volume Exception
If a candle's wick or tail would be cut by the algo line AND that candle has very high volume, you can cut through the wick/tail. If the volume is average or low, use the top of the wick or bottom of the tail instead.

### Types by Strength
- **Descending resistance** (algo line connecting highs, sloping down): strongest resistance. Price is on a collision course.
- **Ascending support** (algo line connecting lows, sloping up): strongest support. Price is moving away from it.
- **Ascending resistance:** weaker -- price can rise along the line without breaking it.
- **Descending support:** weaker -- price can fall along the line without breaking it.

### Drawing Algo Lines: Process

1. Open a D1 chart. Look for high-volume candles that form isolated swing highs or lows.
2. Connect them with a line that does not cut through intermediate candle bodies.
3. Extend the line forward. Where it intersects price is a potential support/resistance level.
4. Draw both upper-bound (resistance) and lower-bound (support) algo lines to create a range.
5. Within that range, draw internal algo lines. Where internal lines intersect the upper/lower bounds, you have **algo price points** -- extremely high probability trade setups.
6. Set alerts at these price points. When triggered, wait for confirmation (daily close through the level), then trade.

### Algo Price Points for Sub-PDT Accounts
HSeldon2020 specifically developed the algo price point method for accounts under $25K:
- Set up upper/lower algo bounds on 50 stocks.
- Identify internal price points where lines intersect.
- Set alerts on all 50.
- When an alert triggers, verify with RS/RW and daily chart confirmation.
- Enter near end of day if the daily candle confirms. Swing the trade.

### A Point of Confusion
There is some tension in the wiki between onewyse's original definition (initiating candle should NOT have massive volume) and HSeldon2020's practice (drawing lines from high-volume candles). HSeldon2020 uses high-volume candles as starting points, while onewyse emphasizes isolated highs/lows. In practice, both methods produce similar results when applied by experienced traders -- the key is the line must respect candle bodies.

---

## Compression Trading

### What Compression Is
Compression is price consolidation -- a coiled spring. Bollinger Bands contract inside Bollinger Bands. The tighter and longer the compression, the bigger and more sustained the breakout.

### How to Find and Trade Compressions (OptionStalker)

**Scanning:**
- Look for stocks in short-term compression (tight range).
- Stock should be above prior day's high (for bullish setups).
- Liquid options and heavy relative volume.
- Compression while the market dips = relative strength. Buyers are supporting the stock against market selling.

**Execution:**
1. Run compression scans while the market is pulling back.
2. Drop horizontal alert lines at the top (for longs) or bottom (for shorts) of each compression.
3. When an alert triggers:
   - Check: is the market finding support (for longs) or rolling over (for shorts)?
   - Check: does the stock have RS/RW?
   - Check: is there volume on the breakout?
4. If yes to all three: enter.
5. If the alert never triggers: no trade, no concern.

**Key detail:** The stock should be compressing in the upper quartile of its daily range (for longs) with heavier than normal volume. This confirms buyers are supporting the price.

### On D1 Charts
Daily chart compressions (inside days, tightening ranges) followed by breakouts on heavy volume provide swing trade entries. Set your alert at the top of the D1 compression range.

---

## Gap Trading

### Gap and Go vs. Gap and Gag (OptionStalker)

**Gap and Go** (market continues in the gap direction):
- Most likely after SPY drops to major support (50-day MA) and confirms it, then gaps up the next day.
- Buyers are aggressive. Support has been confirmed. They want to join the uptrend.
- You can be more aggressive buying on the open in these setups.

**Gap and Gag** (gap reversal):
- Most likely when SPY gaps up to a new all-time high or relative high.
- Bullish speculators pile in. Profit-takers sell. Buyers are trapped.
- A second consecutive Gap and Go is less likely than the first.

**Decision framework for gap opens:**
1. Gap up after confirmed support bounce: lean toward Gap and Go. Be more aggressive.
2. Gap up to new high: assume Gap and Gag is likely. Wait 30 minutes minimum.
3. Gap up in the middle of a range: look at prior candle tails. If candles have tails under the body, expect a pullback before the move continues. Do not chase.
4. In ALL cases: the first 30 minutes provide the data you need. Watch the candle structure.

### Reading the First 30 Minutes After a Gap

**Bullish signs (gap likely to hold):**
- Big green candles appearing quickly -- buyers are aggressive.
- Market pulls back but stock holds near HOD -- relative strength.
- Minimal retracement of the initial move.

**Bearish signs (gap likely to reverse):**
- Tiny candles, dojis, long wicks -- neither side has conviction.
- Initial move up is immediately retraced more than 50%.
- Heavy red volume on pullback candles.

---

## Trading in a Bear Market

### Why Bear Markets Are Different (HSeldon2020)

1. **Technical analysis is less reliable.** Support and resistance levels are breached without volume, as if they are not there. "Stop lights become optional."
2. **News-driven.** CPI, Fed speakers, economic data dominate price action. Multiple conflicting catalysts can hit within 30 minutes.
3. **Bear markets do not trend.** Most days are mind-numbing compressions punctuated by sudden spikes. True trend days are rare.
4. **Sector rotation is intraday.** Stocks strong in the morning become weak by afternoon.
5. **Daily charts are less reliable for swings.** D1 setups that held during bull markets fail more frequently. HSeldon2020 reported a 15-20% decline in monthly profits.

### Rules for Bear Market Trading

1. **Default to day trading.** Overnight risk is much higher. Close positions before the close unless the setup is extremely strong.
2. **Reduce swing exposure.** Only swing with stocks that have exceptional D1 charts and confirmed support/resistance.
3. **Know the economic calendar.** Never get blindsided by a scheduled event. CPI day? FOMC day? Curb overnight risk beforehand.
4. **Expect both sides.** Learn to short. If you only know the long side, you are fighting the prevailing trend.
5. **It is a great time to LEARN on paper.** You will see every scenario. But do not learn with real money in this environment.
6. **Some days, do not trade.** Use chop days for charting, scanning, studying. "No, you lazy fucker, it doesn't mean leave. It means study."

### Supplemental Strategies for Bear Markets
HSeldon2020 identified three approaches that boosted his profits by ~35-40% during the bear market:
1. **Earnings trades** -- specific setups around earnings announcements.
2. **Countertrend trades** -- trading against the prevailing short-term direction with strict rules.
3. **Rule subversion** -- deliberately violating standard rules under specific, defined conditions.

**Important:** These are SUPPLEMENTAL. Master the core method first.

---

## Day Trading to Swing Trading Transitions

### Why You Must Swing Trade (OptionStalker)

Market conditions change. When intraday ranges compress and most movement happens overnight, day trading alone will starve you. During the 2019 ZIRP market, intraday ranges were minuscule -- swing trades were the only way to make money.

### How to Transition
- Apply the same skills: D1 chart analysis, RS/RW, support/resistance, volume.
- Start with 1 share overnight. Get used to the psychological discomfort.
- For swings, the daily chart IS the 5-minute chart. Read it the same way.
- Use options strategies to manage overnight risk:
  - Sell naked puts on stocks you want to own.
  - Sell OTM vertical credit spreads with bullish or bearish bias.
  - Target 20% credit per dollar of spread width for BPS.

### When to Convert a Day Trade to a Swing
If your day trade goes against you but the D1 chart is intact and the thesis is not invalidated, you have the OPTION to swing it. This is one of the core benefits of selecting stocks with strong daily charts -- it gives you a fallback. You do not have to swing it. But you can, with confidence.

---

## Scalping: Rules and Limitations

### Professor1970's Scalping Method

**Requirements:**
1. Stock MUST have relative strength to SPY on the 5-minute chart.
2. Minimum 1.2 relative volume (higher is better).
3. Stock has gapped up on momentum, then pulled back to the 8-period EMA on the 5-minute chart.
4. Enter on a green candle after the 8 EMA has been tested.
5. Stock must be above VWAP.

**Position management:**
- Enter 1/4 position at the 8 EMA bounce.
- Add 3/4 on confirmation (next green candle).
- Add 1/4 more on test of HOD.
- Sell into strength (big green candles).
- Mental stop: negative 3/8 EMA cross OR print below VWAP (whichever comes first).

**Critical rules:**
- NEVER carry low-float momentum stocks overnight (dilution risk).
- Once a momentum stock trades below VWAP: remove it from your watchlist. No chasing.
- The key to a profitable scalp is a good ENTRY. Do not chase. Use rules.
- Size so that your max loss (stop hit) is comfortable.

### HSeldon2020's View on Scalping
Scalping is NOT a reliable, repeatable strategy for making a living. It is "fun but not profitable" on a consistent basis. It does not work in bull markets and does not work in bear markets. HSeldon2020 explicitly tested it as a supplemental bear market strategy and rejected it.

---

## The "Walking the SMA" Concept

When a stock is in a strong trend, it will "hug" and periodically touch its 8-period EMA (on D1) without significantly breaching it. The stock walks along the SMA like a path.

**What to watch for:**
- As long as the stock stays near the 8 EMA and the slope of the candles matches the slope of the EMA, the trend is intact.
- When a large gap opens between price and the 8 EMA, expect a pullback to close the gap.
- If the stock breaches the 8 EMA significantly and does not recover within 1-2 candles, the trend may be over.

On the 5-minute chart, the 3/8 EMA crossover signals short-term trend changes:
- 3 EMA above 8 EMA: bullish (recent price action is stronger than slightly older price action).
- 8 EMA crossing above 3 EMA: bearish signal; consider exiting or tightening stops.

---

## Descending Wedge Pattern (OptionStalker)

### Identification
A steep selloff produces converging High- and Low- trendlines. When:
- Low- slope is greater than 60 degrees
- High- slope is greater than 75 degrees
- A wedge has formed and a bounce becomes likely.

### How to Trade It

**During the initial drop:**
- Short on Low+ trendline breakdowns (contra trendlines failing = trend continuation).
- Short on horizontal support failures.
- Each new trendline breach provides added confirmation. Ride it down.
- Stacked red candles on heavy volume are the "tell" -- do not fight them.

**At the wedge point (potential bounce):**
- Do NOT pick bottoms. Wait for signs of support.
- Look for a gradual High- trendline to form (not a V-bottom).
- Breakout above the High- is tradeable, but with smaller size than your shorts were.
- Take quick profits. The bounce is temporary. "Papa Bear" is coming home.

**After the bounce:**
- Watch for the bounce to stall and fail.
- When the stock drops back below the High- trendline: bottom pickers are trapped.
- Short the Low+ trendline failure for the next leg down.

### Key Rule
Steep declines take a LONG time to resolve. There will be many shorting opportunities. Do not rush in on the long side. Draw your trendlines and let the setups come to you.

---

## Volume Analysis

### The Story Volume Tells (HSeldon2020)

Volume alone tells you nothing. Volume + price direction + relative volume tells you everything.

**Three volume tools:**

1. **Relative Volume (RVOL):** Current volume / average volume. Use 50-period MA on daily, 78-period on 5-min (78 = number of 5-min bars in a trading day). RVOL > 1.5 = institutional interest.

2. **On Balance Volume (OBV):** Running cumulative total that adds volume on up days and subtracts on down days. Shows whether the weight of volume favors buyers or sellers over time.

3. **Price-Volume Divergence:** The most powerful signal.
   - Price going up but OBV trending down = rallies on low volume, drops on high volume. Sellers are in control even though price is rising. Expect a drop.
   - Price going down but OBV trending up = selloffs on low volume, bounces on high volume. Buyers are accumulating. Expect a reversal.

### Practical Rules
- High volume = institutional participation. Good. Provides liquidity and organized movement.
- Low volume = retail-only trading. Choppy, unpredictable, wide spreads. Bad trading environment.
- Volume on breakouts must confirm: a trendline breach without volume is suspect.
- On the daily chart, if red days consistently have higher RVOL than green days: the stock is under distribution. Do not go long.

---

## Heiken Ashi Candles for Trend Identification

### Why Use Them
HA candles smooth out noise and make trends visually obvious. On the daily chart:
- Flat-bottomed green HA candles = strong bullish trend (what you want to see for longs).
- Flat-topped red HA candles = strong bearish trend (what you want to see for shorts).
- HA reversal: a transition from red to green (or vice versa) provides a signal that the trend is changing.

### How HSeldon2020 Uses Them
- On the D1 chart: look for two consecutive flat-bottomed green HA candles as a prerequisite for entering a long trade.
- HA reversal on the daily chart is one of the factors that can support or invalidate a thesis.
- On the 5-minute chart: HA candles help identify when intraday trends have shifted. Useful for staying in trades longer.

### Limitations
HA candles are a smoothing tool, not a standalone signal. They must be combined with RS/RW, volume, and market context.

---

## Trading Both Sides of the Market

### Why You Must Learn to Short (OptionStalker)

The long bull market of 2020-2021 masked the true skill level of many traders. When corrections come, traders who only know the long side lose everything.

**Key differences when shorting:**
- Stocks fall faster and harder than they rise. Shorts can be more violent and profitable per unit of time.
- Do not chase the drop. Take profits on big red candles. Wait for the bounce to stall, then re-short.
- In a bear market, overnight shorts become viable (unlike bull markets where overnight longs were the default).
- Start with 1 share. Get used to the psychological discomfort of "selling something you don't own."

### The Adaptation Mindset
Your job as a trader is to trade what is in front of you, not what you wish was there. If the market is bearish, trade the short side. If it transitions to a range, adapt to swing trading. If it starts trending, ride the trend.

The ability to adapt to changing market conditions is arguably the most important skill in trading.

---

## Source Articles

- "Trendline Terms and Basics" (OptionStalker)
- "Descending Wedge Pattern - How To Trade It" (OptionStalker)
- "What are algo lines?" (onewyse)
- "Drawing Algo Lines - Internal Range Price Points" (HSeldon2020)
- "As Requested: How Draw Algo Lines and Set Price Points" (HSeldon2020)
- "Algo Price Point Analysis - Could this be the answer?" (HSeldon2020)
- "Trading Compression Breakouts" (OptionStalker)
- "Introduction to New Section: Trading in a Bear Market" (HSeldon2020)
- "Gap and Go or Gap and Gag?" (OptionStalker)
- "Swing Trading Must Be A Part of Your Game Plan" (OptionStalker)
- "What Is A Good Swing Trade" (HSeldon2020)
- "How I Scalp" (Professor1970)
- "Staying Focused in Chop" (HSeldon2020)
- "Using Volume in Your Analysis" (HSeldon2020)
- "The Unfortunate Truth I Hope You Never Experience" (OptionStalker)
- "Using Heiken Ashi Candles to Identify Trends" (multiple)
- "How To Trade the Open" (OptionStalker)
- "RS/RW & Algo Price Points" (HSeldon2020)
- "Algo Lines on SPY" (HSeldon2020)
- "Open Questions on Algo Lines" (community)
