# Entry & Exit Rules

Process-oriented reference for timing entries, sizing positions, managing exits, and scratching trades. Synthesized from the r/RealDayTrading wiki.

---

## When to Enter: Timing Rules

### The First 30 Minutes

Do not trade the first 30 minutes. This is the single most repeated rule across the wiki.

**Why it matters:**
- Indicators (VWAP, moving averages) need data to stabilize. VWAP after 15 minutes is meaningless -- it is a weighted average with almost no data behind it.
- The open is dominated by program-driven price action, gap fills, and overnight order flow. Reversals are sudden and without warning.
- Institutional players evaluate the first 30 minutes before committing. You should too.

**Tiered rules by experience level** (HSeldon2020):
1. Consistently losing trader: wait the full first hour.
2. New or learning trader: wait 30 minutes minimum.
3. Good trader, not yet consistently profitable: wait at least 15 minutes.
4. Consistently profitable trader: trade whenever you want.

**What to do during the wait:**
- Observe which stocks and sectors are moving.
- Gauge buyer vs. seller aggression from candle size, overlap, and volume.
- Run scanners. Drop alert lines on compression breakouts and algo line breaches.
- Identify relative strength and weakness candidates.

### Pre-Open Preparation

Your trading day starts two hours before the open (OptionStalker). Checklist:

1. Read overnight headlines. Check global markets (Europe, Asia) and S&P 500 futures.
2. Review economic calendar -- CPI, FOMC, jobs data all move markets instantly.
3. Identify key technical levels on SPY daily chart. Is the market gapping above or below them?
4. Review your open positions. Any overnight movers? News? Adjust or close as needed.
5. Run your daily scan. Identify 30-50 stocks with relative strength/weakness. Draw trendlines. Set alert lines.
6. Determine your market bias for the day. Is this likely a trend day, chop day, or inside day?

### The Sweet Spot

OptionStalker's preferred window: 45 minutes after open through the next 2 hours. By this point you have enough data to assess direction, volume, and relative strength.

---

## Entry Criteria Checklist

Before entering any non-momentum trade, verify these five steps (HSeldon2020):

### Step 1: Market Direction
- What is SPY doing right now? Trending, chopping, compressing?
- Is your trade going WITH or AGAINST the market? Going against requires the stock to be extremely strong/weak.
- Is there a 1OP cycle or other market timing signal in your favor?

### Step 2: Daily Chart
- Does the stock have a clear bullish or bearish bias on D1?
- Look for two flat-bottomed green HA candles (for longs) on the daily chart.
- Relative volume on the day should be over 1.5.
- Identify major support and resistance. Is there room to run before hitting an algo line or horizontal level?
- A strong daily chart lets you swing the trade if the day trade goes against you.

### Step 3: 5-Minute Chart
- Overlay SPY on the chart. Is the stock outperforming (for longs) or underperforming (for shorts)?
- 3 EMA should be above 8 EMA (for longs).
- Stock should be above VWAP (preferred, not absolute).
- Is there a TSI (TrueStrengthIndex) cross confirming direction?

### Step 4: Catalyst Check
- Any news, earnings, or sector rotation driving the move?
- Is this stock moving in sympathy with another stock? If so, be cautious -- the move may be artificial.
- Quick check: news sites, Twitter ($TICKER search), Finviz sector heat map.

### Step 5: Strategy Selection
- Stock, options, or spread? Match the vehicle to the trade duration and account size.
- For expensive stocks (AMZN, GOOGL), consider call debit spreads to cap risk.
- If you want the ability to swing, prefer stock over short-dated options (theta decay).

### The One Question Test
Before clicking buy: "Can I defend this trade?" If another trader asked why you took it, can you give analysis-based reasons? If your defense is "I think it hit bottom" or "it has to reverse soon" -- that is not a defense. Do not take the trade.

---

## Position Sizing

### The Core Principle
Position sizing is the LAST decision, not the first. It comes after: market direction (D1 and M5), stock selection (D1 and M5), trade duration, and strategy selection. Only then do you ask "how much?"

### For Beginners
Your position size is 1 share. Trade 1 share until your win rate exceeds 75% for multiple consecutive months (OptionStalker). This is not optional advice -- it is the foundational rule. With 1 share, you learn every other skill without financial pressure destroying your judgment.

### For Scaling Up
Once at 75%+ win rate, position sizing becomes dynamic and situational. Consider:

- **Your daily goal, win rate, and average trades per day.** Example: $1,000/day goal, 80% win rate, 10 trades/day = need $150/win and can tolerate $100/loss. That sets share count.
- **The stock's volatility.** A $12 ATR stock (like ENPH) requires smaller size than a $2 ATR stock.
- **Market conditions.** Trend day with strong volume? Size up. Inside day with light volume? Size down, set passive targets.
- **Buying power management.** Never use all your DTBP on one trade. You need flexibility for better setups that appear later.
- **Can you handle the drawdown?** If the position is so large that a normal pullback makes you exit based on fear rather than technicals, you are too large.

### What "Risk" Actually Means
You are NOT risking your entire position size. If you buy 1,000 shares at $160, you are risking the distance to your stop, not $160,000. If your mental stop is $159, your risk is $1,000.

### The Catch-22
Position too small: results don't matter, you lack motivation. Position too large: you make decisions from emotion, not analysis. Find the middle ground where the result is meaningful but does not override your technical judgment.

---

## Averaging Up (Not Down)

### The Default Rule: Average UP, Never Down
When a trade is working and all conditions remain valid, ADD to it. When a trade is going against you, do NOT throw good money after bad.

### Three Questions Before Adding (HSeldon2020)
Ask yourself:
1. Is there a reason to exit other than hitting an arbitrary target? (Answer should be NO)
2. If I were not in this trade, would I enter it right now? (Answer should be YES)
3. Are the conditions (market, stock, RS/RW) the same as when I entered? (Answer should be YES)

If answers are No/Yes/Yes: **add to the position.**
If answers are No/No/Yes: **stay in, do not add.**
Any other combination: **exit.**

### The Rare Exception: Averaging Down
HSeldon2020 acknowledges one scenario: "Right idea, wrong time." Conditions:
- Your original thesis has NOT been invalidated (no technical violation).
- The math works: adding 30% more capital reduces average cost by 50%+.
- The probability of reaching breakeven has improved to "probable, not just possible."
- This is a rare, deliberate, calculated decision -- not a habit.

**Warning:** Most traders will misuse this. If you are not consistently profitable, do not average down. Ever.

---

## Exit Rules

### Ten Reasons to Exit (HSeldon2020)

1. **You want to.** Legitimate, but examine why. Fear of loss = position too large.
2. **Sell into strength.** Take partial profits while the stock is still strong. Let the rest ride.
3. **You need the buying power.** Your capital is better deployed elsewhere.
4. **Thesis no longer applies.** The stock lost RS/RW, volume dried up, 3/8 EMA crossed the wrong way. This is the strongest exit signal.
5. **Major technical violation.** Stock broke through support, fell below a major SMA. Do not fool yourself that it will recover.
6. **Target acquired.** You had a profit target and hit it. Take it. Do not get greedy.
7. **Scratch.** Breakeven is better than a loss. Psychologically unsatisfying but financially sound.
8. **Market changed.** SPY reversed direction meaningfully (not a small bounce -- a real change in conditions).
9. **Earnings or event approaching.** Close before unpredictable catalysts.
10. **Price action changed.** Volume spikes on red bars, compression broke the wrong way, stock fell below VWAP with no daily support.

### Five Factors for Dynamic Exits (OptionStalker)

1. **Market conditions.** Strong market trend = let trades run. Compressed, light volume market = set passive targets.
2. **Relative strength.** As long as the stock maintains RS to SPY on dips, stay in. When it softens on a market dip, take profits.
3. **Heavy volume.** Rising on heavy volume with declining volume on pullbacks = ride it. Diminishing volume on rallies = take gains.
4. **Technical breakouts.** Stock breaking through D1 resistance on heavy volume = be aggressive, let it run. Stock barely poking at resistance = passive targets.
5. **Price action.** Stacked single-color candles with no overlap = strong trend, hold. Mixed overlapping candles, bearish engulfing patterns, double tops = take profits.

### When to Let Trades Run (Trend Days)
Look for these five characteristics (OptionStalker):
1. Major technical D1 breach (support or resistance blown through).
2. Heavy volume.
3. Candles of a single color.
4. Little to no retracement.
5. Easily through prior day's high/low.

When all five align, ride the trade aggressively. These days are rare -- capitalize on them.

### Mental Stops vs. Hard Stops
Professional traders use mental stops. They allow flexibility to read price action in real time. However, new traders should use hard stops until they are experienced enough to trust their own discipline.

Place stops at technical levels (VWAP, SMA, horizontal support), NOT at arbitrary dollar amounts or percentages.

---

## Scratching Trades

When to scratch (exit at breakeven):
- The trade went nowhere for an extended period (time stop).
- Your thesis is weakening but not fully invalidated.
- You need buying power for a better opportunity.
- The market shifted to chop and your trade is stuck in noise.

Scratching is not failure. It is capital preservation. Breakeven beats a loss every time.

---

## Managing Losing Trades

### The Core Tension
"Cut your losers early" vs. "Lean on the daily chart and give the trade room." Both are correct -- the question is WHICH trade deserves which treatment.

### The Balance Rule
If you are willing to hold a losing trade through a $2 drawdown, you must be equally willing to hold a winning trade through a $2 run. Most traders do the opposite -- they have blind faith in losers and zero faith in winners.

### The Math Test (HSeldon2020)
For any trade, calculate: at your profit target and stop level, what win rate do you need to break even?

Formula: Required win rate = |loss| / (|loss| + target)

If the required win rate exceeds what your setup historically delivers, either raise your target or tighten your stop.

### The Decision Framework
When a trade goes against you, ask:
1. Has the stock violated any technical level that was part of your thesis? If yes: **exit.**
2. Has the stock lost its relative strength/weakness to SPY? If yes: **exit.**
3. Is the daily chart still intact? If yes: you have room to hold.
4. Would you enter this trade right now at this price? If no: **exit.**

---

## Source Articles

- "5 Rules on How Long To Wait to Trade the Market Open" (HSeldon2020)
- "Avoid Trading the First 30 Minutes - Here's Why" (OptionStalker)
- "Monday Morning - Be Patient" (HSeldon2020)
- "How To Trade the Open" (OptionStalker)
- "Entries - Exits - Stops - Position Size" (HSeldon2020)
- "My 5 Step-By-Step Process Before Entering into a Trade" (HSeldon2020)
- "One Question to Ask Yourself Before Making A Trade" (HSeldon2020)
- "How To Size Your Positions" (OptionStalker)
- "How To Size Your Positions - Examples From Friday" (OptionStalker)
- "Reasons to Exit a Trade" (HSeldon2020)
- "Exits - Entries - Thought Process - 3 Trade Examples" (HSeldon2020)
- "5 Tips For Exiting Trades" (OptionStalker)
- "Is There Ever A Time When You Should Average Down?" (HSeldon2020)
- "Take the Loss or Stay in the Trade - The Eternal Question" (HSeldon2020)
- "When To Let Your Trades Run!" (OptionStalker)
- "Stop focusing on the Noise - Find the Signal" (HSeldon2020)
- "Should I Take My Loss or Pivot?" (OptionStalker)
- "Staying Focused in Chop" (HSeldon2020)
