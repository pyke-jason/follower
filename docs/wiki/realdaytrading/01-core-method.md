# The Core Method: Relative Strength & Weakness vs SPY

## What RS/RW Is

Relative Strength (RS) and Relative Weakness (RW) measure how a stock moves independently of the overall market (SPY). A stock with RS goes up when SPY goes up, holds flat or rises when SPY drops, and surges disproportionately when SPY bounces. RW is the inverse.

RS/RW is NOT the RSI indicator. RSI measures a stock's momentum against its own recent history. RS/RW measures a stock's movement against the broader market. RSI is widely considered useless in this methodology.

**The wind analogy:** Imagine 100 runners racing into 100mph winds. 75 get knocked back. 20 make slow progress. 5 run as if there's no wind at all. When the wind reverses and pushes at their backs, those 5 will dominate. SPY is the wind. The 5 runners are stocks with RS.

## Why It Works: The Institutional Edge

RS/RW works because it reveals institutional activity. Here is the causal chain:

1. Institutions (Blackrock, Vanguard, hedge funds, pension funds, mutual funds) control the vast majority of market capital. Retail traders, even at 25-30% of liquidity, are too dispersed to move prices.
2. When institutions accumulate a position, they cannot hide it. Even breaking large orders into 100-share blocks, the buying pressure shows up as RS against the market.
3. Dark pools do not change this. If dark pool buyers exceed sellers, the imbalance is instantly reflected in price.
4. Roughly 75-80% of institutional trading is algorithmic. These algos recognize patterns and act on analyst reports, creating predictable footprints.

**Your edge is their edge, only smaller.** You will always arrive second or third to the institutional move. But riding their coattails -- taking $1 of a $2 move -- is consistently profitable. You are not predicting the market. You are following money that has already been deployed.

**The edge does not disappear with more users.** RS/RW exists because institutions must place billions of dollars. That buying/selling pressure is structural, not a temporary inefficiency. The method has been traded profitably for 15+ years without degradation.

## How to Measure and Monitor RS/RW

### Visual Method (Minimum Viable)
1. Keep a popped-out SPY M5 chart visible at all times.
2. Overlay SPY on every stock chart you analyze.
3. Watch tick-for-tick: when SPY prints a red M5 candle, does the stock print green? That is RS.

### Quantitative Method (Real Relative Strength)
Simple percent-change comparison (stock % change vs SPY % change) is inadequate. A proper RS calculation must account for:

- **ATR normalization.** A $30 stock moving $1 is different from a $300 stock moving $1. Use ATR (Average True Range) over 50 hourly periods to normalize expected movement.
- **SPY Power Index.** Calculate how much SPY moved relative to its own ATR. If SPY dropped 4x its hourly ATR, you would expect stocks to drop 4x their hourly ATR. The difference between expected and actual movement is the Real Relative Strength.
- **Rolling average.** A single candle burst (one large buy order) creates false RS readings. Use a rolling 12-period average on M5 to penalize one-candle spikes and reward consistent movement.

**Formula sketch:**
```
SPY Power Index = (SPY price change) / (SPY ATR)
Expected stock change = SPY Power Index * Stock ATR
Real RS = (Actual stock change - Expected stock change) / Stock ATR
```

A Real RS of 3.0 means the stock outperformed SPY's expected influence by 3x its own ATR.

### Timeframes
- **M5 (intraday):** Look back 12 periods (1 hour). This is the primary day-trading signal.
- **D1 (daily):** Look back 5 periods (1 week). D1 RS is more significant than M5 RS. A stock with D1 RS that also shows M5 RS is a high-conviction trade.

### Tools
- **OptionStalker:** Purpose-built for RS/RW scanning. The 1OSI indicator shows RS > 0 or RW < 0 per timeframe.
- **TC2000:** Good RS scanners and custom scan capability. Volume Buzz measures relative volume vs same time of day.
- **Finviz.com (free):** S&P 500 heatmap on the front page. Click it and look for stocks that stand out disproportionately from their sector.
- **ThinkorSwim:** Built-in RelativeStrength indicator uses simple correlation (inadequate). You can overlay SPY on charts for visual comparison, or code custom studies.
- **TradingView:** "Comparative Relative Strength" indicator, set to SPY.

## The Market First Principle

**Market analysis is 65% of the puzzle.** Before looking at any stock, answer: What is SPY doing?

### The Core Rule
Do not place a trade until you understand the market's direction. Specifically:
- **Do not trade in the first 45 minutes.** Use this time to read the market, identify RS/RW stocks, and form your thesis.
- **Wait for a pullback before going long.** Even in a bullish market, there is almost always a dip. That dip reveals RS (stocks that hold up) and provides a better entry.
- **No longs when the market is down. No shorts when the market is up.** This is the single most protective rule for struggling traders.

### How to Read the Market: A Daily Practice

Every day, classify SPY into one of four categories:

| Category | Characteristics | How to Trade |
|---|---|---|
| **Bullish Trend** | Stacked green candles, orderly climb, higher highs/lows | Wide leash on longs. Add to winners. Hold through pullbacks. |
| **Bearish Trend** | Stacked red candles, sustained drops | Short RW stocks. Tight leash on any longs. |
| **Chop** | Defined high/low range, alternating red/green, market goes nowhere | Reduce size. Take quick profits. Accept lower win rate. |
| **Dangerous Chop** | Chop + high volume/volatility, risk of breakout at any time (FOMC, CPI, etc.) | Minimal trading. Very short leash. Exit quickly on any reversal. |

### Building the Skill
1. Every day, write down your market thesis before trading. Include the story: what are bulls thinking? What are bears thinking?
2. At end of day, compare your thesis to what actually happened.
3. Note when you were wrong and what signs you missed (bounces off support, bid checks, trendline breaks).
4. Track your accuracy over weeks. You will improve.

### Price Action Signals for Market Direction

**Signs of a strong trend (bullish example):**
- Stacked candles of one color with no overlap
- Higher pivot lows on M5
- Bottom wicks > top wicks on candles
- Higher relative volume on green candles
- HA candles with flat bottoms (no lower wick)

**Signs of a weak trend / imminent reversal:**
- Mixed overlapping candles
- Light volume
- Failed attempts to make new highs/lows
- Long wicks rejecting price movement

### Forming a Thesis Using Futures
Use /ES (S&P futures) pre-market to gauge overnight sentiment. Key principles:
- Futures trade 23 hours/day, so pre-market /ES action reflects global sentiment.
- A gap up in futures does not automatically mean a bullish day. Watch the first 30-45 minutes for confirmation.
- Futures provide no edge (no RS/RW). Use them to read the market, not to trade directly (unless you are an expert).

## How to Tell If a Breakout Is Real vs Fake

After a breakout above resistance, evaluate within 2-3 days:

**Real breakout signals:**
- Follow-through buying within 2-3 days on good volume
- Small dips that are quickly gobbled up
- Mid-point of the breakout candle gets tested and immediately recovers
- Volume increases on rallies after the breakout

**Fake breakout signals:**
- Tight ranges on light volume after the breakout (no follow-through)
- Gains not added to in subsequent days
- Volume dries up
- The breakout was likely short covering, not institutional accumulation

**Key principle:** "Breakouts get the stock on the radar, but follow through makes us money. The breakout alone is not enough." Look for aggressive buying that shows institutions do NOT believe they will get a better entry. If follow-through does not happen immediately (2-3 days), the breakout is suspect.

## Bull vs Bear Market Adjustments

### In a Bull Market
- Favor longs. Buy dips after market pullbacks to major support (50 SMA, 100 SMA on daily).
- RS stocks on pullbacks are your highest-conviction trades. Wait for SPY to find support, then enter the RS stock as it slingshots higher.
- You can hold trades with a wider leash because the macro trend supports you.
- Spread your wings on trend days. Average up into winners.

### In a Bear Market
- Technical analysis works, but is less reliable. Macro-economic factors (Fed, CPI, bank stress, war) override chart patterns on any given day.
- Bear markets are driven by external factors; bull markets are driven by the stocks themselves.
- Study the "why" behind price action. Understand what the Fed said, what CPI means, what institutions are reacting to. Use ChatGPT or news sources to rapidly digest economic releases.
- Rallies in bear markets are often short-covering bounces. Do not confuse a 3-day rally with a trend change.
- A bearish market (SPY pulling back) is NOT the same as a bear market (sustained downtrend breaking weekly SMAs). Use the weekly chart with 50/100/200 SMAs to gauge the macro trend. Only a credit crisis of significant magnitude turns a 10+ year bull market into a bear market.

### Five Rules for Difficult Markets (Bear/High Volatility)
1. If the market is choppy, do not trade (paper trade instead).
2. If the market is down, only short. No longs.
3. If the market is up, only go long. No shorts.
4. Do not go long on a stock that is red for the day.
5. Do not short a stock that is green for the day.

These rules will cause you to miss some winners. They will protect you from far more losers.

## Why You Should Not Trade SPY/QQQ Directly

There is no edge trading the index directly. When SPY drops, you lose. When SPY rises, you gain proportionally with everyone else. With RS/RW stocks:
- If SPY rises, your RS stock rises MORE.
- If SPY is flat, your RS stock still rises.
- If SPY drops, your RS stock drops LESS (or holds flat).

The proportional difference IS your edge. Professional traders who can trade SPY profitably (via /ES futures, price action, 1OP indicator) have spent years perfecting that skill. Until you are consistently profitable with RS/RW stocks, do not attempt it.

Watch SPY constantly. Understand SPY intimately. But trade stocks, not the index.

---

## Sources

Articles synthesized from r/RealDayTrading wiki, authored primarily by u/HSeldon2020 (Hari) and u/OptionStalker (Pete):

- "Understanding and Figuring Out Relative Strength" (2021-07-29)
- "A New Measure of Relative Strength" (2021-12-26)
- "What It Means To Have An Edge" (2021-12-19)
- "What are Institutional Traders?" (2022-03-26)
- "Classic Example of Relative Strength (RS)" (2021-07-16)
- "How to Monitor Relative Strength vs SPY" (2021-11-24)
- "If We All Trade RS/RW Will the Edge Disappear?" (2022-01-08)
- "The Great Imbalance And How To Fix It" (2022-01-29)
- "Trading SPY/QQQ - Should You Do It?" (2022-09-15)
- "The Biggest Tip I Can Give To Day Traders" (2021-11-06)
- "How To Read The Market - An Exercise" (2022-01-30)
- "How To Tell The Story" (2022-01-08)
- "The Psychology of the Market" (2021-12-09)
- "How Having An Early Thesis Impacts Your Trading" (2022-06-25)
- "Analyzing the Markets Using Futures" (2022-02-06)
- "How To Tell If This Breakout Is Real or Fake" (2022-11-17)
- "A Bearish Market Does Not Mean It Is A Bear Market" (2022-02-13)
- "Bear Markets Do Not Play By Your Rules!" (2023-03-22)
- "Five Simple Rules for Trading Right Now" (2022-06-09)
- "Keeping it Really Simple" (2022-02-18)
- "You Can Predict Price Movement If You Know What To Look For!" (2023-07-26)
- "How To Read Price Action - Lesson" (2022-06-24)
- "Very Confused" (2022-09-11)
- "Does this Method Work for Crypto, Forex, etc" (2022-01-02)
