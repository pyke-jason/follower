# Parse Instructions

How traders in this chat room communicate trades. Every example is a real message. This is the source of truth for interpreting trade messages.

## Core rule: "Long" and "Short" mean bullish and bearish

The posting convention is to express your **bias on the underlying**, not whether the instrument is a debit or credit.

- "Long" = bullish bet on the stock
- "Short" = bearish bet on the stock

This applies even when the mechanics seem contradictory:
- `Long OKLO sold Oct (17) $95 put @ $4.70` — selling puts is bullish, so "Long"
- `Short NVDA PDS $170/$167.50` — PDS profits from decline, so "Short"
- `Long GLW pcs 68/67 for .63 credit` — PCS profits from stock staying up, so "Long"

"Long" and "Short" do NOT tell you the instrument. You need additional clues.

## Determining the instrument

**"Long NVDA" could be any of these:**

| Message | Instrument | Clues |
|---------|-----------|-------|
| `Long NVDA` | Unknown | No clues at all — could be stock, calls, or a spread |
| `Long NVDA 173.38` | Stock | Just a price, no options language |
| `Long NVDA using $173 Calls for $11.90 - 10 Contracts` | Calls | "Calls", strike, contracts |
| `Long NVDA $172.50/$177.50 CDS for $1.10` | Call debit spread | Two strikes with slash, "CDS" |
| `Long NVDA sold $175/172.50 PCS $.52 cr` | Put credit spread | "PCS", "cr" (credit) |
| `Long NVDA lotto 190c @ .55` | Calls | Strike+C suffix, "lotto" |

**"Short NVDA" could be any of these:**

| Message | Instrument | Clues |
|---------|-----------|-------|
| `Short NVDA` | Unknown | No clues — could be stock short, puts, or a spread |
| `Short NVDA $175.44 - 1,000 Shares` | Stock short | "Shares", no options language |
| `Short NVDA using $160 Puts for $5.50 - 15 Contracts` | Buying puts | "Puts", strike, contracts |
| `Short NVDA PDS $312.5/$307.5 for $1.99` | Put debit spread | Two strikes, "PDS" |
| `Short RDDT 4/4 119p @ 14.65` | Buying a put | Date, strike+P suffix |

**The clues:** strike prices, slash between strikes (= spread), strategy name (PDS/CDS/PCS), "C"/"P"/"calls"/"puts", "credit"/"cr"/"debit"/"Db", expiry dates, contract counts, "Shares".

When none of these clues are present (e.g., `Long TSLA`), the instrument is unknown. Don't guess — it could be stock, calls, or a spread depending on the trader and context.

## Spread structures

**PDS (Put Debit Spread)** — bearish. Buy the higher-strike put, sell the lower-strike put. Pay a debit.
- `Short TSLA PDS $445/$440 for $1.78` — strikes listed high/low
- `Short COST $905/$900 for $1.90 - PDS`
- `Short GEV pds 565/562.5 for 1.00`
- `Short CVNA 310/305 2.23` — no strategy name, but two strikes = spread

**CDS (Call Debit Spread)** — bullish. Buy the lower-strike call, sell the higher-strike call. Pay a debit.
- `Long META CDS $755/$765 for $3.64` — strikes listed low/high
- `Long CRSP 71/73 cds for .75`
- `Long PLTR cds for next weeks expiration 130/132 for .80`

**PCS (Put Credit Spread)** — bullish. Sell the higher-strike put, buy the lower-strike put. Collect a credit. Also called **BPS** (Bull Put Spread) — same thing.
- `Long TSLA sold Oct (17) $400/395 PCS for $1.00 cr.`
- `Long GLW pcs 68/67 for .63 credit`
- `Long CRWV BPS $90-$85 expires next week for $1.05`

**CCS (Call Credit Spread)** — bearish. Rare.
- `Short TSLA ccs jan 02 505/510 for 1.05 credit`

**"Sold" language in PCS/BPS is normal** and doesn't conflict with "Long":
- `Long AMZN Sold Dec (5) $227.50/225 PCS for $.42 Cr` — "Sold" describes the spread mechanics, "Long" describes the bullish bet.

**Strikes without a strategy name** still mean a spread when there are two prices separated by a slash:
- `Short CVNA 310/305 2.23` — PDS (bearish, puts)
- `Short AAPL 5/30 195/200 PDS for 2.3`

## Sold puts as bullish trades (Pete's signature)

Pete sells puts as a bullish income strategy. He prefixes with "Long" because his bias is bullish:
- `Long OKLO sold Oct (17) $95 put @ $4.70`
- `Long BE sold Oct (17) $59 put $2.40`
- `Long IREN Sold Oct (17) $37 puts @ $1.50`
- `Long QS via selling the Sept (19) $9.50 puts @ $.50`
- `Long HTZ Sold May (9) $4.50 puts @ $.20 naked`

This is NOT closing a put. It's selling-to-open. The "Long" + "Sold puts" combination is a new bullish position.

Other traders also do this:
- `Long CIFR sold the 3/6 $14 puts for $0.24` (Joshh)
- `Long IREN sold the 12/19 $40 puts for a credit of $1.15/contract` (spectre)

## Buying puts as bearish trades

"Short" + "Puts" means BUYING puts (bearish bet):
- `Short ABNB using $127 Puts for $5.55 - 25 Contracts`
- `Short SPY using 0DTE $629 Puts for $1.57`
- `Short Bought QCOM Nov (21) $160 puts $12.25`
- `Short CVS - 61P EXP 5/30 - $2.90`

## WATM (Write ATM)

A diagonal put spread — sell a near-term ATM put, buy a farther-dated lower-strike put. Dave W's signature strategy:
- `Long SOFI WATM sell nov 14 $30 puts buy dec 19 $27 puts for .36`
- `Long M WATM using next weeks $18 puts short and nov 21 $17 puts long`
- `Long KSS WATM sold dec 12 23.50 puts and bought jan 16 $21 puts for .16`

## Strangles, straddles, and time spreads

These use the **"Long Short"** prefix (both directions simultaneously):
- `Long Short SPY Strangle - Bought the $673 Calls and $670 Puts expires tomorrow`
- `Long Straddle on MSTR using $182.5 Calls and Puts for $7.66`
- `Long Short HPE time spread using $23 calls for .09`
- `Long Short BABA straddle`

"Long Short" is NOT contradictory — it means the trade has both a long and short component. Some traders reverse it: `Short Long MCHP 50 strike time spread`.

## Exit patterns

### Standard formats (by frequency)

| Format | Example | Frequency |
|--------|---------|-----------|
| Exit Long SYMBOL | `Exit Long TSLA @348.99, 5.77 gain` | 44% |
| Exit Short SYMBOL | `Exit Short DASH 238.56$` | 25% |
| Exit SYMBOL (no direction) | `Exit NVDA for a quick .80` | 19% |
| Short Exit SYMBOL | `Short Exit TSLA 402.15 ($1.18 gain)` | 6% |
| Long Exit SYMBOL | `Long Exit MSTR 168.03 ($1.64 gain)` | 5% |
| Exit Long Short SYMBOL | `Exit Long Short SPY took nice profits on strangle` | <1% |

The direction word matches the **original position's** directional view:
- `Exit Long TSLA pcs took .50 profit` — closing a PCS opened with "Long"
- `Exit Short NVDA PDS` — closing a PDS opened with "Short"

### Concatenated / no-space variants
- `ExitLong ARM @ 134.86, 0.9 gain`
- `ExitShort TEAM - $224.66`
- `Exit CTRALong .10 gain` — direction appended to symbol

### Exits without the "Exit" keyword
- `Bought back the short Puts on NVDA PDS` — closing spread leg(s)
- `Bought back the short Calls on META holding the long Calls` — closing one leg, keeping the other
- `took profits GEV`
- `Closed IREN PCS (40/35) for roughly 20% gain`
- `Out of 1/2 of WFC for 50 cents`
- `ACHR puts expired worthless last Fri.`
- `Exit GOOG the 212.5 calls I sold expired in the money, so my shares got called away`

### Profit and loss language

**Percentages are the RETURN on the trade, not the fraction exited:**
- `Exit Long GE cds for 50% profit` — made 1.5x return
- `Exit Short LULU took profits in pds 50% profit` — 50% return
- `Exit Long JPM lottos for 180% gain` — nearly 3x return

**Dollar amounts:**
- Per share: `$5.77 gain`, `$1.10 loss`, `for a quick .80`
- Per contract: `.60 profit per contract (10)`
- Cents: `(48c gain)`, `(5c scratch)`

**Named outcomes:**
- "scratch" / "b/e" / "breakeven" = exited at roughly entry price
- "stopped" / "stopped out" = stop loss triggered
- "expired worthless" = option expired OTM
- "called away" / "assigned" = options exercise

### Partial exit language

These words signal exiting only part of a position:
- **Fractions:** "half", "1/2", "1/3", "1/4", "2/3", "3/4"
- **"trim":** `Exit Long trim 1/2 JOBY 17.15`, `Long Exit heavy trim NET 176.52`
- **"partial":** `Exit Short CVNA $337.40 (partial profits)`
- **"leaving":** `Exit Long APP 348.98 leaving just a tiny token`
- **"still holding" / "still have":** `Exit Short C $1.20. Still have majority on`
- **"rest of" (closing remaining):** `Exit Long HOOD rest of the position at $64.97`
- **"runners" / "down to runners":** `Exit Long DAL down to runners at $75`

Without any of these words, an exit is a full close.

### Multiple exits in one message
- `Exit Long PM $182.03 Exit Long PLTR $131.64`
- `Exit NVDA $2.20 per share (1,500) Exit AMZN with $2.90 profit per share (1,000)`

### Exit + open in same message
- `Exit TXN with an .18 loss per share (1,000)Short TSLA $328.81 - 1,000 Shares` — no space between exit and new open

### Expired options sometimes not posted
Some traders don't post exits when options expire worthless: "I don't post exits on sold Puts that expire worthless either."

## Adding to positions

"Added", "Adding to", "add" — always refers to an existing open position:
- `Added 500 more shares to OSCR - 7,500 total - $20.21 avg`
- `Short AI added to short at $22.30 on new LOD`
- `Long MSFT added to pcs for 1.25 credit`
- `Long CHRW swing add, average $169.13 now 2x size`
- `Short PLTR $141.12. Add`

Adds differ from new opens because they mention "add/added/adding", reference an existing position, include an average price, or reference a total count.

## Re-entries

Traders re-entering a position they previously closed:
- `Short NVDA (again) $169.54 - 1,000 Shares`
- `Re-entering the TSLA short $333.98 - 1,000 Shares`
- `Long OPEN back in`
- `Long BABA (reentered at 136)`

## What is NOT a trade

### "Long" / "Short" as non-trade words

**Candle descriptions:** "Long" describing candlestick shape, not direction:
- `Long candles on the M5 for SPY starting at 12:45`
- `Long wicks and tails. This is an uncertain market.`
- `long green candle thru HOD`
- `long mixed candles on heavy volume`

**Duration/time:** `Long term investors use a buy and hold method`

**Watchlists:** `Long shortlist: INTC CIFR VRT WDC maybe EOSE`

**Education:** `Long or Short is the direction of your bias, not if you sold to open or bought to open`

### Market commentary mentioning symbols

These describe price action, NOT trade entries:
- `CLX hard breakdown below SMA 200 this week with very steady selling`
- `NVDA rw persistent selling this morning`
- `GDX has a nice TL breakout and heavy buying, new recent high`
- `really nasty selling in BROS thru the SMA 50`

### Pre-market bulletins

Pete's pre-market commentary starts with "PRE-OPEN MARKET COMMENTS" or "PRE OPEN MARKET COMMENTS." These are ALWAYS analysis, NEVER trade entries, regardless of how many tickers they mention. They are typically multi-paragraph.

### Hypotheticals and advice

These are NOT trades:
- `If I was short SBUX, this is where I would be looking to take gains`
- `I would consider ALAB as too extended for my taste`
- `If I were looking to put a starter position on for IREN I would sell the Oct (3) $43 put`

### Limit orders and alerts (intent, not execution)

- `I have a limit order in to sell SOUN for $.30 gain`
- `Offering VRT $265.76`
- `Alert set on HIMS < 200-day MA`

### Position updates (not new trades)

- `Holding my TSLA short overnight`
- `NVDA is working looking for a nice sell off`
- `still holding BE, really like how it's shaping up`
- `I can't watch TSLA so I have a $390 stop`

### Past tense recaps

- `I shorted MSTR and I was using BTC as a guide...`
- `CLF was my long pick of the day in the video`

### Questions and feedback requests

- Messages starting with "Question" or "Feedback Request"
- Messages ending with "View Answer" (Q&A threads)

## Expiration defaults

When no expiry is stated, default to the **closest Friday**.

Evidence:
- `Short ALGN pds` (opened Tuesday 9/2) → expiry Friday 9/5
- `Long META CDS $630/$640` (opened Tuesday 11/25) → expiry Friday 11/28
- `Short CHTR pds 195/192.5` (opened Monday 12/1) → expiry Friday 12/5

Trades opened on Friday with no expiry are ambiguous — could be same-day (0DTE) or next week.

### Expiry notation formats

Traders use many date formats:
- `10/17`, `9/19` — month/day slash
- `Oct (17)`, `Nov (21)` — Pete's month (day) format
- `oct 17`, `nov 14` — lowercase month name
- `EXP 5/30` — EXP keyword
- `0DTE` — same-day expiration
- `expiring tomorrow`, `next week`, `for friday`, `expiring today`
- `Dec 19 2025`, `3/31/2026` — full dates for LEAPs

## Strike and price notation

### Strikes
- With dollar sign: `$445/$440`, `$170`
- Without: `445/440`, `170`
- C/P suffix (very common for single legs): `7.5C` = $7.50 call, `119p` = $119 put, `330c` = $330 call. Case-insensitive.

### Prices
- `for $1.78` / `for 1.20` / `for .90`
- `@ $4.70` / `@8.25`
- `$.50` — dollar sign with leading dot
- `26c` — cents (as in `lotto 132 for 26c`)
- Credit explicitly labeled: `for .63 credit`, `$1.00 cr.`, `$.42 Cr`
- Debit sometimes labeled: `$2.07 debit per spread`, `Db`

### Position sizing
- Shares: `1,000 Shares`, `2,000`, `(1,500)`
- Contracts: `20 Contracts`, `15 Contracts`, `(10)`
- Relative: `2X`, `1/2 size`, `starter size`, `small`, `full size`

## Special terms

| Term | Meaning | Example |
|------|---------|---------|
| lotto | Cheap, near-expiry, OTM option. High risk/reward. | `Long TSLA $330 Call Lotto for .47` |
| starter | Small initial position, expecting to add later | `Long PDD $123.90 (starter position)` |
| swing | Multi-day hold | `Long KGC $22.59 swing starter` |
| day trade | Close by end of day | `Short CMG $38.82 day trade` |
| scalp | Very short hold, quick in-and-out | `Long TSLA 405.03 (scalp)` |
| paper | Simulated trade, not real money | `Short AVTR $11.35 - paper` |
| runner | Partial position left on after taking most profits | `Exit Long DAL down to runners at $75` |
| hedge | Offsetting risk from other positions | `Short /ES 6854. More as a hedge for short put positions` |
| spec | Speculative, higher risk | `Long PGY spec trade on massive gap fill` |
| UOA | Unusual Options Activity (scanner signal) | `Long PINS 40c @ 1.05 UOA spec size` |
| tight leash | Very tight stop, watching closely | `Long RBLX $128.40 on a tight leash` |
| overnight | Holding through at least the next open | `Long SPY for overnight` |
| joined | Following another trader's trade | `Long TSLA joined the 400/395 pcs` |
| naked | Sold option without a protective hedge | `Long HTZ Sold May (9) $4.50 puts @ $.20 naked` |
| 0DTE | Zero days to expiration, same-day options | `Short SPY 0DTE using $668 Puts` |

## Trader-specific conventions

**Hariseldon** (most active) — Very structured. Always includes share/contract count. Dash-separated fields.
- Shares: `Long TSLA $311.83 - 1,000 Shares`
- Options: `Short NVDA using $160 Puts expiring Friday for $5.50 - 15 Contracts`
- Spreads: `Short NVDA $170/$167.50 - PDS - for .90 - 30 Contracts`
- Exits: `Exit TSLA with $1.14 profit per share (1,000)` — no direction word

**Dave W** (second most active) — Terse. Often omits price and size entirely.
- Bare: `Long ORCL`, `Short CNC`, `Long MP`
- WATM specialist, time spread specialist
- Uses "with Hari" / "joined Hari" to co-trade

**Pete** (third most active) — Distinctive sold-put style with Month (Day) expiry format.
- Sold puts: `Long OKLO sold Oct (17) $95 put @ $4.70`
- PCS: `Long TSLA sold Oct (17) $400/395 PCS for $1.00 cr.`
- Futures: Only trader using `/ES` and `/NQ` regularly
- Always provides rationale

**tradervik/Tobias** — Direction BEFORE exit: `Long Exit MSTR 168.03 ($1.64 gain)`, `Short Exit TSLA 402.15 ($1.18 gain)`

**Khorn** — Compact strike+suffix: `Long NVDA 190c lottos @ 3.12`, `Short RDDT 4/4 119p @ 14.65`

**spectre** — Detailed reasoning on every entry and exit. Uses "at" for price: `Short AAPL at $207.45`

## Edge cases

**Ticker symbols that are English words:** OPEN, BE, W, C, BULL — can be confused with common words.

**Concatenated exit+open:** `Exit TXN with an .18 loss per share (1,000)Short TSLA $328.81` — no space between messages.

**Multi-trade messages:** Some posts contain multiple trades or an exit and new open together.

**Late posts:** `Exit Long APP 499. Entry was 481.6. Sorry late post.`

**"Legged out":** Closing one side of a spread: `Exit MSFT 480/475 PDS; legged out and managed a scratch`

**Futures:** Prefixed with `/`: `/ES`, `/NQ`, `/MES`. Only a few traders use these.

**Leveraged ETFs as proxies:** `NVDL` (2x NVDA), `TSLL` (2x TSLA), `AAPU` (2x AAPL) — treated as stock trades.

**Covered calls:** `Sold the $260 Calls on AAPL for $1.03 - covered calls` — selling calls against existing long stock.
