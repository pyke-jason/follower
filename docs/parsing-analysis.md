# Parsing Analysis: Code vs Real Messages

Analysis of `src/parsing/` against 23,573 real messages from `trade-follower-2/data/trades.db`.

## Architecture Overview

```
Message HTML → classifyMessage() → badges, symbols, strategy, confidence
                                       ↓
                          factory.ts creates task (if tracked trader + has badges)
                                       ↓
                          runner.ts → runAgent() (ALWAYS, regardless of confidence)
                                       ↓
                          Agent gets: cleanText, badges, symbols, strategies, confidence
```

**Key finding:** `factory.ts` sends ALL badged tracked-trader messages to the agent. The `needsAgent` flag only sets `taskType` to `EXECUTE_TRADE` (>=0.7) vs `REVIEW_MESSAGE` (<0.7) — but `runner.ts` processes both identically. So confidence scoring is currently informational only.

## What Works Well

### 1. Noise filtering (badges.ts + classify.ts)
The no-badge skip is the highest-value piece. ~90% of messages are commentary, greetings, and analysis with no badges. These are correctly skipped.

### 2. Symbol extraction (symbols.ts)
All trade messages use `<a data-symbol="TICKER">` consistently. CSS selector `[data-symbol]` catches them all.

### 3. Badge extraction (badges.ts)
Real badges are always `<span class="badge bg-success|bg-danger|bg-primary">Long|Short|Exit</span>`. Maps cleanly to BADGE_MAP. Action/direction inference logic is correct.

### 4. Blockquote removal (html.ts)
Many messages contain quoted replies with trade language. Removing `<blockquote>` prevents false matches from quoted text.

### 5. Paper trade filtering (classify.ts)
`/\(paper\)/i` correctly catches paper trade annotations.

## What Doesn't Work Well

### Issue 1: Stock price extraction grabs wrong numbers

**Code (strategy.ts:92):** `text.match(/\$?([\d,]+\.?\d*)/)`

This grabs the FIRST number in the text. Works for entries but breaks on exits with loss/profit amounts:

| Message | Price extracted | Correct? |
|---------|---------------|----------|
| `Long ABBV $231.92` | 231.92 | Yes |
| `Short BMY 44.18` | 44.18 | Yes |
| `Short AMZN $211.64 - 1,000` | 211.64 | Yes |
| `Exit Long KTOS Sold half $5 a share profit` | **5** | **NO** ($5 is profit, not price) |
| `Exit Long TLRY $12.06 for $.20 loss` | 12.06 | Yes (first match is correct) |
| `Exit Long AMZN from a few days ago for profit` | No number | OK (goes to agent) |

**Fix:** For stock trades, prefer `$`-prefixed numbers. When the only number appears in a loss/profit/gain context, set price to undefined.

### Issue 2: extractPrice misses trailing prices for options

**Code (strategy.ts:18):** `PRICE_PATTERN = /(?:for|at|@)\s*\$?(\d+\.?\d*)/i`

Requires `for|at|@` before the price. Real option trades often have bare prices after the strike:

| Message | Price extracted | Correct? |
|---------|---------------|----------|
| `625 call 8.65` | **undefined** | **NO** (8.65 is the price) |
| `160c 2.75` | **undefined** | **NO** (2.75 is the price) |
| `CDS $180/$190 for $2.56` | 2.56 | Yes |

**Fix:** Add fallback `TRAILING_PRICE = /(?:calls?|puts?|c\b|p\b)\s+\$?(\d+\.?\d*)\b/i`

### Issue 3: Slash-date expiry not parsed

**Code (strategy.ts:26):** `EXPIRY_SLASH` exists but is intentionally disabled (line 138: "too ambiguous with strikes like 570/565").

Real messages use slash dates: `160c 10/17` → expiry should be October 17.

| Message | Expiry extracted | Correct? |
|---------|-----------------|----------|
| `160c 10/17` | **undefined** | **NO** |
| `Dec 19 call` | 2026-12-19 | Yes |

**Fix:** Enable `EXPIRY_SLASH` but ONLY for CALL/PUT strategies (not CDS/PDS where slashes denote strikes). Pass strategy type to `extractExpiry()`.

### Issue 4: Share quantity without "shares" keyword

**Code (strategy.ts:22):** `QTY_SHARES_PATTERN = /([\d,]+)\s*shares?/i`

Real messages use `- 1,000` without "shares":

| Message | Qty extracted | Correct? |
|---------|--------------|----------|
| `Short AMZN $211.64 - 1,000` | **undefined** | **NO** (1,000 shares) |
| `1,000 Shares` | 1000 | Yes |

**Fix:** Add fallback `QTY_DASH = /[-–]\s*([\d,]+)\b/`

### Issue 5: Exit messages with strategy names but no strikes

`Exit Short META PDS - $4.85 loss` — mentions "PDS" so `hasOptionsKeywords` is true, blocking stock detection. PDS pattern requires strikes which aren't present. Result: no strategy detected, confidence 0.6.

**Current behavior is actually correct** — this gets routed to the agent with low confidence. No fix needed.

### Issue 6: Partial exits not modeled

`Exit Long KTOS Sold half $5 a share profit` — "Sold half" indicates a partial position close. The system has no concept of partial exits.

**Not critical for v0** — the agent can interpret "Sold half" from the clean text.

## Real Message Test Cases

These are actual messages from the database, classified by what the parser should produce:

### Stock entries (should detect STOCK strategy)
```
"Long ABBV $231.92"
  → STOCK, price=231.92, action=OPEN, direction=LONG

"Short BMY 44.18 - got two longs on and want to add a short to the mix"
  → STOCK, price=44.18, action=OPEN, direction=SHORT

"Short AMZN $211.64 - 1,000 Break of both the 200 SMA and the Trendline"
  → STOCK, price=211.64, qty=1000, action=OPEN, direction=SHORT

"Long CSIQ 21.11 broke through previous HOD/Resistence with volume"
  → STOCK, price=21.11, action=OPEN, direction=LONG
```

### Stock exits (should detect STOCK strategy, action=CLOSE)
```
"Exit Long TLRY $12.06 for $.20 loss. No staying power."
  → STOCK, price=12.06, action=CLOSE, direction=LONG

"Exit Long AMZN from a few days ago for profit"
  → STOCK, price=null (not stated), action=CLOSE, direction=LONG

"Exit Long KTOS Sold half $5 a share profit"
  → STOCK, price=null (ambiguous - $5 is profit), action=CLOSE, direction=LONG

"Exit LMT 468.18"
  → STOCK, price=468.18, action=CLOSE, direction=null (no Long/Short badge)
```

### Options exits
```
"Exit Short META PDS - $4.85 loss"
  → strategy=PDS (mentioned but no strikes), action=CLOSE, direction=SHORT
  → Current parser: no strategy (correct routing to agent)

"CRWV taking a few off 160c 10/17 Long Exit 2.75 setting up nicely n hold well atm."
  → CALL, strike=160, price=2.75, expiry=10/17, action=CLOSE, direction=LONG
  → Current parser: CALL detected, but price=undefined, expiry=undefined
```

### Non-trades with badges (noise — should still be classified)
```
"Exit Long AMZN from a few days ago for profit"
  → trade signal (exit), but vague — agent should look up open position
```

### Non-trades without badges (should be skipped)
```
"Good morning"                                → skip (no badges)
"NVDA held strong on the TL of a BF"         → skip (no badges)
"DELL took off like a rocket..."              → skip (no badges)
"NKE still good short"                        → skip (no badges, even though it mentions a direction)
"AVGO potential short"                        → skip (no badges)
```

## Confidence Scoring Walkthrough

For `Long ABBV $231.92`:
- badges = ["Long"] → baseline = **0.3**
- symbols = ["ABBV"] → + **0.2** = 0.5
- STOCK detected (confidence 0.8) → + 0.8 * 0.4 = **0.32** = 0.82
- actionHint = OPEN → + **0.1** = 0.92
- **Result: 0.92, needsAgent = false, taskType = EXECUTE_TRADE**

For `Exit Short META PDS - $4.85 loss`:
- badges = ["Exit", "Short"] → baseline = **0.3**
- symbols = ["META"] → + **0.2** = 0.5
- No strategy detected → + **0** = 0.5
- actionHint = CLOSE → + **0.1** = 0.6
- **Result: 0.6, needsAgent = true, taskType = REVIEW_MESSAGE**

For `Exit Long KTOS Sold half $5 a share profit`:
- badges = ["Exit", "Long"] → baseline = **0.3**
- symbols = ["KTOS"] → + **0.2** = 0.5
- STOCK detected (confidence 0.8, price=5 WRONG) → + **0.32** = 0.82
- actionHint = CLOSE → + **0.1** = 0.92
- **Result: 0.92, needsAgent = false — but price is wrong!**

## Message Format Reference

All messages from the database follow this HTML structure:

```html
<!-- Stock entry with badge -->
<span class="badge bg-success">Long</span>&nbsp;
<a href="/option-stalker/chart/ABBV" target="os" data-symbol="ABBV" data-criteria="Bull">
  <b>ABBV</b>
</a>&nbsp;$231.92

<!-- Exit with two badges -->
<span class="badge bg-primary">Exit</span>&nbsp;
<span class="badge bg-success">Long</span>&nbsp;
<a href="/option-stalker/chart/TLRY" target="os" data-symbol="TLRY">
  <b>TLRY</b>
</a> $12.06 for $.20 loss

<!-- Commentary (no badges) -->
<div>
  <a href="/option-stalker/chart/NVDA" target="os" data-symbol="NVDA">
    <b>NVDA</b>
  </a> held strong on the TL of a BF
</div>

<!-- Message with blockquote (quoted reply) -->
<div>D1 has been crushed since we made peace with China...
  <blockquote>
    <b data-user="Excelsior">@Excelsior</b>: Not exactly the prettiest D1 chart
  </blockquote>
</div>

<!-- Options trade with inline badges -->
<div>
  <a data-symbol="CRWV"><b>CRWV</b></a> taking a few off 160c 10/17
  <span class="badge bg-success">Long</span>
  <span class="badge bg-primary">Exit</span>
  <span>&nbsp;2.75 setting up nicely</span>
</div>
```

Key HTML patterns:
- Badges: `<span class="badge bg-{success|danger|primary}">{Long|Short|Exit}</span>`
- Symbols: `<a data-symbol="TICKER" data-criteria="{Bull|Bear}"><b>TICKER</b></a>`
- User mentions: `<b data-user="username">@username</b>`
- Quoted replies: `<blockquote>...</blockquote>`
- Non-breaking spaces: `&nbsp;` between badges and symbols

## Database Stats (trade-follower-2)

- Total messages: 23,573
- Messages with badges (approximate): ~10-15% based on sampling
- Most common trade type: Simple stock entries/exits
- Options trades (CDS/PDS/calls/puts): Rare in sampled data
- Tracked traders vary — filtering happens in `factory.ts`
