# Signal Redesign — Migration Checklist
## Per-File Consumer Map

Scope: splitting `LLMSignal` (4 intents) from `InternalSignal` (5 actions), adding DB enum
narrowing, making `direction`/`strategy` optional on exit signals.

---

## Background: What Changes

| Concept | Today | After Redesign |
|---|---|---|
| LLM output type | `Signal` (action ∈ all 5) | `LLMSignal` (action ∈ OPEN/CLOSE/ADD/TRIM/LEG_OFF — same set, but typed separately) |
| Exit signals | `direction` + `strategy` required | `direction` + `strategy` optional on CLOSE/TRIM/LEG_OFF |
| Internal pipeline type | `Signal` (same type re-used) | `InternalSignal` (action ∈ same 5, always has direction+strategy filled in by normalizer) |
| Normalizer | none | new `normalizeSignal(llm: LLMSignal, existing: Trade): InternalSignal` function |
| DB enum columns | plain `text()` columns | `TradeAction`, `Direction`, `Strategy` Zod-narrowed types via `$type<>()` |

---

## File-by-File Checklist

---

### `src/agent/schemas.ts`
**Role**: Defines `Signal` / `SignalSchema` / `AgentDecisionSchema` / `LabelResultSchema`

**Current code**:
```ts
export const SignalSchema = z.object({
  action: TradeActionSchema,        // all 5 actions
  direction: DirectionSchema,       // REQUIRED always
  strategy: StrategySchema,         // REQUIRED always
  ...
})
```

**What changes**:
- [ ] Define `LLMSignalSchema` with `direction` and `strategy` optional on exit actions (CLOSE, TRIM, LEG_OFF).
  ```ts
  export const LLMSignalSchema = z.object({
    action: TradeActionSchema,
    symbol: z.string().min(1),
    direction: DirectionSchema.optional(),   // optional for CLOSE/TRIM/LEG_OFF
    strategy: StrategySchema.optional(),     // optional for CLOSE/TRIM/LEG_OFF
    ...
  }).refine(...)
  ```
- [ ] Define `InternalSignalSchema` with `direction` and `strategy` required (filled by normalizer).
  ```ts
  export const InternalSignalSchema = LLMSignalSchema.extend({
    direction: DirectionSchema,    // always present
    strategy: StrategySchema,      // always present
  })
  ```
- [ ] Export `type LLMSignal = z.infer<typeof LLMSignalSchema>` and `type InternalSignal = ...`
- [ ] Keep `Signal` as a type alias for `InternalSignal` for backward compat during migration (remove after).
- [ ] Update `AgentDecisionSchema.signals` to use `LLMSignalSchema`.
- [ ] `LabelResultSchema` is unchanged — it already has nullable fields; no action needed.

**Why**: LLM only knows symbol+action for exits; the pipeline looks up existing position to fill direction/strategy. `InternalSignal` is the contract for execute.ts.

**Risk**: HIGH — this is the central type that cascades everywhere.

---

### `src/agent/tool-factory.ts`
**Role**: Defines JSON schema for `submit_decision` tool (what the LLM sees)

**Current code** (line 98):
```ts
required: ['action', 'symbol', 'direction', 'strategy'],
```

**What changes**:
- [ ] Remove `direction` and `strategy` from `required` array in `submitDecisionTool()`.
- [ ] Keep them as optional properties in the `properties` object (they are already there).
- [ ] No TypeScript type changes needed — JSON schema is untyped `Record<string, unknown>`.

**Why**: The LLM tool schema must match what LLMSignalSchema accepts. Requiring direction/strategy on exits causes LLM to fabricate values.

**Risk**: LOW — JSON schema only, no TS type impact.

---

### `src/intents/extract-intent.ts`
**Role**: LLM call site; validates tool output with `SubmitDecisionInput`

**Current code** (line 388–389):
```ts
const parsed = SubmitDecisionInput.safeParse(input);
if (parsed.success) return parsed.data satisfies TaskResult;
```

**What changes**:
- [ ] `SubmitDecisionInput` will use `LLMSignalSchema` via `AgentDecisionSchema` — no direct change needed here once schemas.ts is updated.
- [ ] Verify `INTENT_SYSTEM_PROMPT` examples are consistent with optional fields (see `prompt-engineer` task).
- [ ] The system prompt examples for CLOSE/TRIM/LEG_OFF already omit direction/strategy in example outputs — confirm they're consistent after schema change.

**Why**: This is the LLM entry point. The updated schema validates LLM output permissively.

**Risk**: LOW — schema change propagates automatically; prompt is reviewed separately.

---

### `src/pipeline/execute.ts`
**Role**: Main execution pipeline; dispatches on `signal.action`

**Current code**: Accepts `Signal` throughout. All 5 executor functions take `signal: Signal`.

**What changes**:
- [ ] Change `executeSignal(signal: Signal, ...)` → `executeSignal(signal: InternalSignal, ...)`
- [ ] Change `executeSignals(signals: Signal[], ...)` → `executeSignals(signals: InternalSignal[], ...)`
- [ ] Change `buildOrderFromSignal(signal: Signal, ...)` → `buildOrderFromSignal(signal: InternalSignal, ...)`
- [ ] Change `PipelineResult.signal` type from `Signal` to `InternalSignal`
- [ ] All internal executor functions (`executeOpen`, `executeClose`, `executeAdd`, `executeTrim`, `executeLegOff`) take `InternalSignal`.
- [ ] **Remove all `existing.direction as 'LONG' | 'SHORT'` casts** — they appear in 7 places (lines 401, 420, 435, 562, 580, 596, 655, 675). Once DB columns are narrowed via `$type<Direction>()`, these casts become unnecessary.
- [ ] **Remove all `existing.strategy as Signal['strategy']` casts** — appear in 3 places (lines 408, 568, 643). Same reason.
- [ ] `buildOrderParams(signal: Signal, ...)` → use `InternalSignal`.
- [ ] `resolveSignalLegs(signal: Signal, ...)` → use `InternalSignal` (already fills direction/strategy internally).
- [ ] `findPosition()` — no type change needed (uses `signal.symbol`, `signal.strategy`). When `strategy` is optional on `LLMSignal`, normalizer fills it before this is called.

**Why**: The pipeline's invariant is that it always receives a fully-resolved signal. The `InternalSignal` type encodes this.

**Risk**: HIGH — many internal call sites. Mechanical changes once types are settled.

---

### `src/pipeline/execute.ts` — `PendingOrderContext`
**Current code** (line 33):
```ts
export type PendingOrderContext = {
  action: 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF';
  direction: 'LONG' | 'SHORT';
  ...
}
```

**What changes**:
- [ ] Import `TradeAction` and `Direction` from `src/lib/enums.ts` and use them here:
  ```ts
  action: TradeAction;
  direction: Direction;
  ```

**Risk**: LOW — purely mechanical type import.

---

### `src/trading/trade-agent.ts`
**Role**: `RuleBasedTradeAgent.onSignal(signal: Signal, ...)`; accesses `signal.action`, `signal.strategy`, `signal.direction`.

**Current code** (lines 94–135):
- `signal.action === 'OPEN' || signal.action === 'ADD'` (line 94)
- `signal.strategy` (lines 96, 107, 114, 128)
- `signal.direction` (line 128)
- Returns `Action` with `signal: Signal` in `PLACE_ORDER`.

**What changes**:
- [ ] `onSignal(signal: Signal, ...)` → `onSignal(signal: LLMSignal, ...)` — this is the LLM-facing entry point.
- [ ] `Action` type: `{ type: 'PLACE_ORDER'; signal: LLMSignal; ... }` — `LLMSignal` passes to runner, then runner normalizes before pipeline.
- [ ] `signal.strategy` on line 107 is called before normalization — guard with `signal.strategy ?? 'STOCK'` when checking `hasLegs`.
- [ ] `signal.direction` on line 128 — guard: when building order preview without legs, direction is informational only (already falls back in pipeline).
- [ ] `buildOrderFromSignal(signal, quantity, referenceDate)` on line 126 — only called when `hasLegs`. Since hasLegs implies OPEN/ADD (direction+strategy present), safe to cast `signal as InternalSignal` here or pass after normalization.

**Why**: TradeAgent receives raw LLM output; it must accept LLMSignal. The PLACE_ORDER action carries the LLMSignal forward; runner normalizes it before pipeline execution.

**Risk**: MEDIUM — `signal.strategy` access on exits needs care.

---

### `src/agent/deterministic-skips.ts`
**Role**: `shouldSkipSignal(signal: Signal, ...)` — checks `signal.action` and `signal.strategy`.

**Current code** (lines 116–117):
```ts
if (signal.action !== 'OPEN' && signal.action !== 'ADD') return null;
if (allowedStrategies.includes(signal.strategy)) return null;
```

**What changes**:
- [ ] `shouldSkipSignal(signal: LLMSignal, ...)` — accepts LLMSignal.
- [ ] Line 117: `signal.strategy` may be `undefined` for CLOSE/TRIM/LEG_OFF, but line 116 already returns null for non-OPEN/ADD, so `signal.strategy` is accessed only when action is OPEN or ADD. On OPEN/ADD, `strategy` is still required. Add `.refine()` to `LLMSignalSchema` enforcing direction+strategy on OPEN/ADD.

**Why**: Exits always pass through (line 116 short-circuits). OPEN/ADD always have strategy. No functional change needed.

**Risk**: LOW — the existing early return makes this safe.

---

### `src/trades/record-trade.ts`
**Role**: Single write path for all trade mutations. `RecordTradeInput.action` uses string literals.

**Current code**:
```ts
export type RecordTradeInput = {
  action: 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF';
  direction?: 'LONG' | 'SHORT';
  ...
}
```
- `existing.direction as 'LONG' | 'SHORT'` cast on lines 180, 267.

**What changes**:
- [ ] Import `TradeAction` and `Direction` from `src/lib/enums.ts`.
- [ ] `action: TradeAction` (replaces string literal union — same values, just uses canonical type).
- [ ] `direction?: Direction` (replaces inline union).
- [ ] **Remove `existing.direction as 'LONG' | 'SHORT'` casts** (lines 180, 267) once `trades.direction` column is narrowed to `Direction` via DB schema `$type<Direction>()`.

**Why**: Canonical types prevent drift. DB narrowing eliminates casts.

**Risk**: LOW — purely mechanical. Values are identical.

---

### `src/db/schema.ts`
**Role**: Drizzle table definitions; exports `Signal` type.

**Current code**:
```ts
direction: text('direction').notNull()     // plain text
strategy:  text('strategy').notNull()      // plain text
```
Also: `export type { Signal } from '../agent/schemas.js'`

**What changes**:
- [ ] Narrow `trades.direction` to `Direction` type:
  ```ts
  direction: text('direction').notNull().$type<Direction>()
  ```
- [ ] Narrow `trades.strategy` to `Strategy` type (if appropriate — strategy evolves via LEG_OFF, but always stays in the enum set):
  ```ts
  strategy: text('strategy').notNull().$type<Strategy>()
  ```
- [ ] Narrow `tradeEvents.direction` and `tradeEvents.strategy` similarly.
- [ ] Update `export type { Signal }` re-export: decide whether to export `InternalSignal` instead, or both. Since `Signal` is stored in `messageIntents.signals` and `messageLabels.signals`, and those are LLM outputs, consider:
  ```ts
  export type { LLMSignal, InternalSignal } from '../agent/schemas.js'
  ```
  Then update all consumers that use `Signal` from this path.
- [ ] `messageIntents.signals: text(...).json().$type<LLMSignal[]>()` (was `Signal[]`).
- [ ] `messageLabels.signals: text(...).json().$type<LLMSignal[]>()` (was `Signal[]`).
- [ ] `TaskResult.signals?: LLMSignal[]` — this is the LLM decision output.

**Why**: `$type<Direction>()` eliminates the `as 'LONG' | 'SHORT'` casts in execute.ts and record-trade.ts. The DB column is still stored as text; Drizzle just narrows the inferred TypeScript type.

**Risk**: MEDIUM — type narrowing cascades to all `.select()` call sites. No runtime change.

---

### `src/db/parse.ts`
**Role**: Uses `DirectionSchema` to parse raw DB values.

**Current code** (line 33):
```ts
const result = DirectionSchema.safeParse(raw);
```

**What changes**:
- [ ] No change needed if `$type<Direction>()` is added on the DB column. The `parse.ts` parser is for raw external input (broker responses) — still valid.

**Risk**: NONE.

---

### `src/lib/eval.ts`
**Role**: `compareSignals(labelSignals: Signal[], intent)` — accesses `signal.action`, `signal.direction`, `signal.strategy`.

**Current code** (lines 72–74):
```ts
if (normalizeNull(ls.action) !== normalizeNull(is_.action)) return false;
if (normalizeNull(ls.direction) !== normalizeNull(is_.direction)) return false;
if (normalizeNull(ls.strategy) !== normalizeNull(is_.strategy)) return false;
```

**What changes**:
- [ ] `labelSignals: Signal[]` → `labelSignals: LLMSignal[]` (labels are LLM outputs stored in DB).
- [ ] `intent.signals: Signal[] | null` → `LLMSignal[] | null`.
- [ ] `normalizeNull(ls.direction)` and `normalizeNull(is_.direction)` now correctly handle `undefined` (normalizeNull converts `undefined` → `null`) — no behavior change needed.

**Why**: Labels and intents both store LLMSignal (what the LLM returned). Comparison is still apples-to-apples.

**Risk**: LOW — `normalizeNull` already handles undefined gracefully.

---

### `src/backtest/runner.ts`
**Role**: Orchestrates backtest. Calls `tradeAgent.onSignal(signal, ...)` and `executeSignals(executeableSignals, ...)`.

**Current code** (line 704):
```ts
.map(r => `${r.signal.action} ${r.signal.symbol}: ${r.reason}`)
```
Also (lines 665–667):
```ts
.filter((a): a is Extract<Action, { type: 'PLACE_ORDER' }> => a.type === 'PLACE_ORDER')
.map(a => a.signal);
```

**What changes**:
- [ ] After extracting `PLACE_ORDER` signals (line 667), normalize each: `a.signal` is `LLMSignal`. Before calling `executeSignals`, map through normalizer:
  ```ts
  const executeableSignals = allActions
    .filter((a): a is Extract<Action, { type: 'PLACE_ORDER' }> => a.type === 'PLACE_ORDER')
    .map(a => normalizeSignal(a.signal, /* existing position from prefetched */ ...));
  ```
  OR: normalizer runs inside `executeSignal()` if pipeline handles it — coordinate with type-designer.
- [ ] `PipelineResult.signal` type changes to `InternalSignal` — access on line 704 is `r.signal.action` and `r.signal.symbol`, still valid.

**Why**: This is where LLMSignal → InternalSignal conversion happens before pipeline execution.

**Risk**: MEDIUM — normalizer needs prefetched position data (already available in runner context).

---

### `web/app/messages/actions.ts`
**Role**: Server actions; `Signal` type imported from `src/agent/schemas`.

**Current code** (line 9):
```ts
import type { Signal } from '../../../src/agent/schemas';
```
Uses `Signal[]` for `saveLabel`, `approveIntent`, `compareSignals`.

**What changes**:
- [ ] `import type { LLMSignal } from '../../../src/agent/schemas'` (labels store LLM output).
- [ ] `saveLabel(messageId, signals: LLMSignal[], ...)` — update signature.
- [ ] `approveIntent(messageId, intent: MessageIntent)` — `intent.signals` is `LLMSignal[] | null`.
- [ ] `compareSignals((label.signals as LLMSignal[]) ?? [], intent)` — update cast.

**Risk**: LOW — web-only UI code; no pipeline impact.

---

### `web/app/messages/intent-strip.tsx`
**Role**: Signal editor UI; uses `Signal` from `src/db/schema`.

**Current code**:
```ts
import type { Signal, MessageLabel } from '../../../src/db/schema';
```
Accesses `signal.action`, `signal.direction`, `signal.strategy`, `signal.symbol`, `signal.statedPremium`, `signal.legs`, `signal.exitPercent`.

**What changes**:
- [ ] `import type { LLMSignal } from '../../../src/db/schema'` (or from agent/schemas directly).
- [ ] All `signal: Signal` → `signal: LLMSignal`.
- [ ] `BLANK_SIGNAL: Signal` → `BLANK_SIGNAL: LLMSignal`:
  ```ts
  const BLANK_SIGNAL: LLMSignal = {
    action: 'OPEN',
    symbol: '',
    direction: 'LONG',
    strategy: 'STOCK',
  };
  ```
- [ ] `draft.direction` in `Select` — value could be `undefined` for new CLOSE signals. UI should default to `'LONG'` in SelectTrigger placeholder.
- [ ] `draft.strategy` same — default to `'STOCK'` as placeholder.
- [ ] Line 131: `value={draft.direction}` — needs fallback: `value={draft.direction ?? 'LONG'}`.
- [ ] Line 138: `value={draft.strategy}` — needs fallback: `value={draft.strategy ?? 'STOCK'}`.

**Why**: UI allows editing LLM signal labels; the type must match what gets stored.

**Risk**: LOW — UI cosmetic. The saved value is correct; just needs undefined guard in controlled inputs.

---

### `web/app/messages/chat-bubble.tsx`
**Role**: Color-codes messages by action/direction.

**Current code** (lines 19–20):
```ts
if (action === 'CLOSE' || direction === 'SHORT') return 'border-l-loss';
if (action === 'OPEN' || direction === 'LONG') return 'border-l-profit';
```

**What changes**:
- [ ] No structural change. `direction` may now be `undefined` for CLOSE signals, but the first condition (`action === 'CLOSE'`) already handles that case before checking direction.

**Risk**: NONE — existing logic is already safe for optional direction.

---

### `web/app/page.tsx` and `web/app/components/signal-sheet.tsx`
**Role**: Message list; uses `actionHint` and `directionHint` from message (not Signal).

**Current code**: Uses `actionHint === 'CLOSE'`, `directionHint === 'SHORT'`, etc.

**What changes**:
- [ ] No changes — these use message-level hints (strings), not the Signal type.

**Risk**: NONE.

---

### `web/app/trades/[id]/event-timeline.tsx`
**Role**: Renders `TradeEvent.action` — uses string switch.

**Current code** (lines 21–59): `switch (event.action)` with string cases.

**What changes**:
- [ ] No change needed — `tradeEvents.action` is a plain `text()` column storing action strings. Switch over strings continues to work.
- [ ] Optional: import `TradeAction` and use it as the switch discriminant type for safety.

**Risk**: NONE.

---

### `web/app/components/compact-event-chain.tsx`
**Role**: Same pattern as event-timeline.tsx — string switch on event.action.

**What changes**: Same as event-timeline.tsx — no required change.

**Risk**: NONE.

---

### `web/app/trades/[id]/page.tsx` and `web/app/components/trades-table-client.tsx`
**Role**: Uses `trade.status === 'OPEN'` string literal.

**What changes**:
- [ ] No change — `trade.status` is not part of the Signal redesign.

**Risk**: NONE.

---

### `src/trades/filters.ts`
**Role**: `isOpen = eq(trades.status, 'OPEN')` — string literal.

**What changes**:
- [ ] No change needed. `status` column is not narrowed in this redesign.

**Risk**: NONE.

---

### `src/parsing/badges.ts`
**Role**: Badge detection uses inline `'OPEN' | 'CLOSE'` type for `actionHint`.

**Current code** (lines 9–36): Inline `Record<string, { direction?: 'LONG'|'SHORT'; action?: 'OPEN'|'CLOSE' }>`.

**What changes**:
- [ ] Optional: import `Direction` from enums and use it for `direction?: Direction` in the record. Not strictly necessary since this is message-level parsing (pre-signal).

**Risk**: NONE (optional cleanup).

---

### `src/backtest/historical-loader.ts`
**Role**: `DirectionHintEnum = DirectionSchema.nullable()`.

**What changes**:
- [ ] No change — uses `DirectionSchema` from enums correctly.

**Risk**: NONE.

---

### `src/broker/order-schemas.ts`
**Role**: Uses `DirectionSchema` for order direction.

**What changes**:
- [ ] No change — order direction uses the same `Direction` type.

**Risk**: NONE.

---

### `src/trades/rebuild.ts`
**Role**: Rebuilds trade state from events. `existing.direction as 'LONG' | 'SHORT'` casts on lines 95, 123.

**What changes**:
- [ ] Once `tradeEvents.direction` column is narrowed to `Direction` via `$type<Direction>()` in schema.ts, remove the casts.

**Risk**: LOW — mechanical cast removal.

---

## Summary: The Normalizer

The key new function needed is `normalizeSignal()`. It lives in a new file (e.g., `src/agent/normalize.ts` or inline in the pipeline):

```ts
import type { LLMSignal } from './schemas.js';
import type { InternalSignal } from './schemas.js';
import type { Trade } from '../db/schema.js';

/**
 * Promote an LLMSignal to InternalSignal by filling in direction+strategy
 * from the existing position when they were omitted (exit signals).
 *
 * Caller: runner.ts, between PLACE_ORDER extraction and executeSignals().
 */
export function normalizeSignal(
  signal: LLMSignal,
  existingPosition?: Trade,
): InternalSignal {
  const direction = signal.direction
    ?? (existingPosition?.direction as Direction | undefined)
    ?? 'LONG'; // fallback: pipeline findPosition() will correct this
  const strategy = signal.strategy
    ?? (existingPosition?.strategy as Strategy | undefined)
    ?? 'STOCK'; // fallback: pipeline fuzzy match will handle mismatches
  return { ...signal, direction, strategy };
}
```

The normalizer is called in the runner after prefetch (position data is available). The pipeline's `findPosition()` still does its own lookup for correctness, but the normalizer ensures the type invariant is met before the pipeline is called.

---

## `as 'LONG' | 'SHORT'` Cast Inventory

All 12 casts that will be eliminated by DB column narrowing:

| File | Line | Field | Eliminated by |
|---|---|---|---|
| `src/pipeline/execute.ts` | 401 | `existing.direction` | `$type<Direction>()` on `trades.direction` |
| `src/pipeline/execute.ts` | 420 | `existing.direction` | same |
| `src/pipeline/execute.ts` | 435 | `existing.direction` | same |
| `src/pipeline/execute.ts` | 562 | `existing.direction` | same |
| `src/pipeline/execute.ts` | 580 | `existing.direction` | same |
| `src/pipeline/execute.ts` | 596 | `existing.direction` | same |
| `src/pipeline/execute.ts` | 655 | `existing.direction` | same |
| `src/pipeline/execute.ts` | 675 | `existing.direction` | same |
| `src/trades/record-trade.ts` | 180 | `existing.direction` | same |
| `src/trades/record-trade.ts` | 267 | `existing.direction` | same |
| `src/trades/rebuild.ts` | 95 | `existing.direction` (from tradeEvents) | `$type<Direction>()` on `tradeEvents.direction` |
| `src/trades/rebuild.ts` | 123 | same | same |

---

## `as Signal['strategy']` Cast Inventory

All 3 casts that will be eliminated:

| File | Lines | Eliminated by |
|---|---|---|
| `src/pipeline/execute.ts` | 408, 568, 643 | `$type<Strategy>()` on `trades.strategy` |

---

## Risk Tiers

**HIGH** — type-system changes that cascade everywhere:
- `src/agent/schemas.ts` — defines the split types
- `src/pipeline/execute.ts` — main pipeline, 12 cast removals

**MEDIUM** — structural changes with logic implications:
- `src/backtest/runner.ts` — normalizer call site
- `src/trading/trade-agent.ts` — LLMSignal entry point, strategy access guards

**LOW** — mechanical import/type substitutions with no logic change:
- `src/agent/tool-factory.ts`
- `src/trades/record-trade.ts`
- `src/db/schema.ts`
- `src/lib/eval.ts`
- `web/app/messages/actions.ts`
- `web/app/messages/intent-strip.tsx`
- `src/trades/rebuild.ts`

**NONE** — read-only or using stable string literals:
- `web/app/trades/[id]/event-timeline.tsx`
- `web/app/components/compact-event-chain.tsx`
- `web/app/messages/chat-bubble.tsx`
- `web/app/page.tsx`
- `web/app/components/signal-sheet.tsx`
- `src/trades/filters.ts`
- `src/parsing/badges.ts`
- `src/backtest/historical-loader.ts`
- `src/broker/order-schemas.ts`
- `src/db/parse.ts`
- `src/orders/risk-check.ts`

---

## Files NOT Touched (confirmed safe)

- `src/backtest/sim-broker.ts` — uses `'OPEN'` / `'CLOSE'` string literals for `OrderStatus` (unrelated enum), not `TradeAction`.
- `src/broker/tradestation.ts` — same; `'OPEN'` is OrderStatus.
- `src/backtest/sim-broker-*.test.ts` — all `status === 'OPEN'` checks are OrderStatus, not TradeAction.
- `src/orders/order-manager.ts` — same.
- `src/reconciliation/reconciler.ts` — `trade.status !== 'OPEN'` is TradeStatus, not TradeAction.

---

## Migration Order (suggested phasing)

1. **Phase 1**: `src/lib/enums.ts` — export `TradeAction`, `Direction`, `Strategy` (already done).
2. **Phase 2**: `src/agent/schemas.ts` — define `LLMSignalSchema` / `InternalSignalSchema` / updated `AgentDecisionSchema`.
3. **Phase 3**: `src/db/schema.ts` — narrow `$type<Direction | Strategy>()` on trades/tradeEvents columns.
4. **Phase 4**: `src/agent/tool-factory.ts` — remove `direction`/`strategy` from required fields.
5. **Phase 5**: Create `normalizeSignal()` (new file or inline in runner).
6. **Phase 6**: `src/pipeline/execute.ts` + `src/trades/record-trade.ts` — update to `InternalSignal`, remove casts.
7. **Phase 7**: `src/trading/trade-agent.ts` + `src/agent/deterministic-skips.ts` — update to `LLMSignal`.
8. **Phase 8**: `src/backtest/runner.ts` — add normalizeSignal() call.
9. **Phase 9**: `src/lib/eval.ts` + `web/` files — update `Signal` → `LLMSignal`.
10. **Phase 10**: Remove `Signal` type alias.

Each phase should compile cleanly before moving to the next.

---

## Addendum: Items Requiring Explicit Coverage

### `deduplicateSignals` in `src/pipeline/execute.ts` (lines 723–750)

**Current code**:
```ts
function deduplicateSignals(signals: Signal[]): Signal[] {
  const key = `${signal.symbol}|${signal.action}|${signal.strategy}`;
```

**What changes**:
- [ ] `signals: Signal[]` → `signals: InternalSignal[]` (receives already-normalized signals).
- [ ] Dedup key uses `signal.strategy` — this is now guaranteed non-undefined on `InternalSignal`, so no guard needed.
- [ ] Return type `Signal[]` → `InternalSignal[]`.

**Why**: The dedup key includes `strategy`, which must always be present. Since normalization happens before `executeSignals()` is called, the input is always `InternalSignal[]` at this point.

**Risk**: LOW — mechanical type rename.

---

### `createSelectSchema` / `createInsertSchema` — Decision

**Current state**: `src/db/tick-cache-schema.ts` uses `createSelectSchema`/`createInsertSchema` from `drizzle-orm/zod`. The main `src/db/schema.ts` does NOT currently use them.

**Recommendation**: Do NOT add `createSelectSchema`/`createInsertSchema` to `schema.ts` as part of this redesign.

**Rationale**:
- `$type<Direction>()` and `$type<Strategy>()` on Drizzle columns achieves the TypeScript narrowing we need — zero runtime cost, no extra Zod schemas to maintain.
- `createSelectSchema` generates full Zod schemas from Drizzle tables. For the `trades` table, this would generate a schema that includes every column (including free-form `metadata`, `legs`, etc.). That schema would need customization and would diverge from the actual validation needs.
- The existing `RecordTradeInput` Zod validation (via `recordTrade()` checks) is sufficient for write-path boundary validation.
- CLAUDE.md rule: "Do not abstract ahead of need."

**Action**: No change. `$type<>()` annotations are the right tool here.

---

### `src/orders/risk-check.ts` — Explicit Coverage

**Current code** (lines 40, 46):
```ts
export async function checkRiskLimits(
  input: { symbol: string; strategy: string; trader: string; action?: string },
  ...
```
```ts
if (input.action === 'CLOSE' || input.action === 'TRIM') {
```

**What changes**:
- [ ] `action?: string` → `action?: TradeAction` — import `TradeAction` from `src/lib/enums.ts`.
- [ ] No behavior change — the string comparison at line 46 stays identical; TypeScript just narrows it.
- [ ] `strategy: string` stays as `string` — risk-check doesn't care about the full `Strategy` enum; it uses strategy for notional calculation and accepts unknown strategies gracefully.

**Why**: `action` is compared against specific TradeAction literals. Using `TradeAction` provides exhaustiveness checking if new actions are added.

**Risk**: LOW — import + type annotation only.

---

### `src/backtest/sim-broker.ts` line 427 — Clarification

```ts
result = await recordTrade({
  action: 'CLOSE',   // line 427
  ...
})
```

This is a `TradeAction` literal (calling `recordTrade` to close a position). It is NOT `OrderStatus`. This is already handled correctly by the existing `recordTrade` interface.

**What changes**:
- [ ] Once `RecordTradeInput.action` is typed as `TradeAction` (from the record-trade.ts change), TypeScript will validate this literal automatically. No code change needed in sim-broker.ts.

**Risk**: NONE.
