# Signal Redesign: TypeScript Interface Contracts

**Author**: type-designer
**Date**: 2026-02-23
**Status**: DRAFT — ready for team review

---

## 1. Current State Summary

Today, a single `Signal` type serves two roles:
1. **LLM output schema** (what `extract-intent.ts` and `trade-agent.ts` produce)
2. **Pipeline input type** (what `executeSignal()` in `execute.ts` consumes)

This forces the LLM to emit fields it cannot know for exit actions (direction, strategy on CLOSE/TRIM) and forces the pipeline to handle optionality that should already be resolved.

### Current Signal (for reference)
```ts
// src/agent/schemas.ts (today)
{
  action: 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF',
  symbol: string,
  direction: 'LONG' | 'SHORT',      // required even on CLOSE
  strategy: 'STOCK' | 'CALL' | 'PUT' | 'CDS' | 'PDS',  // required even on CLOSE
  statedPremium?: number,
  exitPercent?: number,
  legs?: SignalLeg[],
  targetStrategy?: Strategy,         // required only for LEG_OFF
}
```

---

## 2. LLMSignal — What the LLM Produces

**Owner**: `src/agent/schemas.ts`
**Consumers**: `extract-intent.ts`, `trade-agent.ts`, `agent-loop.ts`, DB `message_intents.signals`, DB `message_labels.signals`, `src/lib/eval.ts`

This is a **4-intent** schema: `OPEN | CLOSE | TRIM | LEG_OFF`. The `ADD` action is removed from the LLM surface — the normalizer determines ADD vs OPEN based on whether a position already exists.

### 2a. Zod Schema

```ts
// src/agent/schemas.ts (new)

import { z } from 'zod';
import { zPrice, zPct01 } from '../lib/zod-financial.js';
import { DirectionSchema, StrategySchema, LegActionSchema } from '../lib/enums.js';

// --- Intent enum (LLM-facing) ---

export const LLMIntentSchema = z.enum(['OPEN', 'CLOSE', 'TRIM', 'LEG_OFF']);
export type LLMIntent = z.infer<typeof LLMIntentSchema>;

// --- Signal leg (unchanged) ---

const SignalLegSchema = z.object({
  strike: zPrice,
  expiry: z.string().min(1),
  optionType: z.enum(['CALL', 'PUT']),
  action: LegActionSchema,
});

// --- LLMSignal: discriminated by intent ---

const LLMSignalBase = z.object({
  intent: LLMIntentSchema,
  symbol: z.string().min(1).transform(s => s.toUpperCase()),
});

/** OPEN: new position or add to existing. Direction + strategy always required. */
const LLMOpenSignal = LLMSignalBase.extend({
  intent: z.literal('OPEN'),
  direction: DirectionSchema,
  strategy: StrategySchema,
  statedPremium: zPrice.optional(),
  legs: z.array(SignalLegSchema).max(2).optional(),
});

/** CLOSE: full exit. Direction/strategy optional (pipeline looks up from position). */
const LLMCloseSignal = LLMSignalBase.extend({
  intent: z.literal('CLOSE'),
  direction: DirectionSchema.optional(),
  strategy: StrategySchema.optional(),
});

/** TRIM: partial exit. exitPercent required. */
const LLMTrimSignal = LLMSignalBase.extend({
  intent: z.literal('TRIM'),
  exitPercent: zPct01,
  direction: DirectionSchema.optional(),
  strategy: StrategySchema.optional(),
});

/** LEG_OFF: close one leg of a spread. targetStrategy required. */
const LLMLegOffSignal = LLMSignalBase.extend({
  intent: z.literal('LEG_OFF'),
  targetStrategy: StrategySchema,
  direction: DirectionSchema.optional(),
  strategy: StrategySchema.optional(),
});

export const LLMSignalSchema = z.discriminatedUnion('intent', [
  LLMOpenSignal,
  LLMCloseSignal,
  LLMTrimSignal,
  LLMLegOffSignal,
]);

export type LLMSignal = z.infer<typeof LLMSignalSchema>;
```

### 2b. Key Design Decisions

| Decision | Rationale |
|---|---|
| `intent` not `action` | Distinguishes LLM output from pipeline action. Prevents accidental assignment. |
| No `ADD` intent | LLM cannot reliably distinguish OPEN vs ADD (requires position state). Normalizer resolves this. |
| `direction`/`strategy` optional on exits | CLOSE/TRIM/LEG_OFF look up direction/strategy from the existing position. LLM hints are fallback only. |
| `exitPercent` required on TRIM | Today it defaults to 0.5 silently. Making it required forces the LLM to parse "1/2", "80%", etc. explicitly. |
| `symbol` uppercased via `.transform()` | Prevents case mismatches downstream. LLM sometimes emits lowercase. |
| `statedPremium` only on OPEN | Exits don't have a stated premium (system computes exit price). |
| `legs` only on OPEN | Exits use position's existing legs. |
| Discriminated union via `intent` | Zod `.discriminatedUnion()` gives precise parse errors. Each variant has exactly the fields it needs. |

### 2c. Validation Rules (built into schema)

1. **OPEN**: `direction` and `strategy` are required (enforced by schema shape, no `.refine()` needed)
2. **OPEN + options**: `legs` is optional — when omitted, pipeline infers ATM strikes (existing behavior)
3. **LEG_OFF**: `targetStrategy` is required (enforced by schema shape)
4. **TRIM**: `exitPercent` is required, range `[0, 1]` (enforced by `zPct01`)
5. **CLOSE**: no extra fields needed — just symbol

---

## 3. InternalSignal — What the Pipeline Receives

**Owner**: `src/pipeline/types.ts` (new file, or inline in `execute.ts`)
**Consumers**: `executeSignal()`, `executeOpen()`, `executeClose()`, `executeTrim()`, `executeAdd()`, `executeLegOff()`, `buildOrderFromSignal()`, `shouldSkipSignal()`, `deduplicateSignals()`

This is a **5-action** type with all fields required. The normalizer has resolved intent to action and filled in defaults from the existing position.

### 3a. Type Definition

```ts
// src/pipeline/types.ts (new)

import type { Strategy, Direction } from '../lib/enums.js';

export type SignalLeg = {
  strike: number;
  expiry: string;
  optionType: 'CALL' | 'PUT';
  action: 'BUY' | 'SELL';
};

/** Action enum for the pipeline — superset of LLM intents. */
export type PipelineAction = 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF';

/**
 * Fully-resolved signal for the execution pipeline.
 * Every field is present — no optional direction/strategy.
 * The normalizer guarantees this shape.
 */
export type InternalSignal = {
  action: PipelineAction;
  symbol: string;
  direction: Direction;    // always present
  strategy: Strategy;      // always present
  statedPremium?: number;
  exitPercent?: number;    // present when action is TRIM
  legs?: SignalLeg[];      // present for OPEN/ADD options, absent for exits
  targetStrategy?: Strategy; // present when action is LEG_OFF
};
```

### 3b. Why Not a Discriminated Union?

The pipeline already switches on `signal.action` with a `switch` statement. Making this a discriminated union would require refactoring every executor function signature for marginal type safety gain. The normalizer's output contract plus the per-action executors (which already narrow internally) provide sufficient safety. If we later want discriminated union narrowing, the migration is additive.

### 3c. Invariants Guaranteed by Normalizer

These invariants are NOT encoded in the type (they're runtime-guaranteed by `normalizeSignal()`):

| Action | Invariant |
|---|---|
| OPEN | `direction` and `strategy` from LLM signal |
| ADD | `direction` and `strategy` from LLM signal; position existence verified |
| CLOSE | `direction` and `strategy` from existing position (LLM hints ignored) |
| TRIM | `direction` and `strategy` from existing position; `exitPercent` present |
| LEG_OFF | `direction` and `strategy` from existing position; `targetStrategy` present |

---

## 4. normalizeSignal() — The Bridge

**Owner**: `src/pipeline/normalize-signal.ts` (new file)
**Called by**: `executeSignals()` in `execute.ts` (replaces direct `Signal` consumption)

### 4a. Function Signature

```ts
// src/pipeline/normalize-signal.ts

import type { LLMSignal } from '../agent/schemas.js';
import type { InternalSignal } from './types.js';
import type { Trade } from '../db/schema.js';
import type { PositionFilters } from '../trades/filters.js';

export type NormalizeDeps = {
  /** Look up open positions for a trader+symbol (same as PipelineDeps.getOpenPositions). */
  getOpenPositions: (filters: PositionFilters) => Promise<Trade[]>;
};

export type NormalizeResult =
  | { ok: true; signal: InternalSignal }
  | { ok: false; reason: string };

/**
 * Convert an LLM signal into a fully-resolved pipeline signal.
 *
 * Responsibilities:
 * 1. Map intent to action (OPEN -> OPEN or ADD based on position state)
 * 2. Fill direction/strategy from existing position for exit actions
 * 3. Validate that required positions exist for CLOSE/TRIM/LEG_OFF
 * 4. Pass through OPEN fields unchanged
 */
export async function normalizeSignal(
  llmSignal: LLMSignal,
  trader: string,
  deps: NormalizeDeps,
): Promise<NormalizeResult>;
```

### 4b. Normalization Logic (Pseudocode)

```
normalizeSignal(llmSignal, trader, deps):

  switch llmSignal.intent:

    case 'OPEN':
      // Check if position already exists for this symbol+trader+strategy
      positions = await deps.getOpenPositions({
        symbol: llmSignal.symbol,
        trader,
        strategy: llmSignal.strategy,
      })

      action = positions.length > 0 ? 'ADD' : 'OPEN'

      return { ok: true, signal: {
        action,
        symbol: llmSignal.symbol,
        direction: llmSignal.direction,
        strategy: llmSignal.strategy,
        statedPremium: llmSignal.statedPremium,
        legs: llmSignal.legs,
      }}

    case 'CLOSE':
      position = await findPosition(llmSignal, trader, deps)
      if (!position) return { ok: false, reason: `No open position for ${llmSignal.symbol}/${trader}` }

      return { ok: true, signal: {
        action: 'CLOSE',
        symbol: llmSignal.symbol,
        direction: position.direction,     // from DB, not LLM
        strategy: position.strategy,       // from DB, not LLM
      }}

    case 'TRIM':
      position = await findPosition(llmSignal, trader, deps)
      if (!position) return { ok: false, reason: `No open position for ${llmSignal.symbol}/${trader}` }

      return { ok: true, signal: {
        action: 'TRIM',
        symbol: llmSignal.symbol,
        direction: position.direction,
        strategy: position.strategy,
        exitPercent: llmSignal.exitPercent,
      }}

    case 'LEG_OFF':
      position = await findPosition(llmSignal, trader, deps)
      if (!position) return { ok: false, reason: `No open position for ${llmSignal.symbol}/${trader}` }

      return { ok: true, signal: {
        action: 'LEG_OFF',
        symbol: llmSignal.symbol,
        direction: position.direction,
        strategy: position.strategy,
        targetStrategy: llmSignal.targetStrategy,
      }}
```

### 4c. findPosition() — Fuzzy Match Logic

The normalizer reuses the existing fuzzy-match strategy from `execute.ts:226-243`:

```
findPosition(llmSignal, trader, deps):
  // 1. Try exact match (symbol + trader + strategy hint from LLM)
  strategy = llmSignal.strategy ?? llmSignal.direction  // use hint if available
  positions = await deps.getOpenPositions({ symbol, trader, strategy })
  if positions[0]: return positions[0]

  // 2. Fuzzy: drop strategy filter, match by symbol+trader only
  bySymbol = await deps.getOpenPositions({ symbol, trader })
  if bySymbol.length === 1: return bySymbol[0]  // unambiguous

  // 3. Multiple positions on same symbol — ambiguous, fail
  if bySymbol.length > 1: return null  // caller reports reason

  return null
```

### 4d. Important: Position Lookup Moves to Normalizer

Today, `executeClose()`, `executeTrim()`, and `executeLegOff()` each independently call `findPosition()`. After this change:
- The normalizer calls `findPosition()` once and fills direction/strategy
- The executor receives an `InternalSignal` with direction/strategy already resolved
- The executor still needs the position for `tradeId`, `existing.legs`, etc. — it keeps its own `getOpenPositions` call but no longer needs fuzzy matching

**Design choice**: The executor's position lookup becomes a simple exact match (symbol + trader + strategy), because the normalizer has already resolved strategy. This eliminates the fuzzy-match fallback from the executor entirely.

---

## 5. DB Schema Changes

### 5a. `message_intents.signals` Column

**Current**: `$type<Signal[]>()`
**New**: `$type<LLMSignal[]>()`

This is a JSON column, so no migration needed — just update the type annotation.

```ts
// src/db/schema.ts — message_intents table
signals: text('signals', { mode: 'json' }).$type<LLMSignal[]>(),
```

### 5b. `message_labels.signals` Column

**Current**: `$type<Signal[]>()`
**New**: `$type<LLMSignal[]>()`

Same change. Labels store what the LLM should have produced, so they use the LLM-facing type.

```ts
// src/db/schema.ts — message_labels table
signals: text('signals', { mode: 'json' }).$type<LLMSignal[]>(),
```

### 5c. `trades.direction` and `trades.strategy` Columns

**No change needed.** These are already `text()` columns storing string values. The InternalSignal type ensures only valid values reach `recordTrade()`.

### 5d. `trade_events.action` Column

**No change needed.** Already stores `'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF'` as text. The 5-action enum is pipeline-internal.

### 5e. Enum Schema Exports (for future text({ enum }) migration)

If we later want to add Drizzle `text({ enum: ... })` constraints:

```ts
// src/lib/enums.ts — add:
export const PipelineActionSchema = z.enum(['OPEN', 'CLOSE', 'ADD', 'TRIM', 'LEG_OFF']);
export type PipelineAction = z.infer<typeof PipelineActionSchema>;

// Then in schema.ts for trades/trade_events:
// action: text('action', { enum: PipelineActionSchema.options }).notNull()
```

This is NOT required for the initial migration but is the recommended path forward.

---

## 6. Module Ownership Map

| Type | File | Exports |
|---|---|---|
| `LLMSignal`, `LLMSignalSchema`, `LLMIntentSchema` | `src/agent/schemas.ts` | Named exports |
| `InternalSignal`, `PipelineAction`, `SignalLeg` | `src/pipeline/types.ts` | Named exports |
| `normalizeSignal`, `NormalizeDeps`, `NormalizeResult` | `src/pipeline/normalize-signal.ts` | Named exports |
| `DirectionSchema`, `StrategySchema`, `TradeActionSchema` | `src/lib/enums.ts` | Named exports (unchanged) |
| `TradeLegSchema`, `TradeLeg` | `src/db/schema.ts` | Named exports (unchanged) |

### Re-export Rules

- `src/db/schema.ts` re-exports `LLMSignal` (not `Signal`) for JSON column types
- `src/pipeline/execute.ts` imports `InternalSignal` from `./types.js`
- `src/agent/schemas.ts` does NOT import from `src/pipeline/` (no circular deps)

### Deleted Exports (after migration)

| Export | File | Replacement |
|---|---|---|
| `Signal` (type) | `src/agent/schemas.ts` | `LLMSignal` |
| `SignalSchema` (Zod) | `src/agent/schemas.ts` | `LLMSignalSchema` |
| `TradeActionSchema` usage in `SignalSchema` | `src/agent/schemas.ts` | `LLMIntentSchema` |

---

## 7. Edge Cases the Normalizer Must Handle

### 7a. OPEN Intent + Position Already Exists → ADD

The LLM says OPEN, but the trader already has a position on this symbol+strategy. The normalizer maps `intent: 'OPEN'` to `action: 'ADD'`.

**Today's behavior**: The `executeAdd()` function in `execute.ts:461-463` already handles this by falling through to `executeOpen()` when no position exists. The normalizer inverts this: OPEN is the default, ADD is the upgrade when a position exists.

**Subtle difference**: Today, `executeAdd()` re-checks for position existence. With the normalizer, the position lookup happens once (in normalizer), and `executeAdd()` receives a pre-resolved ADD action. The executor still does its own position lookup for the `tradeId`, but it no longer needs to fall through.

### 7b. CLOSE with Wrong Strategy Hint

LLM emits `{ intent: 'CLOSE', symbol: 'AAPL', strategy: 'CALL' }` but the open position is a CDS. The normalizer's fuzzy match finds the CDS position and outputs `{ action: 'CLOSE', strategy: 'CDS' }`. The LLM hint is discarded.

### 7c. CLOSE with No Position

No open position found for symbol+trader. Normalizer returns `{ ok: false, reason: '...' }`. The caller (executeSignals) records this as `{ executed: false, reason }` — same as today.

### 7d. CLOSE with Multiple Positions on Same Symbol

Trader has both a CALL and a CDS open on AAPL. LLM emits `{ intent: 'CLOSE', symbol: 'AAPL' }` with no strategy hint. Fuzzy match finds 2 positions — ambiguous.

**Resolution**: If `llmSignal.strategy` is provided, use it as a filter. If not, and multiple positions match, return `{ ok: false, reason: 'Ambiguous: 2 open positions on AAPL' }`.

### 7e. TRIM with exitPercent at Boundary

`exitPercent: 1.0` = full close. The normalizer passes it through as TRIM with `exitPercent: 1.0`. The executor's existing logic in `record-trade.ts:289-301` already handles `remainingQty <= 0` by closing the trade. No normalizer intervention needed.

### 7f. LEG_OFF with Invalid targetStrategy

LLM emits `{ intent: 'LEG_OFF', symbol: 'AAPL', targetStrategy: 'CDS' }` but position is already a naked CALL (no spread). The normalizer does NOT validate this — it passes through and the executor's `existingLegs.find(l => l.action === 'SELL')` check at `execute.ts:627` catches it.

**Rationale**: The normalizer resolves identity (direction, strategy, position existence). The executor validates trade mechanics (leg presence, quantity).

### 7g. LLM Emits Direction on CLOSE (Hint vs Authority)

LLM emits `{ intent: 'CLOSE', symbol: 'AAPL', direction: 'LONG' }`. Position is LONG. The normalizer uses the position's direction, not the LLM's. The LLM direction is discarded — it's a hint, not authoritative.

**Why**: The position's direction is ground truth. The LLM may misinterpret "Exit Long AAPL" as direction=LONG when the trader means "exit my long position" (which is correct but fragile). Using DB state is always correct.

### 7h. Race Condition: Position Closed Between Normalize and Execute

Normalizer finds position, fills direction/strategy. By the time executor runs, position is gone (e.g., concurrent sweepExpired). Executor's own `getOpenPositions` call returns empty.

**Handling**: Executor returns `{ executed: false, reason: 'No open position' }`. This is the same as today — the normalizer doesn't change the race condition surface.

### 7i. Empty Signals Array

LLM emits `{ decision: 'EXECUTE', signals: [] }`. The existing `AgentDecisionSchema.refine()` already rejects this. No normalizer change needed.

### 7j. Existing `message_intents` Rows with Old Schema

Old rows have `Signal[]` in the `signals` JSON column (with `action` field). New code expects `LLMSignal[]` (with `intent` field).

**Migration strategy**: The normalizer accepts BOTH shapes during transition via a compat adapter:

```ts
function adaptLegacySignal(raw: unknown): LLMSignal {
  const obj = raw as Record<string, unknown>;
  if ('action' in obj && !('intent' in obj)) {
    // Legacy Signal -> LLMSignal
    return {
      intent: obj.action === 'ADD' ? 'OPEN' : obj.action,
      symbol: obj.symbol,
      direction: obj.direction,      // may be undefined (fine for exits)
      strategy: obj.strategy,        // may be undefined (fine for exits)
      statedPremium: obj.statedPremium,
      exitPercent: obj.exitPercent,
      legs: obj.legs,
      targetStrategy: obj.targetStrategy,
    } as LLMSignal;
  }
  return LLMSignalSchema.parse(raw);
}
```

**Scope**: This adapter lives in the normalizer module and is used ONLY when reading from DB. New LLM outputs go through `LLMSignalSchema.parse()` directly. The adapter is deleted after one full re-extraction cycle (bump `INTENT_VERSION` to 6).

---

## 8. AgentDecisionSchema Update

The `AgentDecisionSchema` in `schemas.ts` wraps the signal array:

```ts
// src/agent/schemas.ts (new)
export const AgentDecisionSchema = z.object({
  decision: z.enum(['EXECUTE', 'SKIP', 'MANUAL_REVIEW']),
  reasoning: z.string(),
  signals: z.array(LLMSignalSchema).optional(),
}).refine(
  d => d.decision !== 'EXECUTE' || (d.signals && d.signals.length > 0),
  { message: 'EXECUTE requires at least one signal' },
);
```

No structural change — just swap `SignalSchema` to `LLMSignalSchema`.

---

## 9. PipelineResult Update

```ts
// src/pipeline/execute.ts (updated)
export type PipelineResult = {
  signal: InternalSignal;  // was: Signal
  executed: boolean;
  reason?: string;
  tradeId?: string;
  orderId?: string;
};
```

Downstream consumers that inspect `result.signal.action` continue to work — `InternalSignal.action` is a superset of `LLMSignal.intent`.

---

## 10. Impact on Eval Framework

`src/lib/eval.ts` compares label signals vs intent signals field-by-field. Both sides store `LLMSignal[]`.

**Changes needed**:
- `compareSignals()`: Compare `.intent` instead of `.action`
- `compareLabelsVsIntents()`: Same field — `ls.intent` vs `is_.intent`
- `extractStrikes()`: Unchanged (accesses `.legs`)
- All other field comparisons: `direction`, `strategy`, `symbol`, `statedPremium` — unchanged

**Note**: Labels created with old `Signal` schema have `action` not `intent`. The eval code needs the same legacy adapter from section 7j, or we re-export `action` as an alias. Recommended: update the eval comparison to check for both field names during transition:

```ts
const labelAction = ls.intent ?? (ls as any).action;
```

---

## 11. Summary of New/Modified Files

| File | Change |
|---|---|
| `src/agent/schemas.ts` | Replace `SignalSchema`/`Signal` with `LLMSignalSchema`/`LLMSignal`. Keep `SignalLegSchema`. Update `AgentDecisionSchema`. |
| `src/pipeline/types.ts` | **NEW**: `InternalSignal`, `PipelineAction`, re-export `SignalLeg` |
| `src/pipeline/normalize-signal.ts` | **NEW**: `normalizeSignal()`, `NormalizeDeps`, `NormalizeResult`, legacy adapter |
| `src/pipeline/execute.ts` | Change `Signal` imports to `InternalSignal`. Call `normalizeSignal()` in `executeSignals()`. Remove `findPosition()` fuzzy logic from executors. |
| `src/lib/enums.ts` | Add `PipelineActionSchema` (optional, for future DB enum constraint) |
| `src/db/schema.ts` | Update `$type<>` annotations: `Signal` -> `LLMSignal` on `message_intents.signals`, `message_labels.signals` |
| `src/lib/eval.ts` | Update `.action` -> `.intent` comparisons |
| `src/agent/deterministic-skips.ts` | `shouldSkipSignal()` takes `InternalSignal` instead of `Signal` |
| `src/trading/trade-agent.ts` | `onSignal()` takes `InternalSignal` (or stays on `LLMSignal` + normalizes internally — TBD by migration-mapper) |
| `web/app/messages/intent-strip.tsx` | Update `Signal` import to `LLMSignal` |
| `web/app/messages/actions.ts` | Update `Signal` import to `LLMSignal` |
