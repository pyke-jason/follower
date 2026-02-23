# Signal Redesign: Prompt Changes

**Date**: 2026-02-23
**Author**: prompt-engineer agent
**Scope**: All LLM-facing prompt text and JSON Schema changes for the 5-action to 4-intent migration.

---

## Summary of Changes

1. **Remove ADD action** from LLM vocabulary. Pipeline infers ADD vs OPEN from existing positions.
2. **Make `direction` and `strategy` optional** on CLOSE, TRIM, LEG_OFF. Pipeline resolves from existing position.
3. **Add `strategyHint`** on CLOSE/TRIM/LEG_OFF for disambiguation when a trader holds multiple positions on the same symbol.
4. **Bump INTENT_VERSION** from 5 to 6.

---

## 1. extract-intent.ts — INTENT_SYSTEM_PROMPT

### 1a. `<process>` section

**BEFORE** (line 55-61):
```
<process>
For each message:
1. CLASSIFY: Is this a trade entry, exit, add, trim, or noise? Use the trader's recent messages to understand what positions they hold.
2. IDENTIFY: Stock or options? If options, determine the structure (naked call/put, CDS, PDS).
3. VALIDATE: Check the prefetched stock quotes in the message context. If the price seems wildly inconsistent with the trader's message, flag for review.
4. OUTPUT: Always end by invoking a tool -- call submit_decision with your parsed signals (EXECUTE, SKIP, or MANUAL_REVIEW), or call flag_for_review. Never output your decision as text.
</process>
```

**AFTER**:
```
<process>
For each message:
1. CLASSIFY: Is this a new trade entry, full exit, partial exit (trim), leg-off, or noise? Use the trader's recent messages for context.
2. IDENTIFY: Stock or options? If options, determine the structure (naked call/put, CDS, PDS).
3. VALIDATE: Check the prefetched stock quotes in the message context. If the price seems wildly inconsistent with the trader's message, flag for review.
4. OUTPUT: Always end by invoking a tool -- call submit_decision with your parsed signals (EXECUTE, SKIP, or MANUAL_REVIEW), or call flag_for_review. Never output your decision as text.
</process>
```

**Why**: Remove "add" from the classification vocabulary. The LLM should classify "adding more" as a new entry (OPEN). The pipeline detects that a position already exists and routes to ADD logic internally.

---

### 1b. `<signal_actions>` section

**BEFORE** (line 83-92):
```
<signal_actions>
All signals omit quantity -- the system calculates position size.
Pricing: the system computes all prices from market data. You never set prices.
If the trader states a premium ("for $3.72", "for .09", "$2.40 credit"), include it as statedPremium. Omit statedPremium if no price is mentioned.

OPEN: New position. Include symbol, direction, strategy. Include legs ONLY when the trader explicitly states strikes. Omit legs when strikes are not stated -- the system infers ATM strikes from the stock price.
CLOSE: Full exit. Omit legs and statedPremium -- the system handles exit pricing.
ADD: Adding to existing position. Verify via recent messages that a position was previously opened. Same fields as OPEN.
TRIM: Partial exit. Include exitPercent (0.5 = half, 0.8 = 80%). Omit legs and statedPremium.
LEG_OFF: Close one leg of a spread, hold the other. Include targetStrategy (CALL or PUT) -- the strategy after the closed leg is removed. Omit legs and statedPremium.
</signal_actions>
```

**AFTER**:
```
<signal_actions>
All signals omit quantity -- the system calculates position size.
Pricing: the system computes all prices from market data. You never set prices.
If the trader states a premium ("for $3.72", "for .09", "$2.40 credit"), include it as statedPremium on OPEN signals only.

OPEN: New position OR adding to an existing position. Always use OPEN for any entry -- the system detects whether a position already exists and handles accordingly.
  Required: symbol, direction, strategy.
  Optional: legs (include ONLY when the trader explicitly states strikes; omit to let the system infer ATM), statedPremium.

CLOSE: Full exit of an existing position. The system finds the position by symbol and trader.
  Required: symbol.
  Optional: direction, strategy (include as hints when the trader holds multiple positions on the same symbol, e.g. both stock and options).
  Omit: legs, statedPremium.

TRIM: Partial exit.
  Required: symbol, exitPercent (0.5 = half, 0.8 = 80%).
  Optional: direction, strategy (same disambiguation rule as CLOSE).
  Omit: legs, statedPremium.

LEG_OFF: Close one leg of a spread, hold the other.
  Required: symbol, targetStrategy (CALL or PUT -- the strategy AFTER the closed leg is removed).
  Optional: direction, strategy (same disambiguation rule as CLOSE).
  Omit: legs, statedPremium.
</signal_actions>
```

**Why**:
- ADD is removed entirely. The LLM no longer needs to determine whether a position exists -- that is infrastructure's job. This eliminates a major source of misclassification (the LLM's position awareness from recent messages is unreliable).
- direction/strategy become optional on exit actions because `executeClose`, `executeTrim`, and `executeLegOff` already use `existing.direction` and `existing.strategy` from the DB for order construction. The LLM-provided values were only used in `findPosition()` for the initial lookup, and that function already has a fuzzy fallback (line 235-241 of execute.ts).
- "Include as hints when the trader holds multiple positions" gives the LLM a clear rule for when to include vs omit.

---

### 1c. `<direction_rules>` section

**BEFORE** (line 71-81):
```
<direction_rules>
The direction field means whether you are BUYING (LONG) or SELLING (SHORT) the option/spread.
It does NOT represent the trader's stock-level view.

Core rule: derive direction from the actual trade mechanics, not the Long/Short prefix.
- Debit strategies (buying options or spreads): direction is LONG, always.
- Direction is SHORT only when genuinely SELLING (writing) options for credit, or short-selling stock.
- The words "Bought" and "Sold" in the message are authoritative -- they override any prefix.

Confirming with exit context: LOSS with exit < entry = they bought (paid high, sold low). GAIN with exit < entry = they sold to open (collected premium, bought back cheap).
</direction_rules>
```

**AFTER**:
```
<direction_rules>
Direction applies only to OPEN signals. For CLOSE, TRIM, and LEG_OFF, direction is optional and only used as a disambiguation hint.

The direction field means whether you are BUYING (LONG) or SELLING (SHORT) the option/spread.
It does NOT represent the trader's stock-level view.

Core rule: derive direction from the actual trade mechanics, not the Long/Short prefix.
- Debit strategies (buying options or spreads): direction is LONG, always.
- Direction is SHORT only when genuinely SELLING (writing) options for credit, or short-selling stock.
- The words "Bought" and "Sold" in the message are authoritative -- they override any prefix.
</direction_rules>
```

**Why**:
- Added scoping statement at top: direction is required on OPEN, optional on exits.
- Removed the "Confirming with exit context" paragraph. That heuristic was for cases where the LLM tried to infer direction from PnL context during exits -- no longer needed since exit signals don't require direction.

---

### 1d. `<rules>` section

**BEFORE** (line 105-112):
```
<rules>
- Only parse trades for tracked traders in the whitelist. Skip paper trades tagged "(paper)".
- A message may contain multiple DIFFERENT trades ("Exit TXN, Short TSLA") -- one signal per distinct trade. Never emit two signals for the same symbol+action -- combine all attributes into one signal.
- When the trader states explicit strikes, include them in legs. When strikes are omitted, omit legs entirely -- the system infers them.
- Always output expiry as YYYY-MM-DD. Traders write dates many ways ("12/19", "Dec 19", "12/19/25") -- convert them. For MM/DD without a year, use the next occurrence of that date on or after the message date. A bare month name like "Oct" with no day means the standard monthly expiry (3rd Friday of that month). When a date appears as "Oct (10)", the number in parentheses is the day (October 10th), not a contract count.
- Always explain your reasoning -- your steps are audited.
- If you don't understand a financial concept, say so. Never fabricate mechanics.
</rules>
```

**AFTER**:
```
<rules>
- Only parse trades for tracked traders in the whitelist. Skip paper trades tagged "(paper)".
- A message may contain multiple DIFFERENT trades ("Exit TXN, Short TSLA") -- one signal per distinct trade. Never emit two signals for the same symbol+action -- combine all attributes into one signal.
- When the trader states explicit strikes, include them in legs. When strikes are omitted, omit legs entirely -- the system infers them. Legs only apply to OPEN signals.
- Always output expiry as YYYY-MM-DD. Traders write dates many ways ("12/19", "Dec 19", "12/19/25") -- convert them. For MM/DD without a year, use the next occurrence of that date on or after the message date. A bare month name like "Oct" with no day means the standard monthly expiry (3rd Friday of that month). When a date appears as "Oct (10)", the number in parentheses is the day (October 10th), not a contract count.
- "Adding more", "avg down", "doubled down" = OPEN (the system detects existing positions automatically). Do not try to determine if a position already exists.
- Always explain your reasoning -- your steps are audited.
- If you don't understand a financial concept, say so. Never fabricate mechanics.
</rules>
```

**Why**:
- Added "Legs only apply to OPEN signals" to reinforce the legs-on-exit prohibition.
- Added explicit rule mapping "adding more" language to OPEN, since removing ADD means the LLM needs to know what to do with add-intent messages.

---

### 1e. Examples — Updated and New

#### Example: CLOSE (direction now optional)

**BEFORE** (line 166-173):
```
<example>
<input>Exit Long ATEC</input>
<reasoning>
"Exit" = closing a position. This is a CLOSE action on ATEC.
Omit legs and statedPremium -- the system handles exit pricing.
</reasoning>
submit_decision(EXECUTE): action CLOSE, symbol ATEC, direction LONG
</example>
```

**AFTER**:
```
<example>
<input>Exit Long ATEC</input>
<reasoning>
"Exit" = closing a position. This is a CLOSE on ATEC.
"Long" tells us the trader's position direction -- include as a hint to help the system find the right position.
Omit legs and statedPremium -- the system handles exit pricing.
</reasoning>
submit_decision(EXECUTE): action CLOSE, symbol ATEC, direction LONG
</example>
```

**Why**: Demonstrate that direction is present but explain it's a hint, not a required classification. The reasoning models the correct thought process.

---

#### Example: CLOSE without direction (NEW)

**ADD after the ATEC example**:
```
<example>
<input>Out of AAPL stock</input>
<reasoning>
"Out of" = closing a position. This is a CLOSE on AAPL.
"stock" tells us the strategy -- include strategy STOCK as a hint so the system matches the right position (trader may hold both stock and options on AAPL).
No direction stated, so omit it. The system finds the position by symbol+trader.
</reasoning>
submit_decision(EXECUTE): action CLOSE, symbol AAPL, strategy STOCK
</example>
```

**Why**: Shows the LLM that direction can be omitted, and that strategy can serve as a disambiguation hint even when direction is absent.

---

#### Example: ADD replaced with OPEN

**BEFORE** (there was no explicit ADD example, but the `<signal_actions>` section defined ADD).

**ADD new example**:
```
<example>
<input>Adding more NVDA calls, avg down</input>
<reasoning>
"Adding more" = entering more of an existing position. Use OPEN -- the system detects that a NVDA CALL position already exists and handles the add automatically.
direction: LONG (buying calls). strategy: CALL.
No strikes stated, so omit legs.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol NVDA, direction LONG, strategy CALL
</example>
```

**Why**: Critical example. The LLM must learn that "adding more" maps to OPEN, not a removed ADD action. The reasoning explicitly states the pipeline handles position detection.

---

#### Example: TRIM (direction omitted)

**BEFORE** (line 175-181):
```
<example>
<input>Exit RKLB 1/2</input>
<reasoning>
"1/2" = partial exit. This is a TRIM with exitPercent 0.5. Omit legs and statedPremium.
</reasoning>
submit_decision(EXECUTE): action TRIM, symbol RKLB, exitPercent 0.5
</example>
```

**AFTER**:
```
<example>
<input>Exit RKLB 1/2</input>
<reasoning>
"1/2" = partial exit. This is a TRIM with exitPercent 0.5.
No direction or strategy stated -- omit both. The system finds the position by symbol+trader.
Omit legs and statedPremium.
</reasoning>
submit_decision(EXECUTE): action TRIM, symbol RKLB, exitPercent 0.5
</example>
```

**Why**: Reinforces that TRIM does not need direction or strategy.

---

#### Example: LEG_OFF (unchanged but clarified reasoning)

**BEFORE** (line 183-190):
```
<example>
<input>Exit Long UNH cds took small profit hold straight calls</input>
<reasoning>
Trader is closing the short leg of a CDS and keeping the long calls. This is LEG_OFF.
targetStrategy: CALL (the remaining strategy after removing the short call leg). Omit legs and statedPremium.
</reasoning>
submit_decision(EXECUTE): action LEG_OFF, symbol UNH, targetStrategy CALL
</example>
```

**AFTER**:
```
<example>
<input>Exit Long UNH cds took small profit hold straight calls</input>
<reasoning>
Trader is closing the short leg of a CDS and keeping the long calls. This is LEG_OFF.
targetStrategy: CALL (the remaining strategy after removing the short call leg).
"Long" and "cds" describe the existing position -- include direction LONG and strategy CDS as hints.
Omit legs and statedPremium.
</reasoning>
submit_decision(EXECUTE): action LEG_OFF, symbol UNH, direction LONG, strategy CDS, targetStrategy CALL
</example>
```

**Why**: LEG_OFF benefits from strategy hint (CDS) since it clarifies which spread to operate on. Shows direction/strategy as hints, not required fields.

---

#### Example: "Short ABNB using puts" (existing fix for two-trades bug)

**BEFORE** (line 158-163):
```
<example>
<input>Short ABNB Lotto $123 Puts for .21</input>
<reasoning>
"Lotto" = speculative buy, always buy-to-open. Trader is BUYING cheap puts as a bearish bet.
direction: LONG, strategy: PUT. "Short" is the stock view, not the trade direction.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol ABNB, direction LONG, strategy PUT, legs [BUY 123P], statedPremium 0.21
</example>
```

**AFTER** (unchanged -- this example is still correct and important):
```
<example>
<input>Short ABNB Lotto $123 Puts for .21</input>
<reasoning>
"Lotto" = speculative buy, always buy-to-open. Trader is BUYING cheap puts as a bearish bet.
direction: LONG, strategy: PUT. "Short" is the stock view, not the trade direction.
This is ONE signal (the put purchase), not two (do not separately parse "Short ABNB" as a stock short).
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol ABNB, direction LONG, strategy PUT, legs [BUY 123P], statedPremium 0.21
</example>
```

**Why**: Added the "ONE signal" clarification to address the two-trades-per-message bug documented in MEMORY.md.

---

## 2. trade-agent.ts — SYSTEM_PROMPT

### 2a. Signal Actions section (line 81-104)

**BEFORE**:
```
## Signal Actions
Pricing: the system computes all prices from market data. You never set prices.
If the trader states a premium ("for $3.72", "for .09"), include it as statedPremium. Omit if no price stated.

- **OPEN**: New position entry. Include symbol, direction, strategy. Include legs when strikes are stated. Omit legs when strikes are not stated -- the system infers them.
- **CLOSE**: Full exit. "Exit Long ATEC" → action CLOSE. Include symbol and direction.
  Omit legs and statedPremium -- the system handles exit pricing.
- **ADD**: Adding to existing position ("added more NVDA calls", "avg down on AAPL").
  Use get_open_positions to verify position exists. Include same fields as OPEN.
- **TRIM**: Partial exit ("Exit RKLB 1/2", "trim 80% of AEO").
  Include exitPercent: 0.5 for half, 0.8 for 80%, etc.
  Omit legs and statedPremium.

## Rules
- Only classify trades for tracked traders in the whitelist.
- Skip paper trades (tagged with "(paper)").
- Inferring strikes/expiry from the options chain is NOT guessing — it's your job.
  Only use flag_for_review when the strategy type itself is truly ambiguous.
- Always explain your reasoning. Your steps are audited.
- If an exit arrives but we have no matching open position (check with get_open_positions), skip.

After using tools, call **submit_decision** with your classification. For EXECUTE, include a signals array. For SKIP or MANUAL_REVIEW, omit signals.

**IMPORTANT**: For options trades (CALL, PUT, CDS, PDS) with action OPEN or ADD, the `legs` array is REQUIRED. Each leg must include `strike`, `expiry`, `optionType`, and `action`. Without legs, the signal will be rejected by the execution pipeline. For CLOSE and TRIM, do NOT include `legs` — the system uses the existing position's legs automatically.
```

**AFTER**:
```
## Signal Actions
Pricing: the system computes all prices from market data. You never set prices.
If the trader states a premium ("for $3.72", "for .09"), include it as statedPremium on OPEN signals only.

- **OPEN**: New position entry OR adding to an existing position. Always use OPEN for any entry -- the system detects whether a position already exists and handles add-to-position automatically.
  Required: symbol, direction, strategy. Include legs when strikes are stated/inferred. statedPremium if price was stated.
- **CLOSE**: Full exit. "Exit Long ATEC" → action CLOSE, symbol ATEC.
  Required: symbol. Optional: direction, strategy (include as hints when the trader holds multiple positions on the same symbol). Omit legs and statedPremium.
- **TRIM**: Partial exit ("Exit RKLB 1/2", "trim 80% of AEO").
  Required: symbol, exitPercent (0.5 = half, 0.8 = 80%). Optional: direction, strategy (same hint rule as CLOSE). Omit legs and statedPremium.
- **LEG_OFF**: Close one leg of a spread, hold the other.
  Required: symbol, targetStrategy (CALL or PUT -- the strategy after removing the closed leg). Optional: direction, strategy (same hint rule as CLOSE). Omit legs and statedPremium.

## Rules
- Only classify trades for tracked traders in the whitelist.
- Skip paper trades (tagged with "(paper)").
- Inferring strikes/expiry from the options chain is NOT guessing — it's your job.
  Only use flag_for_review when the strategy type itself is truly ambiguous.
- Always explain your reasoning. Your steps are audited.
- "Adding more", "avg down", "doubled down" = OPEN (the system detects existing positions automatically).
- If an exit arrives but we have no matching open position (check with get_open_positions), skip.

After using tools, call **submit_decision** with your classification. For EXECUTE, include a signals array. For SKIP or MANUAL_REVIEW, omit signals.

**IMPORTANT**: For options trades (CALL, PUT, CDS, PDS) with action OPEN, the `legs` array is REQUIRED. Each leg must include `strike`, `expiry`, `optionType`, and `action`. Without legs, the signal will be rejected by the execution pipeline. For CLOSE, TRIM, and LEG_OFF, do NOT include `legs` — the system uses the existing position's legs automatically.
```

**Why**:
- Removed ADD action entirely.
- Added LEG_OFF which was missing from the trade-agent prompt.
- Made direction/strategy optional on exit actions with clear "hint" language.
- Updated IMPORTANT footer to remove "or ADD" and add LEG_OFF to the no-legs list.
- Added "adding more" mapping rule.

---

## 3. tool-factory.ts — JSON Schema Changes

### 3a. submit_decision tool — signals schema (line 73-99)

**BEFORE**:
```typescript
signals: {
  type: 'array',
  description: 'Trade signals (required for EXECUTE)',
  items: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['OPEN', 'CLOSE', 'ADD', 'TRIM', 'LEG_OFF'] },
      symbol: { type: 'string' },
      direction: { type: 'string', enum: ['LONG', 'SHORT'] },
      strategy: { type: 'string', enum: ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS'] },
      statedPremium: { type: 'number', description: 'The premium/price the trader stated in the message (e.g. 3.72 from "for $3.72"). Omit if no price stated.' },
      exitPercent: { type: 'number', description: '0.0-1.0 for TRIM' },
      targetStrategy: { type: 'string', enum: ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS'], description: 'For LEG_OFF: strategy after removing the leg' },
      legs: {
        type: 'array',
        maxItems: 2,
        items: {
          type: 'object',
          properties: {
            strike: { type: 'number' },
            expiry: { type: 'string' },
            optionType: { type: 'string', enum: ['CALL', 'PUT'] },
            action: { type: 'string', enum: ['BUY', 'SELL'] },
          },
          required: ['strike', 'expiry', 'optionType', 'action'],
        },
      },
    },
    required: ['action', 'symbol', 'direction', 'strategy'],
  },
},
```

**AFTER**:
```typescript
signals: {
  type: 'array',
  description: 'Trade signals (required for EXECUTE)',
  items: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['OPEN', 'CLOSE', 'TRIM', 'LEG_OFF'] },
      symbol: { type: 'string' },
      direction: { type: 'string', enum: ['LONG', 'SHORT'], description: 'Required for OPEN. Optional hint for CLOSE/TRIM/LEG_OFF.' },
      strategy: { type: 'string', enum: ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS'], description: 'Required for OPEN. Optional hint for CLOSE/TRIM/LEG_OFF.' },
      statedPremium: { type: 'number', description: 'The premium/price the trader stated (e.g. 3.72 from "for $3.72"). OPEN only. Omit if no price stated.' },
      exitPercent: { type: 'number', description: '0.0-1.0 for TRIM' },
      targetStrategy: { type: 'string', enum: ['CALL', 'PUT'], description: 'For LEG_OFF: the strategy AFTER removing the closed leg (always CALL or PUT, never a spread).' },
      legs: {
        type: 'array',
        description: 'Option legs. OPEN only -- omit for CLOSE/TRIM/LEG_OFF.',
        maxItems: 2,
        items: {
          type: 'object',
          properties: {
            strike: { type: 'number' },
            expiry: { type: 'string' },
            optionType: { type: 'string', enum: ['CALL', 'PUT'] },
            action: { type: 'string', enum: ['BUY', 'SELL'] },
          },
          required: ['strike', 'expiry', 'optionType', 'action'],
        },
      },
    },
    required: ['action', 'symbol'],
  },
},
```

**Changes**:
1. `action` enum: removed `'ADD'`, now `['OPEN', 'CLOSE', 'TRIM', 'LEG_OFF']`.
2. `direction`: added description clarifying required-for-OPEN, optional-for-exits.
3. `strategy`: same description pattern.
4. `statedPremium`: added "OPEN only" to description.
5. `targetStrategy`: narrowed enum from all 5 strategies to `['CALL', 'PUT']` — after a leg-off, you always end up with a naked option, never a spread or stock.
6. `legs`: added description "OPEN only".
7. `required`: reduced from `['action', 'symbol', 'direction', 'strategy']` to `['action', 'symbol']`.

---

## 4. schemas.ts — Zod Schema Changes

### 4a. SignalSchema

**BEFORE** (line 33-48):
```typescript
export const SignalSchema = z.object({
  action: TradeActionSchema,
  symbol: z.string().min(1),
  direction: DirectionSchema,
  strategy: StrategySchema,
  statedPremium: zPrice.optional(),
  exitPercent: zPct01.optional(),
  legs: z.array(SignalLegSchema).max(2).optional(),
  targetStrategy: StrategySchema.optional(),
}).refine(
  s => s.action !== 'LEG_OFF' || s.targetStrategy != null,
  { message: 'LEG_OFF requires targetStrategy (the strategy after removing the leg)' },
);
```

**AFTER**:
```typescript
export const SignalSchema = z.object({
  action: z.enum(['OPEN', 'CLOSE', 'TRIM', 'LEG_OFF']),
  symbol: z.string().min(1),
  direction: DirectionSchema.optional(),
  strategy: StrategySchema.optional(),
  statedPremium: zPrice.optional(),
  exitPercent: zPct01.optional(),
  legs: z.array(SignalLegSchema).max(2).optional(),
  targetStrategy: z.enum(['CALL', 'PUT']).optional(),
}).refine(
  s => s.action !== 'OPEN' || (s.direction != null && s.strategy != null),
  { message: 'OPEN requires direction and strategy' },
).refine(
  s => s.action !== 'LEG_OFF' || s.targetStrategy != null,
  { message: 'LEG_OFF requires targetStrategy' },
);
```

**Changes**:
1. `action`: inline enum without ADD (or use a new `LLMActionSchema` — see note below).
2. `direction`: now `.optional()`.
3. `strategy`: now `.optional()`.
4. `targetStrategy`: narrowed to `z.enum(['CALL', 'PUT'])`.
5. Added refine: OPEN requires both direction and strategy.
6. Kept existing refine: LEG_OFF requires targetStrategy.

**Note on `TradeActionSchema`**: The existing `TradeActionSchema` in `enums.ts` includes ADD because the pipeline and record-trade still use ADD internally. The LLM-facing schema should use a separate `LLMActionSchema = z.enum(['OPEN', 'CLOSE', 'TRIM', 'LEG_OFF'])`. The normalizer layer will map LLM signals to internal signals which may use ADD.

---

## 5. INTENT_VERSION Bump

### Current: `INTENT_VERSION = 5` (line 21)
### New: `INTENT_VERSION = 6`

**Implications**:
1. **Cache invalidation**: All existing cached intents (version 5) will NOT be reused. The `getCachedIntent()` query filters on version, so version 6 queries will miss version 5 rows.
2. **Backtest reruns**: Any backtest run that relied on cached intents will re-extract all intents on the next run. This is a one-time cost per symbol/date-range.
3. **DB storage**: Old version 5 rows remain in `messageIntents` table. They are harmless (just unused). Consider a cleanup migration later if space matters.
4. **Rollback**: If the new prompts produce worse results, reverting to version 5 code will automatically reuse the old cached intents (since the version filter will match again). This is a free rollback mechanism.

---

## 6. Edge Cases the Prompt Must Address

### 6a. "Adding more TSLA" -> OPEN
- **Message**: "Adding more TSLA calls, avg down"
- **Old behavior**: LLM emits ADD action. Pipeline's `executeAdd()` checks for existing position, falls through to `executeOpen()` if none found.
- **New behavior**: LLM emits OPEN action. Pipeline normalizer detects existing position and routes to internal ADD path.
- **Prompt solution**: Explicit rule in `<rules>` + dedicated example (see Section 1d and 1e above).

### 6b. "Exit RKLB 1/2" -> TRIM with exitPercent 0.5
- **No change needed**. The LLM already handles this correctly. Direction and strategy are now simply omitted instead of guessed.
- **Prompt solution**: Updated TRIM example removes direction field (see Section 1e).

### 6c. "Out of AAPL stock" -> CLOSE with strategy hint
- **Message**: Trader holds AAPL stock AND AAPL calls. "stock" disambiguates.
- **Old behavior**: LLM emits CLOSE with direction LONG, strategy STOCK.
- **New behavior**: LLM emits CLOSE with strategy STOCK (as hint). Direction omitted.
- **Prompt solution**: New "Out of AAPL stock" example (see Section 1e).

### 6d. "Took off the short calls, holding the long puts" -> LEG_OFF
- **Old behavior**: LLM emits LEG_OFF with targetStrategy CALL or PUT (confusing — which one?).
- **New behavior**: LEG_OFF with targetStrategy PUT (the strategy AFTER removal). The trader is keeping the puts.
- **Prompt solution**: Existing UNH example updated with direction/strategy as hints.

### 6e. Bare "out of TSLA" with no direction or strategy
- **Message**: "out of TSLA"
- **Signal**: CLOSE, symbol TSLA. No direction, no strategy.
- **Pipeline behavior**: `findPosition('TSLA', trader)` with no strategy filter → finds any open TSLA position. If exactly 1, matches. If multiple, ambiguous (needs strategy hint).
- **Prompt solution**: The LLM omits direction/strategy since the message doesn't state them. The pipeline's fuzzy match handles the common case (1 position). If ambiguous, pipeline returns `executed: false` — this is correct behavior (we shouldn't guess).

### 6f. CLOSE where LLM provides wrong direction (regression risk)
- **Old behavior**: LLM says CLOSE direction SHORT but position is LONG → `findPosition` fuzzy fallback drops strategy, finds the LONG position.
- **New behavior**: LLM omits direction entirely → `findPosition` matches by symbol+trader without direction confusion. Strictly better.
- **Net effect**: Fewer false negatives on CLOSE because the LLM can't provide wrong data that narrows the search incorrectly.

### 6g. Multiple positions on same symbol (disambiguation)
- **Scenario**: Trader holds AAPL CALL and AAPL PDS. Message: "Exit the calls."
- **Signal**: CLOSE, symbol AAPL, strategy CALL (hint).
- **Pipeline**: `findPosition` with strategy=CALL finds the right one.
- **Prompt solution**: The "include as hints when the trader holds multiple positions" rule in `<signal_actions>` covers this.

### 6h. PCS (Put Credit Spread) mapping
- **No change**. PCS was already mapped to direction SHORT, strategy PDS by the LLM. The OPEN signal still includes direction and strategy, so this is unaffected.

---

## 7. Prompt Diff Summary

| Section | File | Change |
|---------|------|--------|
| `<process>` | extract-intent.ts | Remove "add" from classification list |
| `<signal_actions>` | extract-intent.ts | Remove ADD, make dir/strategy optional on exits |
| `<direction_rules>` | extract-intent.ts | Scope to OPEN, remove exit-context paragraph |
| `<rules>` | extract-intent.ts | Add "adding more = OPEN" rule |
| Examples | extract-intent.ts | Update CLOSE/TRIM/LEG_OFF examples, add OPEN-for-add and CLOSE-no-direction examples |
| Signal Actions | trade-agent.ts | Remove ADD, add LEG_OFF, make dir/strategy optional on exits |
| Rules | trade-agent.ts | Add "adding more = OPEN" mapping |
| IMPORTANT footer | trade-agent.ts | Remove "or ADD", add LEG_OFF |
| JSON Schema | tool-factory.ts | Remove ADD from enum, make dir/strategy non-required, narrow targetStrategy |
| Zod | schemas.ts | Optional dir/strategy, OPEN refine, narrow targetStrategy |
| Version | extract-intent.ts | 5 -> 6 |

---

## 8. What Does NOT Change

- **`<strategies>` section** (CDS/PDS/PCS definitions) — unchanged.
- **`<slang>` section** — unchanged.
- **`<follow_trades>` section** — unchanged.
- **OPEN signal structure** — direction, strategy, legs all still required/optional as before.
- **Pipeline internal actions** — `record-trade.ts`, `rebuild.ts`, and DB schema still use ADD. Only the LLM-facing surface changes.
- **`TradeActionSchema` in enums.ts** — still includes ADD for internal use. A new `LLMActionSchema` is introduced for the LLM-facing boundary only.
