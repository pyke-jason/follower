# Unified Run Decisions

**Goal**: One `run_decisions` table, one recording code path, identical for live and backtest. Per-signal granularity with pipeline snapshot. Minimal new types.

## Current Problems

1. **Backtest** records to `run_decisions` table; **live** records to `tasks.result` JSON blob — two completely different audit trails
2. One row per message, even when a message produces multiple signals — granularity lost
3. No snapshot of what the parser extracted or what the pipeline did — only the final outcome
4. Retries (422 → LLM re-parse) are folded into the original row — invisible
5. `recordSkip()` and `recordExecute()` are backtest-specific helpers that don't exist in live

## Schema: `run_decisions` (adapted)

```ts
export const runDecisions = sqliteTable('run_decisions', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  backtestRunId:  text('backtest_run_id').references(() => backtestRuns.id),  // nullable — null for live
  taskId:         text('task_id').references(() => tasks.id),                 // nullable — set for live, optional for backtest
  messageId:      text('message_id').references(() => messages.id).notNull(),
  signalIndex:    integer('signal_index'),           // null = message-level (skip/flag), 0+ = per-signal
  attempt:        integer('attempt').default(1),      // 1 = first try, 2 = retry after 422
  outcome:        text('outcome').notNull(),          // 'EXECUTE' | 'SKIP' | 'FAIL'
  phase:          text('phase').notNull(),            // where outcome was decided (see below)
  reasoning:      text('reasoning'),
  skipCategory:   text('skip_category'),              // for aggregation: 'hard_skip', 'risk', 'pipeline', etc.
  tradeId:        text('trade_id'),                   // FK to resulting trade (null unless EXECUTE)
  pnl:            text('pnl'),                        // backfilled after close
  snapshot:       text('snapshot', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  durationMs:     integer('duration_ms'),
  inputTokens:    integer('input_tokens'),
  outputTokens:   integer('output_tokens'),
  createdAt:      text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_run_decisions_run').on(table.backtestRunId),
  index('idx_run_decisions_task').on(table.taskId),
  index('idx_run_decisions_message').on(table.messageId),
]);
```

**Dropped columns**: `path` (replaced by `phase`), `decision` (replaced by `outcome`).

**`phase` values**: `'orchestrator'` | `'risk'` | `'sizing'` | `'pipeline'` | `'order'`
- `orchestrator` = orchestrator decided to skip/flag/execute
- `risk` = risk check blocked
- `sizing` = sizer returned qty=0
- `pipeline` = execution failed (422, order rejected, etc.)
- `order` = order placed, filled or pending

**`outcome` values**: `'EXECUTE'` | `'SKIP'` | `'FAIL'`
- EXECUTE = signal produced a trade
- SKIP = intentionally skipped (orchestrator said no, or not actionable)
- FAIL = tried to execute but failed (risk block, sizing zero, 422, order rejected)

**Migration**: Drop and recreate table. Old backtest runs lose their decisions (re-runnable). No backwards compat needed.

## Snapshot Shape

The `snapshot` JSON captures what each pipeline stage saw and produced. No dedicated type — just a `Record<string, unknown>` that varies by phase.

For a message-level skip (signalIndex=null):
```json
{
  "parseResult": { "action": "OPEN", "symbol": "AAPL", "strikes": [342], "expiryHint": "1/17", "isHardSkip": false, "complexityFlags": ["extra_text"] }
}
```

For an executed signal (signalIndex=0):
```json
{
  "signal": { "orderType": "SINGLE", "legs": [...], "limitPrice": 2.50 },
  "sizing": { "quantity": 5, "entryPrice": 3.20 },
  "risk": { "allowed": true },
  "mid": 2.45,
  "fill": { "price": 2.53, "orderId": "TS-123" }
}
```

For a failed signal:
```json
{
  "signal": { "orderType": "SINGLE", "legs": [...] },
  "sizing": { "quantity": 5, "entryPrice": 3.20 },
  "risk": { "allowed": false, "reason": "Daily loss limit exceeded" }
}
```

For a retry (attempt=2):
```json
{
  "signal": { "orderType": "SINGLE", "legs": [{ "strike": 342.5, ... }] },
  "retryContext": { "originalStrike": 342, "error": "422 symbol not found" },
  "fill": { "price": 2.52, "orderId": "TS-124" }
}
```

## Recording Function

One function, no special types — just takes the insert shape:

```ts
// src/decisions/record.ts
import { db, schema } from '../db/client.js';

export async function recordDecision(values: typeof schema.runDecisions.$inferInsert): Promise<void> {
  await db.insert(schema.runDecisions).values(values);
}
```

That's it. No `recordSkip()` / `recordExecute()` split. Callers build the row directly.

## Changes by File

### 1. `src/db/schema.ts`
- Adapt `run_decisions` columns as above
- Remove `TaskResult` type (line 384-388) — decisions live in `run_decisions` now, not `tasks.result`
- Keep `tasks.result` column but simplify to `{ outcome: string }` — just lifecycle, not audit

### 2. `src/decisions/record.ts` (new, ~10 lines)
- Single `recordDecision()` function as above

### 3. `src/pipeline/execute-resolved.ts`
- Expand `ResolvedPipelineResult` to carry snapshot data:
  ```ts
  export type ResolvedPipelineResult = {
    signal: ResolvedSignal;
    executed: boolean;
    reason?: string;
    tradeId?: string;
    orderId?: string;
    attempt: number;                              // NEW
    snapshot: Record<string, unknown>;             // NEW — pipeline trace for this signal
  };
  ```
- Each stage in `executeResolvedSignal()` appends to the snapshot object as it runs
- Retry loop in `executeResolvedSignals()` produces separate result entries with `attempt: 2`

### 4. `src/pipeline/process-task.ts`
- `TaskResult` EXECUTE variant gets richer: already has `signals` + `results`, just need to pipe `parseResult` through
- Add optional `parseResult` to `TaskResult`:
  ```ts
  export type TaskResult =
    | { outcome: 'SKIP'; reason: string; parseResult?: Record<string, unknown> }
    | { outcome: 'MANUAL_REVIEW'; reason: string; parseResult?: Record<string, unknown> }
    | { outcome: 'EXECUTE'; reason: string; signals: ResolvedSignal[]; results: ResolvedPipelineResult[] };
  ```
- Orchestrator needs to expose `ParseResult` on its result — add to `OrchestratorResult`

### 5. `src/intents/orchestrator/index.ts` + `types.ts`
- `OrchestratorResult` EXECUTE variant carries `parseResult`:
  ```ts
  | { outcome: 'EXECUTE'; signals: ResolvedSignal[]; parseResult?: Record<string, unknown> }
  ```
- Serialize `ParseResult` (convert `Set<ComplexityFlag>` → `string[]`) before attaching
- SKIP/MANUAL_REVIEW variants also carry `parseResult` so we see what was parsed before the skip

### 6. `src/backtest/runner.ts`
- Delete `recordSkip()` and `recordExecute()` helper functions
- `onResult` callback loops over `result.results` (for EXECUTE) and calls `recordDecision()` per signal:
  ```ts
  onResult: async (result) => {
    if (result.outcome === 'EXECUTE') {
      for (let i = 0; i < result.results.length; i++) {
        const r = result.results[i];
        await recordDecision({
          backtestRunId: ctx.runId,
          messageId: ctx.msg.id,
          signalIndex: i,
          attempt: r.attempt,
          outcome: r.executed ? 'EXECUTE' : 'FAIL',
          phase: r.executed ? 'order' : 'pipeline',
          reasoning: r.executed ? `${deriveAction(r.signal)} ${r.signal.legs.map(...)}` : r.reason,
          skipCategory: r.executed ? undefined : categorizeFailure(r.reason),
          tradeId: r.tradeId,
          snapshot: r.snapshot,
          durationMs: Date.now() - ctx.decisionStart,
        });
      }
    } else {
      await recordDecision({
        backtestRunId: ctx.runId,
        messageId: ctx.msg.id,
        signalIndex: null,
        attempt: 1,
        outcome: 'SKIP',
        phase: 'orchestrator',
        reasoning: result.reason,
        skipCategory: result.outcome === 'MANUAL_REVIEW' ? 'flagged' : 'skip',
        snapshot: result.parseResult ?? null,
        durationMs: Date.now() - ctx.decisionStart,
      });
    }
  }
  ```

### 7. `src/tasks/runner.ts` (live)
- Same `onResult` pattern as backtest, but with `taskId` instead of `backtestRunId`:
  ```ts
  onResult: async (result) => {
    // Record decisions (same logic as backtest)
    if (result.outcome === 'EXECUTE') {
      for (let i = 0; i < result.results.length; i++) {
        const r = result.results[i];
        await recordDecision({
          taskId: task.id,
          messageId: task.messageId!,
          signalIndex: i,
          attempt: r.attempt,
          outcome: r.executed ? 'EXECUTE' : 'FAIL',
          phase: r.executed ? 'order' : 'pipeline',
          reasoning: ...,
          tradeId: r.tradeId,
          snapshot: r.snapshot,
          durationMs: ...,
        });
      }
    } else {
      await recordDecision({ taskId: task.id, messageId: task.messageId!, ... });
    }
    // Still mark task complete (lifecycle tracking)
    await completeTask(task.id, { outcome: result.outcome });
  }
  ```

### 8. `src/backtest/runner.ts` — `backfillDecisionPnl()`
- Update SQL to use `outcome = 'EXECUTE'` instead of `decision = 'EXECUTE'`
- Now backfills per-signal rows (each has its own `tradeId`) — more accurate

### 9. `src/backtest/report.ts` — `generateReportFromTrades()`
- Update decision consumption: `d.decision` → `d.outcome`, `d.path` → `d.phase`
- Count logic stays the same, just column names change

### 10. Web query consumers
- `web/lib/queries.ts`:
  - `getRunDecisions()` — update column references, handle nullable `backtestRunId`
  - `getRunDecisionForTask()` — can now query by `taskId` too (live mode!)
  - `getEnrichedMessages()` — remove the `sql\`0 = 1\`` hack for live; query `run_decisions` for both modes
- `src/lib/enriched-message.ts`:
  - `MessageDecision` type — update field names (`decision` → `outcome`, `path` → `phase`)

### 11. Dead type cleanup
- Remove `TaskResult` type from `src/db/schema.ts` (the one with `decision: 'EXECUTE' | 'SKIP' | 'MANUAL_REVIEW'`)
- Simplify `tasks.result` to just `{ outcome: string }` for lifecycle
- `src/pipeline/process-task.ts` `TaskResult` stays — it's the callback contract, not a stored type

## What's NOT Changing

- `processTask()` flow — orchestrate → execute → onResult callback (same shape)
- `executeResolvedSignal()` internal logic — just captures more data in the result
- `ResolvedSignal` / `OrchestratorResult` core shapes — just adding optional `parseResult`
- `trades` / `trade_events` tables — untouched
- `recordTrade()` — untouched
- `tasks` table lifecycle (PENDING → COMPLETED) — still works, just not the decision source of truth

## Implementation Order

1. Schema change + migration script
2. `recordDecision()` function
3. Expand `ResolvedPipelineResult` with `attempt` + `snapshot`
4. Update `executeResolvedSignal()` to build snapshot as it runs
5. Pipe `parseResult` through orchestrator → processTask → onResult
6. Update backtest runner's `onResult` to record per-signal
7. Update live runner's `onResult` to record per-signal
8. Update web queries + types
9. Delete dead types and helpers
