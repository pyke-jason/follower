# Message Labeling Methodology

The definitive guide for how agents classify trading chat messages. Every labeling agent MUST follow this document exactly.

## Core Principle

**You are a careful human reader, not a regex engine.** Read the message. Understand what the trader is saying. If you're not sure, say you're not sure. Genuine ambiguity is a valid label.

## Evidence Hierarchy

1. **Message text** — what the trader actually wrote. This is primary.
2. **Badges** — structural metadata set by the trader. Long/Short = entry intent, Exit = exit intent. Badges are strong signal but the text tells you WHAT they're entering/exiting.
3. **Chat context** — surrounding messages from the same author can disambiguate. Query the database: `SELECT clean_text, badges, symbols, timestamp FROM messages WHERE author = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp`. Look at what the trader was doing before/after.
4. **Symbols array** — tickers extracted by ingestion. Usually correct but may miss tickers or include false positives.

## What to Label

For each message, produce:

```json
{
  "messageId": "...",
  "outcome": "SKIP" | "EXECUTE" | "AMBIGUOUS",
  "signals": [],      // empty for SKIP/AMBIGUOUS, populated for EXECUTE
  "notes": "...",      // explanation
  "confidence": "high" | "medium" | "low"
}
```

### SKIP — Not a trade signal
The message does NOT represent a trade the trader executed. Empty signals array.

### EXECUTE — Confirmed trade signal
The message represents a trade the trader executed. Signals array contains the trade details you can determine.

### AMBIGUOUS — Genuinely unclear
The message MIGHT be a trade but you cannot determine key fields with confidence. This is a valid and important label. Do NOT guess.

## Strategy Detection — Be Honest About What You Know

This is the hardest part. **"Long AAPL" is genuinely ambiguous** — it could be:
- Stock purchase at current price
- Call option (unspecified strike/expiry)
- Put option (contrarian — rare but possible)
- LEAP
- Spread

### When you CAN determine strategy:
- "Long AAPL calls" → CALL
- "Long AAPL $180 puts" → PUT
- "Long AAPL CDS 180/185" → CDS
- "Long AAPL 1,000 shares at $178" → STOCK
- "Long AAPL $178.50" → STOCK (price in stock range, no option keywords)
- "Short AAPL PDS 175/170" → PDS
- "Long AAPL lotto puts" → PUT (lotto = speculative buy)

### When you CANNOT determine strategy:
- "Long AAPL" → strategy: null (could be stock or options)
- "Long AAPL swing" → strategy: null (swing could be stock or options)
- "Short TSLA" → strategy: null (could be short stock or buying puts)
- "Added to NVDA" → strategy: null (what instrument?)

**When strategy is unknown, set `strategy: null` in the signal.** Do NOT default to STOCK. The whole point of this audit is to find where the parser guesses wrong.

### Strategy clues from price:
- Price >= $10 with no option keywords → VERY LIKELY stock, but label as `strategy: "STOCK"` with `confidence: "medium"`
- Price < $5 → could be option premium or penny stock. Label strategy: null unless context clarifies
- Price with decimal (e.g., "$3.72") near "for" keyword → likely option premium
- Comma-separated quantity ("1,000", "500") → STOCK (high confidence)

## Direction Semantics — Read Carefully

Direction means: is the trader BUYING or SELLING the instrument?

| Message Pattern | Direction | Strategy | Why |
|----------------|-----------|----------|-----|
| "Long AAPL calls" | LONG | CALL | Buying calls |
| "Short AAPL puts" | LONG | PUT | "Short" is bearish VIEW, but they're BUYING puts |
| "Sold AAPL puts" | SHORT | PUT | Selling puts for premium (sell-to-open) |
| "Shorting AAPL" | SHORT | STOCK | Short selling stock |
| "Wrote AAPL calls" | SHORT | CALL | Writing/selling calls |
| "Bought back short calls" | — | — | This is closing a SHORT position (LEG_OFF or CLOSE) |
| "Lotto AAPL puts" | LONG | PUT | Lotto = speculative buy, always LONG |

**When badge and text disagree on direction:**
- Short badge + "puts" (no "sold"/"wrote") = LONG direction (buying puts, bearish view)
- Long badge + "sold puts" = SHORT direction (selling puts for income, bullish view)
- The BADGE tells you the trader's MARKET VIEW. The TEXT tells you the INSTRUMENT ACTION.

## Action Classification

### With Exit badge:
- Default: CLOSE
- Fraction/percent in text ("half", "1/3", "50%"): TRIM
- "leg off" / "hold straight calls" / "keep the puts" / "bought back short calls": LEG_OFF
- Read carefully for partial vs full exit language

### With Long/Short badge (no Exit):
- Default: OPEN
- "adding" / "added" / "added more": ADD
- Rare exceptions: paper trades, commentary about existing positions

### No badge:
- Look for CONFIRMED past-tense action verbs: "bought", "sold", "opened", "closed", "exited"
- "Buying" (present tense) is usually prospective intent, not confirmed fill
- "Selling off" is market commentary, not personal trade
- **Be very conservative.** Most badgeless messages with tickers are commentary.

## Using Chat Context

When a message is ambiguous, query surrounding messages from the same author:

```sql
SELECT clean_text, badges, symbols, timestamp
FROM messages
WHERE author = '[author]'
AND timestamp BETWEEN datetime('[timestamp]', '-2 hours') AND datetime('[timestamp]', '+2 hours')
ORDER BY timestamp
```

Context helps with:
- **Strategy clarification**: If the author's previous message says "Long AAPL $180 calls" and this one says "Adding to AAPL", you know the ADD is for CALL strategy
- **Exit matching**: If they posted "Long AAPL CDS" earlier and now say "Exit AAPL for profit", the exit is on a CDS
- **Multi-part trades**: Some traders split entries across messages

## Edge Cases

### Expired worthless
- With Exit badge: label as EXECUTE with action CLOSE, notes "expired-worthless"
- Without Exit badge: SKIP (informational)

### Paper trades
- Always SKIP regardless of badges

### Futures (/ES, /NQ, /RTY)
- Always SKIP — system doesn't trade futures

### Position updates ("still holding AAPL")
- SKIP — no new action

### Price targets ("my target is $200")
- SKIP — analysis, not action

### Congratulations ("nice trade on TSLA")
- SKIP — social, not action

### Multi-signal messages
- "Exit Long DXCM $80 ... Exit Short ELF $135" → TWO signals, both CLOSE
- "Bought AAPL calls and TSLA puts" → TWO signals, both OPEN
- Create separate signal objects in the array

### Strangle/straddle
- "Long strangle AAPL 180c/175p" → TWO signals: OPEN CALL + OPEN PUT
- Or label as single signal with strategy: "STRANGLE" if you prefer

## Output Quality

- **Never hallucinate symbols.** Only use tickers from the `symbols` array or explicitly mentioned in text.
- **Never hallucinate strikes/expiry.** Only include if explicitly stated.
- **Explain your reasoning** in the notes field, especially for non-obvious cases.
- **Mark confidence honestly.** High = obvious from text. Medium = reasonable inference. Low = educated guess.
- **AMBIGUOUS is always better than a wrong EXECUTE.** When genuinely unsure, use AMBIGUOUS.
