# Tools, Platforms & Trading Setup

Your tools should serve one purpose: surface high-probability trades fast and keep you from missing what matters. This guide covers the platforms, scanners, indicators, and workflow tools used by RealDayTrading practitioners, organized by platform so you can build a setup that matches your stack.

---

## Platform Recommendations

### OptionStalker (OneOption)

OptionStalker is the scanner purpose-built for the RS/RW method. If HSeldon2020 had to pick one scanner to start with, this is it. The platform combines a pro chat room with scanning tools designed around relative strength and weakness. Royal Flush scans (green and red) are particularly valued for surfacing high-quality setups. The scanner also drives pre-market gap scans, Pop-Bull/Pop-Bear, and intraday momentum detection.

**Cost:** Subscription through oneoption.com (Pro ~$159/month or ~$999/year).
**Best for:** Primary scanner. Built specifically for the RS/RW strategy.

### TC2000

HSeldon2020 considers TC2000 "the single best charting software out there." Its killer feature is Flex Scans -- conditional, time-ordered scanning that no other platform matches. If you want to scan for stocks that made a 52-week high, retraced to the 8EMA on the daily, then made a new 52-week high, all with strong relative volume, and in that exact time order, TC2000 can do it. Volume Buzz is TC2000's built-in relative volume measure. Gold tier with data feeds is sufficient.

**Cost:** Gold plan recommended (~$25/month + data feeds).
**Best for:** Charting and conditional scanning. Heavy use among verified traders.

### ThinkorSwim (TOS)

TOS is free through TD Ameritrade/Schwab and has a powerful ThinkScript custom study language. The community has built an extensive library of custom indicators for it (RRS, RVOL, QuickCheck, volume candles). The main drawback is performance -- TOS is a Java application and becomes sluggish with many charts and custom studies. Running multiple instances across separate installs and tuning JVM memory settings helps significantly.

**Cost:** Free with brokerage account.
**Best for:** Custom indicators, scanning with ThinkScript condition wizard, paper trading alongside live.

### TradingView

TradingView has the best charting UI and runs in any browser. Its multi-timeframe overlay capability (plotting daily SMAs on a 5-minute chart) is a major advantage. The scanner is its weakness -- it lacks OR conditions and can't scan on custom indicators the way TC2000 or TOS can. Community members compensate by using external scanners (ZenBot, OptionStalker) and importing ticker lists into TradingView watchlists.

**Cost:** Free tier available; Premium tier needed for 8-chart grids (~$30/month).
**Best for:** Charting, layout flexibility, PineScript indicators. Pair with an external scanner.

---

## Scanner and Screener Setup

### Universal Scan Criteria

Regardless of platform, these base filters produce a workable universe of tradeable stocks (from IzzyGman's scan methodology):

- **Price per share:** $5+ (some traders use $10+)
- **Float:** at least 50M shares
- **Average daily volume:** at least 1.5M
- **Average true range:** at least $1.50
- **Relative volume (RVOL):** at least 1.5x (time-of-day adjusted, not cumulative)
- **Market cap:** $1B+ preferred

With these filters active, run these core scans throughout the session:

1. 52-week / all-time high and low
2. New high of day (NHOD) and new low of day (NLOD) on volume
3. D1 compression breakout (4+ daily candles minimum compression)
4. Strong D1 with all SMAs in order (SMA 200 < 100 < 50 < price, sustained RS, above VWAP, 3+ green candles)
5. Consistent green/red candles on increasing volume (3+ candles)
6. HA reversal and HA continuation patterns

Sort results by Volume Buzz / RVOL. Flip through charts eyeballing the D1 for clean patterns, then check the M5 for entry timing.

### TC2000 Scan Templates

lilsgymdan and onewyse shared extensively. Key templates:

**The "Everything Scanner"** (lilsgymdan) -- A single scan that finds any D1 tradeable chart doing SMA breaks, compression breaks, 3+ HA candles in a row, HA reversals, or strong trends. It further filters to show only results where the 5-minute chart has an HA reversal candle or two flat-bottom HA candles. Download and video walkthrough available.

**Scan layout structure:** Scanner results on the left with linked M5 and D1 charts on the right. RS/RW indicator at the bottom of each chart shows three lines: green (stock), yellow (sector), blue (SPY). When green is above yellow and yellow is above blue, you have "stacked" RS.

**Individual scan templates** (all from lilsgymdan's TC2000 shares):
- HOD/LOD -- Longs above yesterday's highs, shorts below yesterday's lows
- +/- VWAP -- Stocks crossing above or below VWAP during SPY pullbacks
- SMA Breaks -- Stocks crossing 50/100/200 SMA
- Compression -- Breaking above/below 5+ days of compression
- ATH/ATL -- All-time highs and lows
- HA Continuation -- 3+ flat-sided HA candles in a row on D1
- HA Reversal -- Flat HA, doji, opposite flat HA pattern on D1
- Volume -- Intraday stocks popping with 5-minute candle volume right now

**Multiple scans on one watchlist** (onewyse) -- TC2000 lets you add conditional scan columns to a single watchlist. Each column represents a different scan result, displayed as colored dots or checkmarks. Click any column header to sort that condition to the top. This replaces switching between 5-6 separate scans. Use a ~900-stock watchlist as the base, add columns for HA reversals (5M), HA reversals (D1), compression breaks, volume surges, etc.

**Bullish/bearish daily setups** (onewyse) -- Bullish: above 50 SMA, volume above 50-day average, price above 50-day high, price over $5. Bearish: below 50 SMA, below 50-day low. Small result set but effective for evening scanning and next-day continuation plays.

**"Volume Vision" template** (lilsgymdan) -- Candle brightness maps to volume. High-volume candles appear light, low-volume candles appear dark or invisible. Helps you "see through the noise" when drawing algo lines and identifying significant support/resistance zones.

### ThinkorSwim Custom Studies and Scanners

**RealRelativeStrength (RRS) indicator** -- Created by u/WorkPiece based on HSeldon2020's ATR-based RS formula. The core indicator for the TOS community. Uses a rolling 12-period ATR calculation (12 bars on M5 = 1 hour). Available as both a lower study and a watchlist custom column (1D, 30M, 5M timeframes). TOS share link: `http://tos.mx/FVUgVhZ`. Save it as "HSeldonRealRelativeStrength" if you plan to use the companion scanners.

**RRS Scanner** (community-built) -- Scan using the RRS study across multiple timeframes. Set D1 to >= 0.5 and 15M to >= 2.0 within 2-3 bars. Add RRS as custom columns (1D, 30M/15M, 5M) to your watchlist and sort by strength. TOS share links available for both RRS and RRW scanners with ATR variants. Typically returns 30-40 results; tighten timeframes if you get too many.

**RRS vs Sector indicator** (u/HurlTeaInTheSea) -- Shows stock, sector, and market power index all in one pane. Auto-selects the correct SPDR sector ETF for any S&P 500 stock. When the stock's line is above the sector's line, which is above the market's line, you have stacked RS. Available for both TOS and TradingView.

**Time-based Relative Volume (RVOL)** (u/HurlTeaInTheSea) -- Superior to simple volume-to-average ratios because it accounts for the intraday volume profile (mornings trade heavier than midday). Divides cumulative volume up to current time by average cumulative volume at that same time of day over the past N days (default 5). Above 1.0 = higher relative volume. Available for TOS and TradingView.

**QuickCheck indicator** (u/--SubZer0--) -- A dashboard that automates your pre-entry checklist. Shows colored boxes for: SPY direction, stock direction, RS/RW value, above/below VWAP, above/below yesterday's high/low, above/below daily SMAs, ATR, RVOL, and volume fill. Cyan = criteria met and aligned with market. Orange = criteria met but against market. Gray = not met. Use in a separate small window linked to your main chart. Available for both TOS (v1.5) and TradingView (v1.5).

**High/low volume candle highlighter** -- Colors candles based on volume intensity (lime for high-volume bullish, red for high-volume bearish). Makes drawing algo lines dramatically faster since you no longer need to constantly check the volume pane.

**PriceLevelMarker** (u/--SubZer0--) -- Auto-plots today's open/high/low, yesterday's close/high/low, 2-day-ago high/low, 52-week high/low, and 5-year high/low on intraday charts. Saves the tedium of drawing these levels manually.

**TOS performance tips:** Run multiple instances (one per monitor), increase JVM memory to 4-8GB, add `-Dsun.java2d.opengl=true` and `-Dsun.java2d.d3d=false` to vmoptions, trim custom columns in large watchlists, and limit custom indicator calculations to today's session only.

### TradingView Indicators and Layouts

**Research Layout** (u/Glst0rm) -- Watchlist on the left, M5 chart in the center, D1 chart on the right. M5 chart overlays daily 50/100/200 SMAs, prior day's high/low, and auto-drawn trendlines. Indicators: RRS graph, total volume, ATR%, RVOL, RVOL-to-SPY. Use "Import List" to paste comma-separated tickers from ZenBot or OptionStalker into the watchlist.

**8-Ticker Grid Layout** (u/Glst0rm) -- M5 charts for actively traded positions with all indicators included. Requires Premium TV tier.

**Sector + Internals Layout** (u/IzzyGman) -- Three-window setup: left wing shows IWM, TICK, QQQ, UVXY, TLT, VIX; right wing shows major sector ETFs; center has Main (SPY/ES + 6 active tickers) and Research tabs (strong/weak watchlists for rapid chart flipping).

**Key TradingView indicators from the community:**
- Real Relative Strength Graph (adapted from WorkPiece) -- PineScript v5, green/red fill
- Daily SMA and Prior Day Levels -- Plots D1 50/100/200 SMA and yesterday's OHLC on M5
- TrendLiner and TrendLines v2 -- Auto-draws support/resistance from pivot points
- Market First Buy/Sell Signals (u/Glst0rm/ZenBot) -- Entry/exit signals based on RS/RW, ADX, PSAR, EMAs, volume, and VWAP
- Stacked RS/RW Arrows (u/ZanderDogz) -- Arrows appear only when stock RS > sector RS > market RS and price is above VWAP
- Volume + RVOL by Time of Day (Zen) -- Raw volume bars with RVOL highlight threshold

### ZenBot Scanner (Free)

Built by u/Glst0rm specifically for the RDT community. Available at zenscans.com with a Windows app in the Microsoft Store.

**Features:** Pre-built scans for Top Long, Top Short, Strong ADX Trend, Price Pops, Big Candles, In the Gap, Bull/Bear Flags, VWAP Hard Rejection, D1 SMA breaks, and more. Custom scan builder with 50+ criteria including price, sector, RVOL, multi-timeframe RS/RW, Laguerre RSI, ADX, BBand width, EMA crosses, VWAP slope. Live news feed with Up/Down on News scans. Ticker search shows all matching scans and technical analysis in one view.

**Workflow integration:** Click "Copy" to copy scan symbols to clipboard, paste into TOS/TC2000/TV watchlists. Windows app auto-types selected tickers into your charting platform.

### Free Daily Screen (Google Colab)

u/RossaTrading2022 built a Python notebook that screens S&P 500 stocks against the "Keeping it Really Simple" criteria. Download the notebook, upload to Google Colab, adjust the end date, and run. Outputs long and short candidates based on daily chart structure. Good for evening prep work if you have no paid scanner.

---

## Setting Alerts

Set 10-20 alerts per day, both long and short. The key is making alerts meaningful -- they should trigger at points where a break would create a genuine trade signal, not just random price levels.

**Where to place alerts:**
- Confluence of horizontal resistance and downward-sloping trendline (breakout above = long signal)
- Upward-sloping algo lines from high-volume candles (break below = short signal)
- Just above/below ranges defined by multiple SMA, trendline, and horizontal levels
- D1 compression boundaries where a break in either direction would produce a trade

When an alert triggers, open the chart, check the market, and decide. If your alerts are placed at meaningful technical levels, most triggers will present a tradeable idea.

---

## Trading Journal: TraderSync

HSeldon2020 recommends investing in a journal before anything else. TraderSync is the community standard (Pro tier is sufficient).

### Journal Tag Taxonomy

Structure tags into categories using TraderSync's Custom Tags feature (Settings > Custom Tags > create category, add tags within it). Each category appears as a dropdown when logging trades.

**Mistake categories (three meta-levels):**
- **Mistake - Trade:** Should never have taken it (Against Market, Countertrend, Gambling, No RS/RW, Not Confirmed)
- **Mistake - Entry:** Trade was fine, entry was wrong (Chased, Did Not Wait for Pullback)
- **Mistake - Exit:** Trade was fine, exit was wrong (Held Loser Too Long, Cut Winner Short, Averaged Down)

**Emotion tags:** Fear, Greed, Hope, FOMO

**Setup tags:** Market conditions (Bullish Trend Day, Bearish Trend Day, High/Low Range Chop), RS/RW status, daily chart quality, volume, trade type (CDS, PDS, straight calls/puts, day trade, swing), and specific patterns (compression break, trendline break, bounce off support, in the gap).

**Mood tags:** Happy, Anxious, Depressed, On Tilt, Exhausted

After several months of tagged trades, filter by any combination to find your strengths and weaknesses. Example: "What is my win rate on straight calls with relative strength during bullish trend days?"

---

## Walk-Away Analysis and Expected Win Rate

### Walk-Away Analysis

Track what would have happened had you held positions longer. For each trade, record the P&L at your actual exit, then at 1 hour later, end of day, next day, and end of week. Over time this reveals whether you are cutting winners too short or holding losers too long. Use a spreadsheet with columns for each time horizon.

### Expected Win Rate Template

A Google Sheets template (by u/Oneclumsy_mfer) that calculates expected win rate for a range of price targets and stop-loss levels. Input your entry price, target, stop, and current win rate to see whether the trade's risk/reward math works. The break-even win rate formula: `(Loss / (Profit + Loss)) x 100`.

---

## Trading Business Plan

Your journal stats feed directly into a business plan. Include at minimum:

- **Goal:** Monthly/annual profit target
- **Hard costs:** Internet, subscriptions, software, data feeds (budget ~$5,500/year)
- **Win rate** (averaged over 1,000+ trades)
- **Average win and average loss per trade**
- **Average number of trades per day**
- **Expected daily profit** = (Win% x Avg Win) - (Loss% x Avg Loss) x Trades/Day
- **Expected annual profit** = Daily profit x 252 trading days

If the numbers do not align with the goal, the plan tells you exactly what to improve: increase win rate, decrease average loss, increase average win, or increase trade volume.

---

## Hardware and Environment

**Falcon Trading Systems** -- Custom-built trading computers recommended by HSeldon2020. Each system is configured with your trading software. Discount code for RealDayTrading members: `RealDTR`. Works on falcontradingsystems.com and tradingcomputers.com. Not necessary to start, but a quality investment for serious traders.

**Minimum setup:** A reliable computer with an SSD, decent GPU (for multi-monitor support at 4K), and enough RAM to run your trading platform without lag. Most traders use 2-4 monitors. A good office chair matters more than you think.

**Recommended monitor layout:**
- Monitor 1: SPY charts (D1 + M5), chat room, market heat map
- Monitor 2-3: Individual stock charts (D1 + M5 side by side, 2-4 stocks per monitor)
- Monitor 4: Scanner, broker order entry, open positions

---

## Priority Order for Spending

If you are just starting out, spend nothing. Use your broker's free tools, this wiki, and free scanners. When ready to invest:

1. **Setup** -- Computer, monitors, comfortable chair, good environment
2. **Trading journal** -- TraderSync or equivalent (~$15-30/month)
3. **Charting software** -- TC2000 Gold or TradingView Premium (~$25-30/month)
4. **Scanner/community** -- OptionStalker/OneOption when you are trading live consistently

---

## Source Articles

- "What Do I Pay For?" -- u/HSeldon2020
- "Services and Resources" -- u/HSeldon2020
- "TraderSync" -- u/HSeldon2020
- "How to Create Tags for your Trading Journal" -- u/HSeldon2020
- "Setting Alerts" -- u/HSeldon2020
- "Falcon Computer Systems" -- u/HSeldon2020
- "Scan settings I like to use" -- u/IzzyGman
- "Real Relative Strength Indicator" -- u/WorkPiece
- "Real Relative Strength to SECTOR Indicator" -- u/HurlTeaInTheSea
- "Time-based Relative Volume (RVol)" -- u/HurlTeaInTheSea
- "TOS Study to Highlight High/Low Volume Candles" -- u/codieNewbie
- "RRS/RRW Scanners - Think or Swim" -- community
- "Potential Fix for ToS Sluggishness" -- u/Jules-95
- "QuickCheck Indicator (TOS)" -- u/--SubZer0--
- "QuickCheck Indicator (TradingView)" -- u/--SubZer0--
- "PriceLevelMarker For ThinkOrSwim" -- u/--SubZer0--
- "Market First Buy/Sell Indicator" -- u/Glst0rm
- "Sharing my TradingView layouts" -- u/Glst0rm
- "My Layouts and Indicators - TradingView" -- u/IzzyGman
- "Stacked Stock/Sector/Market RS/RW Arrows" -- u/ZanderDogz
- "TC2000 rs/rw scan templates" -- u/lilsgymdan
- "TC2000 Everything Scanner" -- u/lilsgymdan
- "Updated TC2000 Layouts" -- u/lilsgymdan
- "Volume Vision TC2000 Template" -- u/lilsgymdan
- "Simple TC2000 scan for bullish/bearish setups" -- u/onewyse
- "TC2000 Multiple scan results on one watch list" -- u/onewyse
- "My TC2000 Setup" -- u/owensd81
- "ZenBot Scanner" series (4 posts) -- u/Glst0rm
- "Free daily screen using Google Colab" -- u/RossaTrading2022
- "Expected WR% Template" -- u/Oneclumsy_mfer
- "Trading Business Plan" -- u/anonymousrussb
- "Expanding Walk-Away Analysis - Template" -- u/anonymousrussb
- "TRADEXCHANGE" -- u/Professor1970
