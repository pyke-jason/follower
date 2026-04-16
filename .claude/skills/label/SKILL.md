---
description: Label chat messages with ground-truth intent classification for the eval golden dataset. Use when asked to label, audit, review, or verify eval labels.
user-invocable: true
argument-hint: "[audit | stats | <message-id>]"
---

# Eval Labeling

You are the ground-truth labeler for a trade-copy system's message classifier.
Goal: Produce labels accurate enough to measure whether the automated parser is right or wrong. Every label you write becomes part of the golden dataset that eval scores are computed against — a wrong label here is worse than no label.
Audience: The eval pipeline compares your labels to the parser's output. They must be precise, consistent, and justified.
If unsure: When a message is genuinely ambiguous (could reasonably be trade or non-trade), set `confidence: LOW` and explain the ambiguity in `reasoning`. Do not guess — a LOW-confidence label with honest reasoning is far more useful than a wrong HIGH-confidence one.

## Usage

- `/label` — label next batch of unlabeled messages
- `/label <message-id>` — label or relabel a specific message
- `/label relabel [N days]` — bulk relabel existing labels via Anthropic API (default: 30 days)
- `/label audit` — audit existing labels for systematic errors
- `/label stats` — show labeling progress and quality metrics

## Domain Knowledge (read before first session)

These files contain every trading communication pattern you need. Read them in full before labeling:
- `docs/rails/parse_instructions.md` — trader conventions, spread types, exit language, what is NOT a trade
- `.claude/rules/orchestrator.md` — direction semantics, parser routing logic

## Schema

The label uses `Signal` from `src/agent/schemas.ts`. Read it for the Zod definition. Summary:

```
Signal {
  action: OPEN | CLOSE | ADD | TRIM | LEG_OFF
  symbol: string
  direction: LONG | SHORT | null        // market bias from badge; null = unknown
  strategy: STOCK | CALL | PUT | CDS | PDS | PCS | CCS | null  // null = unknown instrument
  strikes: number[] | null              // [332.5] single option, [190, 192.5] spread
  expiry: string | null                 // as stated: "Oct (17)", "next week", "5/23"
  statedPrice: number | null            // premium, credit, or stock entry price
  quantity: number | null               // shares or contracts
  exitPercent: number | null            // TRIM: 0.5 = half
  targetStrategy: Strategy | null       // LEG_OFF: what remains after removing a leg
}
```

The label wraps Signal[][] with metadata (`EvalLabelData` in `src/db/schema.ts`):
```
EvalLabelData {
  reasoning: string        // Why you classified this way (MUST be written first)
  isTrade: boolean         // Is this an actionable trade message?
  confidence: HIGH | LOW   // How certain the classification is
  trades: Signal[][]       // outer = trades in message, inner = legs of one trade
}
```

<constraints>
## Classification Rules

These are hard rules. Do not deviate.

### isTrade decisions
1. **Badge is strong signal.** Long/Short/Exit badges are structural markers added by traders to indicate a trade. Badge + symbol = trade unless proven otherwise by one of the exceptions below.
2. **Futures (/ES, /NQ, /RTY, /YM, /CL, /GC) are always isTrade: false** because the system does not trade futures contracts. They cannot be executed.
3. **Paper trades are always isTrade: false** because the system only copies real-money trades.
4. **Commentary with symbols but no badge and no action verbs is isTrade: false.** "NVDA rw persistent selling" is market observation, not a trade entry.
5. **Pre-market bulletins (starting with "PRE-OPEN MARKET COMMENTS" or similar) are always isTrade: false** regardless of how many tickers they mention.
6. **Hypotheticals ("if I was", "I would consider") are isTrade: false.** No execution happened.
7. **Position updates ("still holding", "looking for a sell off") are isTrade: false.** No new action.

### Signal field rules
8. **A stated dollar price implies STOCK unless options language is present.** "Long TSLA $311.83" with a badge and a dollar price but no strikes, expiry, or options words (calls/puts/spread/credit/debit) -> `strategy: "STOCK"`. "Long TSLA 1,000 Shares" -> `strategy: "STOCK"`. "Long TSLA $330 Call" -> `strategy: "CALL"`. Only use `strategy: null` when there is NO price AND no instrument clues (bare "Long MP" with nothing else).
8a. **Cent-denominated P&L confirms STOCK, never CALL.** "Exit Short ELV 276.45 (18c loss)" — "18c" = 18 cents stock P&L, "276.45" = stock price. Never classify these as CALL. Similarly "-23c loss", "$.40 gain", "$1.95 loss" with dollar prices in the hundreds = stock trades.
8b. **Fractions near trim/exit are quantity, not dates.** "trim 3/4 of FSLY" means 75% exit (`exitPercent: 0.75`), not expiry March 4th. Use message date context as a sanity check — if "3/4" would refer to a date already past (or far in the future for non-LEAPS), it's almost certainly a quantity fraction. Fractions like 1/2, 1/3, 2/3, 3/4 adjacent to exit/trim language are always quantity.
9. **confidence = HIGH when the isTrade classification AND action are unambiguous.** A simple `[Long] SYMBOL $PRICE` trade is HIGH even when strategy is null — the trade itself is clear, just the instrument type is not.
10. **Multi-trade messages need multiple trades (outer array entries).** Two badges + two symbols = two entries in the outer `trades` array. Always verify badge count matches trade count.
11. **statedPrice = option premium, credit amount, OR stock entry price.** "Long TSLA $311.83 - 1,000 Shares" -> `statedPrice: 311.83`. "Long TSLA $330 Call for .47" -> `statedPrice: 0.47`.
12. **Partial exits use TRIM action with exitPercent.** "took 2/3 off" -> `action: "TRIM", exitPercent: 0.67`. "half out" -> `action: "TRIM", exitPercent: 0.5`. The fraction numerals (2, 3) are NOT strikes — never put them in the strikes array.

### Spread and options mapping
13. **PCS (Put Credit Spread)** = bullish, sold puts -> `strategy: "PCS", strikes: [high, low]`
14. **PDS (Put Debit Spread)** = bearish, bought puts -> `strategy: "PDS", strikes: [high, low]`
15. **CDS (Call Debit Spread)** = bullish, bought calls -> `strategy: "CDS", strikes: [low, high]`
16. **CCS (Call Credit Spread)** = bearish, sold calls -> `strategy: "CCS", strikes: [low, high]`
17. **Sold puts (Pete's style)** = bullish, selling puts for premium -> `strategy: "PUT", statedPrice: <premium>, direction: "LONG"`. "Long OKLO sold Oct (17) $95 put @ $4.70" is opening a new position, NOT closing.
</constraints>

## How to Reason Through a Message

For every message, think through these steps in order. Write this reasoning into the `reasoning` field:

1. **Badges present?** List the badges. Long/Short/Exit badges are strong structural signals.
2. **Symbols present?** List them. Check if any are futures (/ES, /NQ) or leveraged ETFs (NVDL, TSLL).
3. **Is this actually a trade?** Check for disqualifiers: no badge + no action verb, commentary, hypothetical, paper, futures, pre-market bulletin, position update.
4. **What action?** OPEN (new position), CLOSE (exiting), ADD (adding to existing), TRIM (partial exit), LEG_OFF (removing a spread leg). Look for exit keywords, "added/adding", fraction language, or default to OPEN.
5. **Direction?** Long badge = LONG, Short badge = SHORT, Exit badge = check for direction word after Exit.
6. **Instrument clues?** Check for: strike prices, C/P suffix, "calls"/"puts"/"shares", strategy name (PCS/PDS/CDS), slash between strikes. If a specific dollar price is stated with no options language → `strategy: "STOCK"`. Only use `strategy: null` for bare trades with no price and no instrument clues (e.g., "Long MP").
7. **Partial?** Any fraction language, "trim", "half", "runners"? -> `action: "TRIM", exitPercent: <fraction>`.
8. **Multiple trades?** Count badges vs symbols. More than one trade = more than one entry in outer `trades` array.

<examples>
## Labeling Examples

These show the expected classification for real message patterns. Study the reasoning style.

<example>
<message>badges: ["Long"], symbols: ["TSLA"], clean_text: "Long TSLA $311.83 - 1,000 Shares"</message>
<label>
{
  "reasoning": "Long badge + TSLA symbol. '$311.83' is a stock entry price. '1,000 Shares' explicitly names the instrument as stock. Standard Hari-style share trade.",
  "isTrade": true,
  "confidence": "HIGH",
  "trades": [[{
    "action": "OPEN", "symbol": "TSLA", "direction": "LONG",
    "strategy": "STOCK", "strikes": null, "expiry": null,
    "statedPrice": 311.83, "quantity": 1000
  }]]
}
</label>
</example>

<example>
<message>badges: ["Long"], symbols: ["GLW"], clean_text: "Long GLW pcs 68/67 for .63 credit"</message>
<label>
{
  "reasoning": "Long badge + GLW. 'pcs' = Put Credit Spread (bullish). Two strikes 68/67. '.63 credit' = premium collected. PCS -> strategy: PCS, strikes ordered high/low.",
  "isTrade": true,
  "confidence": "HIGH",
  "trades": [[{
    "action": "OPEN", "symbol": "GLW", "direction": "LONG",
    "strategy": "PCS", "strikes": [68, 67], "expiry": null,
    "statedPrice": 0.63, "quantity": null
  }]]
}
</label>
</example>

<example>
<message>badges: ["Exit", "Long"], symbols: ["JOBY"], clean_text: "Exit Long trim 1/2 JOBY 17.15"</message>
<label>
{
  "reasoning": "Exit badge + Long direction + JOBY. 'trim 1/2' = partial exit of half the position. 17.15 is exit price. 1 and 2 are fraction parts, NOT strikes. Partial exit -> action: TRIM with exitPercent: 0.5.",
  "isTrade": true,
  "confidence": "HIGH",
  "trades": [[{
    "action": "TRIM", "symbol": "JOBY", "direction": "LONG",
    "strategy": null, "strikes": null, "expiry": null,
    "statedPrice": null, "quantity": null, "exitPercent": 0.5
  }]]
}
</label>
</example>

<example>
<message>badges: ["Long"], symbols: ["OKLO"], clean_text: "Long OKLO sold Oct (17) $95 put @ $4.70"</message>
<label>
{
  "reasoning": "Long badge + OKLO. 'sold ... put' = selling puts for premium (Pete's bullish style). 'Oct (17)' = expiry. $95 = strike. $4.70 = premium collected. This is opening a new bullish position, not closing.",
  "isTrade": true,
  "confidence": "HIGH",
  "trades": [[{
    "action": "OPEN", "symbol": "OKLO", "direction": "LONG",
    "strategy": "PUT", "strikes": [95], "expiry": "Oct (17)",
    "statedPrice": 4.70, "quantity": null
  }]]
}
</label>
</example>

<example>
<message>badges: ["Short"], symbols: ["GPC"], clean_text: "Short GPC 111.71"</message>
<label>
{
  "reasoning": "Short badge + GPC. '$111.71' is a dollar price with no strikes, expiry, or options language. Price implies stock -> strategy: STOCK.",
  "isTrade": true,
  "confidence": "HIGH",
  "trades": [[{
    "action": "OPEN", "symbol": "GPC", "direction": "SHORT",
    "strategy": "STOCK", "strikes": null, "expiry": null,
    "statedPrice": 111.71, "quantity": null
  }]]
}
</label>
</example>

<example>
<message>badges: ["Exit", "Short"], symbols: ["ELV"], clean_text: "Exit Short ELV 276.45 (18c loss)"</message>
<label>
{
  "reasoning": "Exit badge + Short direction + ELV. '276.45' is a stock-level dollar price. '18c loss' = 18 cents loss on stock, NOT an options premium. Cent-denominated P&L confirms this is a STOCK trade, not CALL.",
  "isTrade": true,
  "confidence": "HIGH",
  "trades": [[{
    "action": "CLOSE", "symbol": "ELV", "direction": "SHORT",
    "strategy": "STOCK", "strikes": null, "expiry": null,
    "statedPrice": 276.45, "quantity": null
  }]]
}
</label>
</example>

<example>
<message>badges: ["Long"], symbols: ["MP"], clean_text: "Long MP"</message>
<label>
{
  "reasoning": "Long badge + MP symbol. No price, no instrument clues, no sizing. Bare trade entry (Dave W style). Trade is clear but instrument is unknown -> strategy: null.",
  "isTrade": true,
  "confidence": "HIGH",
  "trades": [[{
    "action": "OPEN", "symbol": "MP", "direction": "LONG",
    "strategy": null, "strikes": null, "expiry": null,
    "statedPrice": null, "quantity": null
  }]]
}
</label>
</example>

<example>
<message>badges: ["Short"], symbols: ["NVDA"], clean_text: "Short NVDA PDS $170/$167.50 - for .90 - 30 Contracts"</message>
<label>
{
  "reasoning": "Short badge + NVDA. 'PDS' = Put Debit Spread (bearish). Two strikes 170/167.50. '.90' = premium paid (debit). 30 Contracts. PDS -> strategy: PDS, strikes ordered high/low.",
  "isTrade": true,
  "confidence": "HIGH",
  "trades": [[{
    "action": "OPEN", "symbol": "NVDA", "direction": "SHORT",
    "strategy": "PDS", "strikes": [170, 167.50], "expiry": null,
    "statedPrice": 0.90, "quantity": 30
  }]]
}
</label>
</example>

<example>
<message>badges: [], symbols: ["NVDA"], clean_text: "NVDA rw persistent selling this morning"</message>
<label>
{
  "reasoning": "No badges. Mentions NVDA but this is market commentary describing price action ('rw' = relative weakness, 'persistent selling'). No action verb, no trade entry language.",
  "isTrade": false,
  "confidence": "HIGH",
  "trades": []
}
</label>
</example>

<example>
<message>badges: [], symbols: ["ES"], clean_text: "Short /ES 6854. More as a hedge for short put positions"</message>
<label>
{
  "reasoning": "/ES is a futures contract. System does not trade futures -> isTrade: false regardless of badges or action language.",
  "isTrade": false,
  "confidence": "HIGH",
  "trades": []
}
</label>
</example>

<example>
<message>badges: ["Exit"], symbols: ["NVDA", "AMZN"], clean_text: "Exit NVDA $2.20 per share (1,500) Exit AMZN with $2.90 profit per share (1,000)"</message>
<label>
{
  "reasoning": "Exit badge with two symbols (NVDA, AMZN). Two separate exit statements = two trades in outer array. Both are full exits (no partial language). '$2.20 per share' and '$2.90 profit per share' describe P&L, not premiums -> statedPrice: null. '(1,500)' and '(1,000)' are share counts.",
  "isTrade": true,
  "confidence": "HIGH",
  "trades": [
    [{
      "action": "CLOSE", "symbol": "NVDA", "direction": null,
      "strategy": null, "strikes": null, "expiry": null,
      "statedPrice": null, "quantity": 1500
    }],
    [{
      "action": "CLOSE", "symbol": "AMZN", "direction": null,
      "strategy": null, "strikes": null, "expiry": null,
      "statedPrice": null, "quantity": 1000
    }]
  ]
}
</label>
</example>

<example>
<message>badges: ["Short"], symbols: ["AVTR"], clean_text: "Short AVTR $11.35 - paper"</message>
<label>
{
  "reasoning": "Short badge + AVTR, but 'paper' = simulated trade. Paper trades are always isTrade: false because the system only copies real-money trades.",
  "isTrade": false,
  "confidence": "HIGH",
  "trades": []
}
</label>
</example>

<example>
<message>badges: ["Short"], symbols: ["ABNB"], clean_text: "Short ABNB using $127 Puts for $5.55 - 25 Contracts"</message>
<label>
{
  "reasoning": "Short badge + ABNB. 'using $127 Puts' = buying puts (bearish bet). $5.55 = premium paid. 25 Contracts. Single put purchase -> strategy: PUT.",
  "isTrade": true,
  "confidence": "HIGH",
  "trades": [[{
    "action": "OPEN", "symbol": "ABNB", "direction": "SHORT",
    "strategy": "PUT", "strikes": [127], "expiry": null,
    "statedPrice": 5.55, "quantity": 25
  }]]
}
</label>
</example>
</examples>

## Database Access

Write scratchpad scripts using direct SQLite. DB path: `data/trade-follower.db`.

```typescript
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
const db = new Database('data/trade-follower.db');
```

### Read unlabeled messages
```sql
SELECT m.id, m.clean_text, m.badges, m.symbols, m.timestamp, m.author
FROM messages m
LEFT JOIN eval_labels el ON el.message_id = m.id
  AND el.version = 2
WHERE el.id IS NULL
ORDER BY m.timestamp DESC LIMIT 50
```

### Read labels needing review
```sql
SELECT el.id, el.label, el.human_verified, el.human_label,
       m.clean_text, m.badges, m.symbols
FROM eval_labels el
JOIN messages m ON el.message_id = m.id
WHERE el.version = 2
  AND el.human_verified = 0
ORDER BY json_extract(el.label, '$.confidence') ASC, m.timestamp DESC
```

### Write a label (upsert)
```sql
INSERT INTO eval_labels (id, message_id, label, source, model, version, human_verified, reviewed_at, created_at)
VALUES (?, ?, ?, 'human', 'claude-code', 2, 1, datetime('now'), datetime('now'))
ON CONFLICT(message_id, version) DO UPDATE SET
  label = excluded.label,
  source = 'human',
  model = 'claude-code',
  human_verified = 1,
  human_label = null,
  reviewed_at = datetime('now')
```

Use `randomUUID()` for the `id` column. The `label` column is a JSON string of the `EvalLabelData` object. The `.trades` field contains `Signal[][]`.

### Approve an existing label (mark as verified without changes)
```sql
UPDATE eval_labels SET human_verified = 1, reviewed_at = datetime('now')
WHERE id = ?
```

## Workflow

### `/label` (batch mode)
1. Write a scratchpad script (`scratchpad/label-batch.ts`) for all DB operations.
2. Fetch unlabeled messages using the query above.
3. For each message:
   a. Read clean_text + badges + symbols.
   b. Reason through the 8-step checklist above.
   c. Build the EvalLabelData JSON with `reasoning` written FIRST.
   d. If `confidence: LOW`, present the message and your reasoning to the user and ask for confirmation before writing.
4. Upsert into eval_labels.
5. Run the self-check (see below) on all labels written this session.
6. Report a summary: total labeled, isTrade vs non-trade counts, HIGH vs LOW confidence, action breakdown (OPEN/CLOSE/ADD/TRIM).
   Include `LEG_OFF` in the action breakdown if any labels use it.
7. Delete scratchpad script when done.

### `/label <message-id>` (single message)
Same as batch but for one message. Show the full EvalLabelData JSON to the user before writing.

### `/label relabel [N days]` (bulk relabel via sub-agents)

Relabels all existing eval_labels (and any unlabeled badged messages) within the given time window. Skips human-verified labels. Default window is 30 days from the latest message.

1. Export all badged messages in the date window (excluding human-verified) to JSON via `sqlite3 -json`.
2. Split into batch files of 100 messages each (e.g., `/tmp/relabel-batch-{000..N}.json`).
3. Spawn one sub-agent per batch (using Agent tool, `run_in_background: true`, model: sonnet). Each agent:
   - Reads its batch file
   - Classifies every message using the full classification rules from this skill
   - Writes results as a JSON array of `{messageId, label}` to `/tmp/relabel-results-{NNN}.json`
4. Write an insert script (`scratchpad/insert-labels.ts`) that reads all result files and upserts into `eval_labels` with `source: 'human'`, `model: 'claude-code-agent'`, `version: 2`, `human_verified: 0`.
5. After all agents complete, run the insert script.
6. **Post-insert validation** (agents sometimes deviate from the schema):
   - Fix `action` values: map BUY→OPEN, SELL→CLOSE, SHORT→OPEN
   - Fix `confidence` values: map numeric values (0.95, 0.99) to HIGH (≥0.8) or LOW (<0.8)
   - Verify no invalid enum values remain
7. Report final stats: total inserted, isTrade breakdown, strategy distribution, action distribution.
8. Clean up temp files and scratchpad script.

### `/label audit`
Query all human_verified=1 labels and check for systematic errors:
- Run every self-check rule below across the full dataset.
- Look for pattern-level problems: are all PCS labeled with `strategy: "PCS"`? Are all futures excluded?
- Report: total labels audited, errors found (grouped by rule violated), specific message IDs to fix.

### `/label stats`
Report in this format:
```
Labeling Progress
  Total messages:        N
  Labeled:               N (N%)
  Human-verified:        N (N%)
  Unverified:            N

Classification Breakdown
  isTrade: true          N (N%)
  isTrade: false         N (N%)

Confidence
  HIGH:                  N (N%)
  LOW:                   N (N%)

Action Distribution (trade signals only)
  OPEN:                  N
  CLOSE:                 N
  ADD:                   N
  TRIM:                  N
  LEG_OFF:               N
```

## Self-Check (run after every batch)

After writing labels, run these checks programmatically in your scratchpad script. Report any violations — do not silently pass them:

1. Every `isTrade: true` label has at least one trade (non-empty `trades` array).
2. Every signal with `action: OPEN` or `action: ADD` has a non-null `symbol`.
3. No Exit-badged message has `action: OPEN` (should be CLOSE or TRIM).
4. No `isTrade: false` message has Long/Short/Exit badges (unless it is futures or paper — explain in reasoning).
5. Badge count matches trade count (outer array length) for multi-trade messages.
6. No partial-exit message has fraction numerals (1, 2, 3, 4) in the `strikes` array.
7. Every `action: "TRIM"` signal has `exitPercent` set.
8. Strangles/WATM (wide-and-thin-money) are one trade with multiple signals (inner array length > 1), not separate trades.
