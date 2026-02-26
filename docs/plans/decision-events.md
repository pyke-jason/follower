# Decision Events: From Summary Row to Signal Timeline

## The Problem

`run_decisions` stores one coarse row per signal. A LIMIT order that takes 30 seconds to fill through 6 price-chase steps looks identical to one that filled instantly. A 422-retry that succeeded after LLM re-parse looks like a clean EXECUTE. The whole order lifecycle — placement, adjustment, fill/cancel — is ephemeral (logged at debug, never persisted).

**Impact**: 126/185 FAILs in a sample run are false negatives (working LIMIT orders recorded as FAIL before they fill). But even fixing that with `onSettled` (the original plan) still leaves us blind to *how* orders filled — how many chase steps, how much slippage from initial limit to fill, how long it took.

## The Vision

Evolve `run_decisions` from a summary table into an append-only **event stream**. Every meaningful state change — from parse through settlement — gets its own row. The "outcome" (EXECUTE/SKIP/FAIL) isn't a field you set prematurely; it's the final `SETTLED` event in the sequence.

```
message:abc → signal:0
  [+0ms]     PARSED           {path:'deterministic', action:'OPEN', symbol:'AAPL', strategy:'CALL', badges:['Long'], symbols:['AAPL']}
  [+120ms]   SIGNAL_RESOLVED  {legs:[...], limitPrice:4.50}
  [+130ms]   SIZED            {quantity:5, entryPrice:4.50, maxRisk:2250}
  [+135ms]   RISK_PASSED      {}
  [+200ms]   ORDER_PLACED     {orderId:'om-1', limitPrice:4.50, rules:{step:0.10, interval:5s}}
  [+5200ms]  ORDER_ADJUSTED   {orderId:'om-1', price:4.50→4.60, step:1}
  [+10200ms] ORDER_ADJUSTED   {orderId:'om-1', price:4.60→4.70, step:2}
  [+11800ms] ORDER_FILLED     {orderId:'om-1', filledPrice:4.65, slippage:+0.15}
  [+11850ms] TRADE_RECORDED   {tradeId:'xyz', action:'OPEN'}
  [+11850ms] SETTLED          {outcome:'EXECUTE', tradeId:'xyz'}
```

A failed close:
```
message:def → signal:0
  [+0ms]     PARSED           {path:'deterministic', action:'CLOSE', symbol:'TSLA', badges:['Exit']}
  [+80ms]    SIGNAL_RESOLVED  {tradeId:'existing-123', legs:[...], limitPrice:2.30}
  [+150ms]   ORDER_PLACED     {orderId:'om-2', limitPrice:2.30, rules:{step:0.15, interval:5s, maxSteps:20}}
  [+5150ms]  ORDER_ADJUSTED   {orderId:'om-2', price:2.30→2.15, step:1}
  ...
  [+100150ms] ORDER_ADJUSTED  {orderId:'om-2', price:0.20→0.05, step:20/20}
  [+100200ms] ORDER_CANCELLED {orderId:'om-2', reason:'maxSteps exhausted'}
  [+100200ms] SETTLED         {outcome:'FAIL', reason:'Working order cancelled after 20 chase steps'}
```

A 422 retry:
```
message:ghi → signal:0
  [+0ms]     PARSED           {path:'deterministic', action:'OPEN', symbol:'AAPL', strategy:'PDS', strikes:[342], badges:['Long']}
  [+100ms]   SIGNAL_RESOLVED  {legs:[{strike:342, ...}], limitPrice:1.20}
  [+200ms]   QUOTE_FAILED     {occSymbol:'AAPL 250117C00342000', error:'422 symbol not found'}
  [+250ms]   RETRY_LLM        {reason:'invalid strike', originalStrike:342}
  [+3500ms]  LLM_RESOLVED     {inputTokens:1200, outputTokens:400, correctedStrike:342.50}
  [+3600ms]  SIGNAL_RESOLVED  {legs:[{strike:342.5, ...}], limitPrice:1.25}
  [+3700ms]  ORDER_PLACED     {orderId:'om-3', limitPrice:1.25}
  [+8700ms]  ORDER_FILLED     {orderId:'om-3', filledPrice:1.30}
  [+8750ms]  TRADE_RECORDED   {tradeId:'abc', action:'OPEN'}
  [+8750ms]  SETTLED          {outcome:'EXECUTE', tradeId:'abc'}
```

A hard skip with full parse context:
```
message:jkl → (no signal)
  [+0ms]     PARSED           {path:'skip', reason:'Paper trade detected', badges:[], symbols:['SPY'], detectedStrategies:['CALL']}
  [+0ms]     SETTLED          {outcome:'SKIP', reason:'Paper trade detected'}
```

## Schema: Reuse `run_decisions`

No new table. Add an `event` column to `run_decisions` and use it as the discriminator. Existing columns map naturally:

- `outcome` — stays (only meaningful for `SETTLED` events; null for intermediate events)
- `phase` — stays (derived from event type, or kept for backward compat during transition)
- `reasoning` — stays (used by `SETTLED`, `ORDER_CANCELLED`, `RISK_BLOCKED`, etc.)
- `snapshot` — becomes the typed payload per event (already JSON)
- `signal_index` — stays
- `elapsed_ms` / `duration_ms` — stays (rename to `elapsed_ms` for clarity)
- `trade_id` — stays (set on `TRADE_RECORDED` and `SETTLED` events)
- `input_tokens` / `output_tokens` — stays (set on `LLM_RESOLVED` events)

Migration: add `event TEXT` column with default `'SETTLED'` so existing rows are valid settled events. Add partial index for fast summary queries.

```sql
ALTER TABLE run_decisions ADD COLUMN event TEXT NOT NULL DEFAULT 'SETTLED';
CREATE INDEX idx_run_decisions_settled ON run_decisions(backtest_run_id, event) WHERE event = 'SETTLED';
```

### Event Types (discriminated union)

| Event | Payload (in `snapshot` JSON) |
|-------|---------|
| `PARSED` | `{path, action, symbol, strategy, direction, strikes?, badges?, symbols?, detectedStrategies?, complexityFlags?, expiryHint?, premiumHint?, isLotto?, isStrangle?}` |
| `LLM_STARTED` | `{reason, complexityFlags?}` |
| `LLM_RESOLVED` | `{turns}` (tokens go in `input_tokens`/`output_tokens` columns) |
| `SIGNAL_RESOLVED` | `{orderType, legs[], limitPrice?, action, tradeId?}` — the concrete signal |
| `SIZED` | `{quantity, entryPrice, maxRisk?, spreadMaxRisk?}` |
| `RISK_PASSED` | `{}` |
| `RISK_BLOCKED` | `{reason}` (also in `reasoning` column) |
| `ORDER_PLACED` | `{orderId, orderType, limitPrice, side, adjustmentRules?}` |
| `ORDER_ADJUSTED` | `{orderId, fromPrice, toPrice, step, maxSteps?}` |
| `ORDER_FILLED` | `{orderId, filledPrice, filledAt, slippage?, commission?}` |
| `ORDER_CANCELLED` | `{orderId, reason}` |
| `QUOTE_FAILED` | `{occSymbol, error, invalidStrike?}` |
| `RETRY_LLM` | `{reason, failureContext}` |
| `TRADE_RECORDED` | `{tradeId, action}` (also sets `trade_id` column) |
| `SETTLED` | `{outcome}` (also sets `outcome` column, `reasoning`, `trade_id`) |

The `SETTLED` event is always the last event for a `(message_id, signal_index)` pair. Existing queries that filter on `outcome` continue to work — they just need `AND event = 'SETTLED'` (or rely on the partial index).

### What About `trade_events`?

**Stays.** `trade_events` is the source of truth for trade state mutations (OPEN, CLOSE, TRIM, ADD, LEG_OFF). `run_decisions` (now with events) is the source of truth for the *decision pipeline* — how we got from message to trade (or didn't). Different concerns. They share `trade_id` as a foreign key.

## The Emitter Pattern

### Current: Callback Threading (the cruft)

```
runner.ts              → TaskEnv.onDecision
  process-task.ts      → passes onDecision through
    orchestrator        → OrchestratorEnv.onDecision  (fires for SKIP)
    execute-resolved.ts → ExecuteEnv.onDecision        (fires per signal)
```

Three types (`TaskEnv`, `ExecuteEnv`, `OrchestratorEnv`) each carry `onDecision: (row: DecisionRow) => Promise<void>`. The `DecisionRow` type is a grab-bag: `inputTokens`/`outputTokens` only relevant for LLM events, `tradeId` only for fills, `snapshot` is untyped JSON. Each layer constructs a `DecisionRow` with different fields filled in — it's the same callback signature threaded everywhere but used completely differently at each site.

### New: Signal Event Emitter

```typescript
// src/decisions/emitter.ts

export type SignalEventEmitter = {
  emit: (event: string, payload?: Record<string, unknown>, opts?: {
    signalIndex?: number | null;
    outcome?: string;
    reasoning?: string;
    tradeId?: string;
    inputTokens?: number;
    outputTokens?: number;
  }) => Promise<void>;
};

export function createEmitter(scope: {
  messageId: string;
  backtestRunId?: string;
  taskId?: string;
}): SignalEventEmitter {
  const startMs = Date.now();
  return {
    emit: async (event, payload, opts) => {
      await db.insert(schema.runDecisions).values({
        messageId: scope.messageId,
        backtestRunId: scope.backtestRunId,
        taskId: scope.taskId,
        event,
        signalIndex: opts?.signalIndex ?? null,
        outcome: opts?.outcome ?? null,
        reasoning: opts?.reasoning ?? null,
        tradeId: opts?.tradeId ?? null,
        snapshot: payload ?? {},
        durationMs: Date.now() - startMs,
        inputTokens: opts?.inputTokens ?? null,
        outputTokens: opts?.outputTokens ?? null,
      });
    },
  };
}
```

Embarrassingly simple. One function, one insert. The runner creates it per-message, passes it everywhere.

### Runner wiring (backtest)

```typescript
// Per message — create emitter, pass through
const emitter = createEmitter({
  messageId: msg.id,
  backtestRunId: ctx.runId,
});
await processTask(task, { ...env, emitter });
```

### Runner wiring (live)

```typescript
const emitter = createEmitter({
  messageId: task.messageId,
  taskId: task.id,
});
```

### Who emits what

| Layer | Events emitted |
|-------|---------------|
| Orchestrator (parse) | `PARSED` |
| Orchestrator (skip) | `SETTLED` (outcome: SKIP) |
| Orchestrator (LLM path) | `LLM_STARTED`, `LLM_RESOLVED` |
| Orchestrator (resolve) | `SIGNAL_RESOLVED` |
| Executor (sizing) | `SIZED` |
| Executor (risk) | `RISK_PASSED` or `RISK_BLOCKED` |
| Executor (order) | `ORDER_PLACED` |
| Executor (quote error) | `QUOTE_FAILED`, `RETRY_LLM` |
| OrderManager (chase) | `ORDER_ADJUSTED` |
| Runner (onFill) | `ORDER_FILLED`, `TRADE_RECORDED`, `SETTLED` |
| Runner (onCancel) | `ORDER_CANCELLED`, `SETTLED` |
| Executor (sync fill) | `ORDER_FILLED`, `TRADE_RECORDED`, `SETTLED` |

The emitter is **one object** passed everywhere. No `onDecision` callback on three separate env types.

## OrderManager: Emitting Chase Events

The OrderManager currently logs price chase steps at `debug` level and they're lost. To persist them:

**Option: `onAdjust` callback** (follows existing `onFill`/`onCancel` pattern)

```typescript
export type OrderManagerConfig = {
  broker: BrokerService;
  clock: () => Date;
  onFill?: (order: FilledWorkingOrder) => void | Promise<void>;
  onCancel?: (order: WorkingOrder) => void;
  onAdjust?: (order: WorkingOrder, fromPrice: number, toPrice: number, step: number) => void | Promise<void>;
  manualTick?: boolean;
};
```

In `tick()`, after `broker.modifyOrder()`:
```typescript
await this.onAdjust?.(order, oldPrice, roundedPrice, order.adjustmentCount);
```

The runner wires this to emit:
```typescript
onAdjust: (order, fromPrice, toPrice, step) => {
  const pending = pendingIntents.get(order.orderId);
  emitter.emit({
    messageId: pending?.messageId ?? '',
    signalIndex: pending?.signalIndex ?? null,
    event: 'ORDER_ADJUSTED',
    payload: { orderId: order.orderId, fromPrice, toPrice, step },
  });
},
```

This requires `ResolvedPendingContext` to carry `signalIndex` (trivial addition).

## Context Types: Embarrassingly Simple Extension

The current codebase has ~9 types to represent "what happened to a message": `ParseResult`, `OrchestratorResult`, `ResolvedSignal`, `ResolvedPipelineResult`, `DecisionRow`, `TaskResult`, `TradeStory`, `EnrichedMessage`, `MessageDecision`. Each maps/copies fields from the previous. This is the cruft.

### Principle: Extend, Don't Map

Instead of mapping `A → B → C`, just extend: `C = A & { newField }`. Each layer adds its fields to the same context object. No intermediate types, no lossy conversions.

```typescript
// Base context — what the runner knows
type MessageContext = {
  message: Message;
  emitter: SignalEventEmitter;
};

// Orchestrator adds its fields
type OrchestratorContext = MessageContext & {
  marketData: MarketDataProvider;
  positions: PositionProvider;
  chatHistory: ChatHistoryProvider;
  traderConfig: TraderConfig;
  llm: LLMProvider;
  broker: BrokerService;
};

// Executor needs pipeline deps on top
type ExecutorContext = OrchestratorContext & {
  pipeline: ResolvedPipelineDeps;
};
```

Each layer receives the context, uses what it needs, passes it through. No `onDecision` to thread, no `DecisionRow` to construct. The emitter is on the context — every layer just calls `ctx.emitter.emit(...)`.

### Types to Delete

*(Exact list TBD by type audit team — see below. Known candidates:)*

| Type | Location | Why |
|------|----------|-----|
| `DecisionRow` | `src/db/schema.ts` | Replaced by emitter — no one constructs these anymore |
| `onDecision` on `TaskEnv` | `src/pipeline/process-task.ts` | Replaced by `emitter` on context |
| `onDecision` on `ExecuteEnv` | `src/pipeline/execute-resolved.ts` | Same |
| `onDecision` on `OrchestratorEnv` | `src/intents/orchestrator/types.ts` | Same |
| `MessageDecision` | `src/lib/enriched-message.ts` | Inline from settled event payload |
| Various duplicate/remapped types | TBD by audit | See "Type Audit" section |

### What stays

- `ResolvedSignal` — the concrete signal shape is clean
- `OrchestratorResult` — EXECUTE/SKIP/MANUAL_REVIEW discriminated union is clean
- `RecordTradeResult` / `RecordTradeInput` — trade recording is orthogonal
- `trade_events` — append-only trade mutations, separate concern
- `trades` — denormalized view, separate concern

## Type Audit

A 5-agent team will audit the codebase for:
1. Types that are subsets/copies of other types (e.g., `MessageDecision` is a subset of `RunDecision`)
2. Types that exist only to map between layers (e.g., `TradeStory.decision` re-shapes `RunDecision` fields)
3. Callback signatures duplicated across env types (`onDecision` on 3 different types)
4. Context objects that get constructed by copying fields from another context
5. `Record<string, unknown>` JSON bags that should be typed or eliminated

The team produces a consensus list: each duplicate type, where it lives, what it duplicates, and the recommended resolution (delete / merge / extend).

## Migration Path

### Phase 1: Schema + Emitter Foundation
- Add `event` column to `run_decisions` (default `'SETTLED'` for existing rows)
- Add partial index on `(backtest_run_id, event) WHERE event = 'SETTLED'`
- Create `src/decisions/emitter.ts` with `createEmitter()`
- Add `emitter` to context, wire in both runners (backtest + live)
- **Keep `onDecision` alive** during transition — dual-write until cut over

### Phase 2: Instrument the Pipeline
- Orchestrator: emit `PARSED` (with badges, symbols, detectedStrategies, complexityFlags, all parse metadata), `LLM_STARTED`, `LLM_RESOLVED`, `SIGNAL_RESOLVED`
- Executor: emit `SIZED`, `RISK_PASSED`/`RISK_BLOCKED`, `ORDER_PLACED`, `QUOTE_FAILED`, `RETRY_LLM`
- Runner onFill/onCancel: emit `ORDER_FILLED`/`ORDER_CANCELLED`, `TRADE_RECORDED`, `SETTLED`
- Executor sync fills: emit same events inline
- OrderManager: add `onAdjust`, wire to emit `ORDER_ADJUSTED`

### Phase 3: Fix the False FAIL Bug
- With events, this is natural: `ORDER_PLACED` is emitted immediately, `SETTLED` only when onFill/onCancel fires
- No more "record FAIL and hope to correct later" — SETTLED is deferred for pending orders
- `ResolvedPendingContext.onSettled` closure captures the emitter for async settlement

### Phase 4: Delete Cruft + Flatten Types
- Delete `onDecision` from all env types
- Replace `TaskEnv` / `ExecuteEnv` / `OrchestratorEnv` with context extension pattern
- Delete `DecisionRow`, `MessageDecision`, `recordDecision()`
- Apply type audit findings — merge/delete duplicate types
- Update web queries: add `AND event = 'SETTLED'` where needed, use full event stream for timeline views
- Update `DecisionTimeline` component to render real event timeline

## Concrete File Changes

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `event` column to `runDecisions`. Drop `DecisionRow` export. |
| `src/decisions/emitter.ts` | **New.** `createEmitter()`, `SignalEventEmitter` type. |
| `src/decisions/record.ts` | Delete — replaced by emitter. |
| `src/pipeline/process-task.ts` | Replace `onDecision` with `emitter` on context. Flatten `TaskEnv`. |
| `src/pipeline/execute-resolved.ts` | Replace `ExecuteEnv` with context extension. Emit pipeline events. |
| `src/intents/orchestrator/index.ts` | Emit `PARSED`, `SETTLED` (for skips). Use context directly. |
| `src/intents/orchestrator/llm-path.ts` | Emit `LLM_STARTED`, `LLM_RESOLVED`. |
| `src/intents/orchestrator/types.ts` | Replace `OrchestratorEnv` with context extension. |
| `src/orders/order-manager.ts` | Add `onAdjust` callback, fire from `tick()` after price chase. |
| `src/backtest/runner.ts` | Create emitter per message, pass on context. Wire `onAdjust`. |
| `src/tasks/runner.ts` | Same as backtest runner. |
| `web/lib/queries.ts` | Add `event = 'SETTLED'` filter to summary queries. Full stream for timeline. |
| `web/app/components/decision-timeline.tsx` | Render full event stream. |
| `src/lib/enriched-message.ts` | Simplify — derive from settled event. |

## Why This Matters

**For debugging**: When a trade fills at a bad price, you can see every chase step. When a signal fails, you can see exactly where — was it parse? sizing? risk? order rejection?

**For backtesting**: Compare runs not just by outcome counts, but by execution quality. Run A filled 80% of orders within 2 chase steps; Run B needed 8 steps on average — that's a fill model problem.

**For the false-FAIL fix**: It falls out naturally. `SETTLED` only fires when we know the answer — not when we place the order.

**For simplicity**: One emitter, one table, one pattern. Context objects extend rather than map. No `DecisionRow` grab-bag. No callback threading through 3 env types.
