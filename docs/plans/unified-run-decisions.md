# Unified Run Decisions

**Goal**: One `run_decisions` table, one recording code path, identical for live and backtest. Per-signal granularity with pipeline snapshot. Minimal new types.

**Status**: Post-review consensus (schema-reviewer, pipeline-reviewer, consumer-reviewer).

## Current Problems

1. **Backtest** records to `run_decisions` table; **live** records to `tasks.result` JSON blob — two completely different audit trails
2. One row per message, even when a message produces multiple signals — granularity lost
3. No snapshot of what the parser extracted or what the pipeline did — only the final outcome
4. Retries (422 → LLM re-parse) are folded into the original row — invisible
5. `recordSkip()` and `recordExecute()` are backtest-specific helpers that don't exist in live
6. Decision recording is tangled into the `onResult` callback alongside lifecycle/stats logic — not decoupled

## Schema: `run_decisions` (adapted)

```ts
export const runDecisions = sqliteTable('run_decisions', {
  id:             text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  backtestRunId:  text('backtest_run_id').references(() => backtestRuns.id),  // nullable — null for live
  taskId:         text('task_id').references(() => tasks.id),                 // nullable — for live trade story lookups
  messageId:      text('message_id').references(() => messages.id).notNull(),
  signalIndex:    integer('signal_index'),           // null = message-level (skip/flag), 0+ = per-signal
  outcome:        text('outcome').notNull(),          // 'EXECUTE' | 'SKIP' | 'FAIL'
  phase:          text('phase').notNull(),            // where outcome was decided (see below)
  reasoning:      text('reasoning'),
  tradeId:        text('trade_id'),                   // FK to resulting trade (null unless EXECUTE)
  pnl:            text('pnl'),                        // backfilled after close
  snapshot:       text('snapshot', { mode: 'json' }).$type<Record<string, unknown>>(),
  durationMs:     integer('duration_ms'),
  inputTokens:    integer('input_tokens'),
  outputTokens:   integer('output_tokens'),
  createdAt:      text('created_at').$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index('idx_run_decisions_run').on(table.backtestRunId),
  index('idx_run_decisions_task').on(table.taskId),
  index('idx_run_decisions_message').on(table.messageId),
  index('idx_run_decisions_run_message').on(table.backtestRunId, table.messageId),
]);
```

### Columns dropped (vs current)

- `path` → replaced by `phase`
- `decision` → replaced by `outcome`
- `skipCategory` → redundant with `phase` + `outcome` (use `GROUP BY phase WHERE outcome IN ('SKIP','FAIL')` instead)
- `attempt` → retry context goes in `snapshot` JSON (retries are rare; a column forces every query to filter for latest attempt)

### `phase` values (3 total)

| Phase | Meaning |
|---|---|
| `orchestrator` | Orchestrator decided to skip/flag/execute (includes parse, LLM, position matching) |
| `pipeline` | Execution attempted but failed (risk blocked, sizing=0, 422, quote error) |
| `order` | Order placed — filled or pending |

Risk/sizing failures show up as `phase: 'pipeline', outcome: 'FAIL'` with the `reasoning` field carrying the detail ("Risk blocked: daily loss limit" or "Position sizer returned qty=0").

### `outcome` values (3 total)

| Outcome | Meaning |
|---|---|
| `EXECUTE` | Signal produced a trade (filled or pending) |
| `SKIP` | Intentionally skipped (orchestrator said no, not actionable, flagged) |
| `FAIL` | Tried to execute but failed (risk block, sizing zero, 422, order rejected) |

### LLM vs deterministic distinction

Don't use a phase value — use `inputTokens IS NOT NULL` to identify decisions that involved an LLM call. Deterministic paths (hard skip, cached intent) have null tokens.

### Migration

Drop and recreate table. Old backtest runs lose their decisions (re-runnable). No backwards compat needed per CLAUDE.md.

## Snapshot Shape

The `snapshot` JSON captures what each pipeline stage saw and produced. No dedicated type — just `Record<string, unknown>` that varies by context. **Built inside `processTask`** from data already available — don't instrument executor internals.

For a message-level skip (signalIndex=null):
```json
{
  "parseResult": { "action": "OPEN", "symbol": "AAPL", "strikes": [342], "expiryHint": "1/17", "isHardSkip": false, "complexityFlags": ["extra_text"] }
}
```

For an executed signal (signalIndex=0):
```json
{
  "signal": { "orderType": "SINGLE", "legs": [...], "limitPrice": 2.50 }
}
```

For a failed signal:
```json
{
  "signal": { "orderType": "SINGLE", "legs": [...] },
  "error": "Risk blocked: daily loss limit exceeded"
}
```

For a retry:
```json
{
  "signal": { "orderType": "SINGLE", "legs": [{ "strike": 342.5 }] },
  "retryContext": { "originalStrike": 342, "error": "422 symbol not found" }
}
```

**Note**: Richer snapshot data (sizing quantities, risk check details, midpoint, fill price) can be added incrementally by expanding what `ResolvedPipelineResult` carries. Start simple — signal + error context.

## Recording Architecture: `onDecision` + `onResult`

**Key design change**: Split the current `onResult` callback into two concerns:

1. **`onDecision`** — fires per-decision as they happen (SKIP, or per-signal EXECUTE/FAIL). `processTask` owns construction of the decision row. The runner just stamps identity (`backtestRunId` or `taskId`) and writes to DB.
2. **`onResult`** — fires once at the end for lifecycle only (stats updates, `completeTask`). No decision recording here.

### `DecisionRow` type

Derived from the Drizzle insert type — no new type definition needed:

```ts
type DecisionRow = Omit<typeof schema.runDecisions.$inferInsert, 'id' | 'backtestRunId' | 'taskId' | 'createdAt'>;
```

### `TaskEnv` (updated)

```ts
export type TaskEnv = {
  getPositions: (symbol?: string) => Promise<OpenPosition[]>;
  llm: LLMProvider;
  pipeline: ResolvedPipelineDeps;
  onDecision: (row: DecisionRow) => Promise<void>;   // fires per-decision
  onResult: (result: TaskResult) => Promise<void>;     // fires once at end, just lifecycle
};
```

### Flow inside `processTask`

```ts
export async function processTask(task: Task, env: TaskEnv): Promise<void> {
  const message = /* load message */;
  const resolved = await resolveOrchestrator(message, env);
  // ^ fires env.onDecision internally for SKIP/MANUAL_REVIEW (phase: 'orchestrator')

  if (resolved.outcome !== 'EXECUTE') {
    await env.onResult({ outcome: resolved.outcome, reason: resolved.reason });
    return;
  }

  const results = await executeResolvedSignals({ resolved, message, env });
  // ^ fires env.onDecision per signal as each resolves (phase: 'pipeline' or 'order')

  await env.onResult({ outcome: 'EXECUTE', reason: `${results.length} signal(s)`, signals: resolved.signals, results });
}
```

`processTask` never calls `onDecision` directly. Each layer fires it for its own decisions:
- `resolveOrchestrator` → fires for SKIP/MANUAL_REVIEW (phase: `orchestrator`)
- `executeResolvedSignals` → fires per-signal for EXECUTE/FAIL (phase: `pipeline` or `order`)

Same pattern everywhere — pass `message` + `env` directly, let the callee pull what it needs. No intermediate context objects, no manual decision row construction in `processTask`.

### Runner wiring (backtest)

```ts
onDecision: async (row) => {
  await recordDecision({ ...row, backtestRunId: ctx.runId });
},
onResult: async (result) => {
  // Just stats — no decision recording
  if (result.outcome === 'EXECUTE') {
    const executed = result.results.filter(r => r.executed).length;
    const failed = result.results.filter(r => !r.executed).length;
    stats.agentTrades += executed;
    stats.failedEntrySignals += failed;
  } else {
    stats.skipped++;
    stats.skipReasons.set(result.reason, (stats.skipReasons.get(result.reason) ?? 0) + 1);
  }
  updateStats(stats);
},
```

### Runner wiring (live)

```ts
onDecision: async (row) => {
  await recordDecision({ ...row, taskId: task.id });
},
onResult: async (result) => {
  // Just lifecycle — no decision recording
  await completeTask(task.id, { outcome: result.outcome });
  console.log(`[Runner] Task ${task.id} completed: ${result.outcome}`);
},
```

### Why this is better

- **Each layer records its own decisions**: Orchestrator fires `onDecision` for skips. Executor fires it per-signal. `processTask` never touches `onDecision` — it just calls `onResult` for lifecycle.
- **Real-time**: Decisions fire as they happen — skips immediately from orchestrator, signals as each resolves in the executor loop. Crash mid-execution → partial audit trail is preserved.
- **No mapping**: `env` propagates straight through. No intermediate context objects, no manual decision row construction, no collect-then-re-iterate.
- **Runners are one-liners**: `onDecision: (row) => recordDecision({ ...row, backtestRunId })`. That's it.

## Recording Function

One function, no special types — just takes the Drizzle insert shape:

```ts
// src/decisions/record.ts
import { db, schema } from '../db/client.js';

export async function recordDecision(values: typeof schema.runDecisions.$inferInsert): Promise<void> {
  await db.insert(schema.runDecisions).values(values);
}
```

## Changes by File

### 1. `src/db/schema.ts`
- Adapt `run_decisions` columns as above
- Remove `TaskResult` type (line 384-388) — rename or inline since `process-task.ts` has its own `TaskResult`
- Simplify `tasks.result` column type to `{ outcome: string }` — just lifecycle, not audit

### 2. `src/decisions/record.ts` (new, ~10 lines)
- Single `recordDecision()` function as above

### 3. `src/pipeline/execute-resolved.ts`
- Change `executeResolvedSignals` signature to take a single context object:
  ```ts
  export async function executeResolvedSignals(ctx: {
    resolved: OrchestratorResult & { outcome: 'EXECUTE' };
    message: Message;
    env: TaskEnv;
  }): Promise<ResolvedPipelineResult[]>
  ```
  It pulls what it needs: `ctx.resolved.signals`, `ctx.message.author`, `ctx.message.id`, `ctx.env.pipeline`, `ctx.env.onDecision`, `ctx.resolved.usage`. No intermediate mapping.
- Inside the `for` loop, call `ctx.env.onDecision()` right after each signal resolves (success or failure). The executor already has `signal`, `executed`, `reason`, `tradeId` — it builds and fires the decision row inline.
- `resolveRetry` callback is built by `processTask` and passed on `ctx.env` or as a closure — same as today, just through a cleaner path.
- **Fix retry recording**: ALWAYS push a `{ executed: false, reason: "422..." }` result for the original signal (and fire `onDecision` with it) before attempting retry. Current code silently drops the original failure when retry succeeds. The retry result fires its own `onDecision` with retry context in snapshot.

### 4. `src/pipeline/process-task.ts`
- Add `onDecision` callback to `TaskEnv` (see architecture section above)
- `processTask` calls `env.onDecision()` at each decision point: once for SKIP, or per-signal for EXECUTE
- Add optional `parseResult` to `TaskResult` SKIP/MANUAL_REVIEW variants for snapshot
- Add `usage` to `TaskResult` all variants so `onDecision` can write token counts
- `TaskResult` type:
  ```ts
  export type TaskResult =
    | { outcome: 'SKIP'; reason: string; parseResult?: Record<string, unknown>; usage?: { inputTokens: number; outputTokens: number } }
    | { outcome: 'MANUAL_REVIEW'; reason: string; parseResult?: Record<string, unknown>; usage?: { inputTokens: number; outputTokens: number } }
    | { outcome: 'EXECUTE'; reason: string; signals: ResolvedSignal[]; results: ResolvedPipelineResult[] };
  ```

### 5. `src/intents/orchestrator/index.ts` + `types.ts`
- `resolveOrchestrator` takes `(message, env)` directly instead of a pre-built `OrchestratorContext`. Builds what it needs internally from `message` fields + `env.pipeline.broker` (for quotes), `env.getPositions`, `env.llm`.
- Fires `env.onDecision` internally for SKIP/MANUAL_REVIEW outcomes (phase: `orchestrator`, with parseResult snapshot and usage).
- Delete `OrchestratorContext` type and `buildOrchestratorContext()` from `process-task.ts` — the orchestrator owns its own context construction and decision recording.
- All `OrchestratorResult` variants carry `parseResult` and `usage`:
  ```ts
  export type OrchestratorResult =
    | { outcome: 'EXECUTE'; signals: ResolvedSignal[]; parseResult?: Record<string, unknown>; usage?: { inputTokens: number; outputTokens: number } }
    | { outcome: 'SKIP'; reason: string; parseResult?: Record<string, unknown>; usage?: { inputTokens: number; outputTokens: number } }
    | { outcome: 'MANUAL_REVIEW'; reason: string; partial?: Partial<ResolvedSignal>[]; parseResult?: Record<string, unknown>; usage?: { inputTokens: number; outputTokens: number } };
  ```
- Serialize `ParseResult` before attaching (convert `Set<ComplexityFlag>` → `string[]`)
- `usage` is populated when the LLM path was taken, null for deterministic/cached paths

### 6. `src/backtest/runner.ts`
- Delete `recordSkip()` and `recordExecute()` helper functions
- Wire `onDecision` callback: `async (row) => recordDecision({ ...row, backtestRunId: ctx.runId })`
- Simplify `onResult` to just stats tracking (no decision recording)

### 7. `src/tasks/runner.ts` (live)
- Wire `onDecision` callback: `async (row) => recordDecision({ ...row, taskId: task.id })`
- Simplify `onResult` to just `completeTask()` (no decision recording)

### 8. `src/backtest/runner.ts` — `backfillDecisionPnl()`
- Update SQL: `decision = 'EXECUTE'` → `outcome = 'EXECUTE'`
- Now backfills per-signal rows (each has its own `tradeId`) — more accurate than before

### 9. `src/backtest/report.ts` — `generateReportFromTrades()`
- `d.decision` → `d.outcome`, `d.path` → `d.phase`
- `isClassified()` filter: use `d.inputTokens != null` for LLM-involved decisions instead of checking path values
- Count logic stays the same shape

### 10. Web query consumers (~15 files affected by column renames)

**`web/lib/queries.ts`:**
- `getRunDecisions()` — update column references (`decision` → `outcome`, `path` → `phase`)
- `getRunDecisionForTask()` — query by `taskId` for live, by `messageId` + `backtestRunId` for backtest
- `getEnrichedMessages()` — **remove the `sql\`0 = 1\`` hack**: for live, join where `backtestRunId IS NULL`. Both modes now get real enrichment. Note: multiple rows per message (per-signal) need dedup — existing `seen.has(r.message.id)` logic handles this.
- `getDecisionDiff()` — update `a.decision` → `a.outcome`, handle new column names

**`web/app/backtests/[id]/page.tsx`:**
- `computeFromTrades()` — `d.decision.path` → `d.decision.phase`, `d.decision.decision` → `d.decision.outcome`

**`web/app/backtests/[id]/decision-scatter.tsx`:**
- Update `decision === 'EXECUTE'` / `decision === 'SKIP'` checks, add `FAIL` handling (display as distinct from skip)

**`web/app/tasks/[id]/page.tsx`:**
- `runDecision?.path` → `runDecision?.phase`, `runDecision?.decision` → `runDecision?.outcome`

**`web/app/trades/[id]/decision-reasoning.tsx`:**
- Local `Decision` type: `decision` → `outcome`, `path` → `phase`

**`web/app/trades/actions.ts` — `fetchTradeStory()`:**
- Remove the `task.result` fallback for live decisions — query `run_decisions` by `taskId` instead
- This is the key parity win: live and backtest trade stories use the same data source

**`web/app/components/signal-decision-summary.tsx`:**
- Update prop types for renamed fields

**`web/app/tasks/task-list.tsx`:**
- Currently reads `task.result.decision` — update to read from `run_decisions` or simplify display since `tasks.result` is now just `{ outcome }` for lifecycle

### 11. `src/lib/enriched-message.ts`
- `MessageDecision` type — rename fields:
  ```ts
  export type MessageDecision = {
    outcome: 'EXECUTE' | 'SKIP' | 'FAIL';
    reasoning: string | null;
    pnl: string | null;
    phase: string;
    durationMs: number | null;
  };
  ```
- `getMessageRole()` — `FAIL` maps to `'skipped'` role (it wasn't executed). No new role needed.

### 12. `src/tasks/recorder.ts`
- `completeTask()` — simplify to accept `{ outcome: string }` instead of full `TaskResult`
- Remove import of schema `TaskResult` type

### 13. Dead type cleanup
- Remove `TaskResult` from `src/db/schema.ts` (or rename to `TaskLifecycleResult = { outcome: string }`)
- `process-task.ts` `TaskResult` stays — it's the in-memory callback contract, different from the stored type

## What's NOT Changing

- `executeResolvedSignal()` internal logic — untouched (single-signal executor stays pure)
- `ResolvedSignal` core shape — untouched
- `ResolvedPipelineResult` shape — untouched
- `trades` / `trade_events` tables — untouched
- `recordTrade()` — untouched
- `tasks` table lifecycle (PENDING → COMPLETED) — still works

## Implementation Order

1. Schema change (drop + recreate `run_decisions`)
2. `recordDecision()` function
3. Add `onDecision` to `TaskEnv`, update `processTask` to call it at each decision point
4. Pipe `parseResult` + `usage` through orchestrator → processTask
5. Fix retry recording in `executeResolvedSignals()` (push original failure before retry results)
6. Update backtest runner: wire `onDecision`, simplify `onResult` to stats-only
7. Update live runner: wire `onDecision`, simplify `onResult` to lifecycle-only
8. Update `backfillDecisionPnl()` and `generateReportFromTrades()`
9. Update web queries (queries.ts) + types (enriched-message.ts, MessageDecision)
10. Update ~10 web component files for column renames (`decision`→`outcome`, `path`→`phase`)
11. Update `completeTask()` and schema `TaskResult` type (simplify to `{ outcome: string }`)
12. Delete dead helpers (`recordSkip`, `recordExecute`)

## Review Consensus Notes

Reviewed by 3 agents (schema, pipeline, consumer). Key decisions:
- **Kept `taskId`** — needed for live trade story lookups in `fetchTradeStory()` (consumer-reviewer's case)
- **Dropped `skipCategory`** — `phase` + `outcome` covers aggregation needs
- **Dropped `attempt` column** — retries are rare; retry context goes in `snapshot` JSON. Retries get their own row with retry context in snapshot.
- **Reduced `phase` to 3 values** — orchestrator/pipeline/order. Risk and sizing are sub-phases of pipeline; `reasoning` carries the detail.
- **`onDecision` propagated to executor** — fires inside `executeResolvedSignals` per-signal as they resolve. Skips fire from `processTask`. Runners just stamp identity.
- **Token usage plumbing** — `OrchestratorResult` carries `usage` so tokens reach the recording site
- **~15 web files** need `decision`→`outcome` / `path`→`phase` renames — necessary blast radius
- **Per-signal rows in web queries** — existing message dedup in `getEnrichedMessages()` handles this; detail views show per-signal breakdowns
