# Channel Scoping: Replace `isBacktest` + `backtestRunId` with `channelId`

## Problem

Scoping is spread across 3 redundant fields and ~30 files:
- `isBacktest` boolean on trades (line 96 of schema.ts)
- `backtestRunId` nullable FK on trades, tasks, run_decisions, mtm_snapshots, orphan_fills
- Filter functions: `notBacktest`, `forRun()`, `isNull(backtestRunId)` — 3 patterns doing one thing

Every layer re-derives "am I backtest or live?" with branching conditionals instead of passing one opaque string. Adding paper trading would be hack #3 on top of an already-smelly pattern.

## Decision

Single `channelId: string` column replaces all of it.

**Format: `<mode>:<id>`**
- `live:<accountId>` — e.g. `live:U14368257` (TradeStation live)
- `paper:<accountId>` — e.g. `paper:DU12345` (IBKR paper)
- `bt:<runId>` — e.g. `bt:a1b2c3d4-...` (backtest run)

No magic strings. Every channel has a mode prefix and an identifier. The pipeline never parses this — `forChannel(channelId)` just does `eq(trades.channelId, channelId)`.

The `backtestRuns` table stays — it's metadata about backtest runs. The relationship is by convention: `bt:<runId>` maps to `backtestRuns.id`. No FK needed (the existing FK isn't enforcing cascading deletes anyway — web code does explicit `DELETE WHERE backtestRunId = X`).

**Helper for the few places that need to extract the mode** (web display, backtest run lookup):
```typescript
export function parseChannel(channelId: string): { mode: string; id: string } {
  const idx = channelId.indexOf(':');
  return { mode: channelId.slice(0, idx), id: channelId.slice(idx + 1) };
}
```

This lives in a shared utility. The pipeline never calls it — only the web layer and runner setup code need it.

## Design: What channelId replaces

### TradeScope (build-deps.ts:35-37)

```typescript
// BEFORE: discriminated union, forces branching everywhere
type TradeScope =
  | { kind: 'live' }
  | { kind: 'backtest'; backtestRunId: string };

// AFTER: one string
type TradeScope = string;  // the channelId
```

### Filters (filters.ts)

```typescript
// BEFORE: two filters, callers choose
export const notBacktest = eq(trades.isBacktest, false);
export const forRun = (runId: string) => eq(trades.backtestRunId, runId);

// AFTER: one filter
export const forChannel = (channelId: string) => eq(trades.channelId, channelId);
```

Every caller that did `scope.kind === 'backtest' ? forRun(id) : notBacktest` becomes `forChannel(channelId)`.

### Scope filter in build-deps.ts (line 81-83)

```typescript
// BEFORE
const scopeFilter = scope.kind === 'backtest'
  ? forRun(scope.backtestRunId)
  : notBacktest;

// AFTER
const scopeFilter = forChannel(scope);
```

### recordTrade input (record-trade.ts:42-43)

```typescript
// BEFORE
backtestRunId?: string;
isBacktest?: boolean;

// AFTER
channelId: string;
```

### Emitter (emitter.ts:28-32)

```typescript
// BEFORE
createEmitter({ messageId, backtestRunId: scope.backtestRunId })
createEmitter({ messageId, taskId })

// AFTER
createEmitter({ messageId, channelId, taskId })
```

### Web queries (web/lib/queries.ts:12-22)

```typescript
// BEFORE: two helpers with NULL branching
function tradeScope(runId?: string): SQL {
  return runId
    ? eq(schema.trades.backtestRunId, runId)
    : isNull(schema.trades.backtestRunId);
}

// AFTER: one helper, always a value
function tradeScope(channelId: string): SQL {
  return eq(schema.trades.channelId, channelId);
}
```

The web passes `channelId` from URL params (`?channel=live:U14368257` or `?channel=bt:<runId>`). Default comes from an env var or config for the primary live account.

## Design: Behavior that currently branches on `scope.kind`

**Principle: `channelId` only does data scoping. Behavior lives in injected deps/config.**

The factory already has two injection points for behavior: `Environment` (clock, sendAlert) and `PipelineConfig` (risk, sizing). The remaining `scope.kind` branches are using scope as a proxy for configuration that should be explicit. Here's the full catalog:

### Already solved by existing injection

**Alerts**: `sendAlert` is already optional in `Environment` (line 44). Live passes `sendSystemAlert`, backtest passes nothing. Paper passes `sendSystemAlert` (or a prefixed version). **No branching needed — caller decides at construction.**

**Risk limits**: `disableRiskLimits` already exists in `PipelineConfig`. Backtest can set it. No scope branching.

**Manual tick**: `manualTick` already exists in `PipelineConfig`. Backtest sets `true`. No scope branching.

### Branches to eliminate

#### 1. Daily PnL date condition (build-deps.ts:126-132)

```typescript
// BEFORE: branches on scope.kind
const dateCondition = scope.kind === 'backtest'
  ? sql`closed_at LIKE ${dateStr + '%'}`  // uses sim clock
  : sql`closed_at >= date('now')`;         // uses wall clock
```

The `clock` function is already injected. Just always use it:

```typescript
// AFTER: always use the injected clock
const dateStr = toDateKeyET(clock());
const dateCondition = sql`closed_at LIKE ${dateStr + '%'}`;
```

Live clock returns today. Backtest clock returns sim day. Paper clock returns today. Same code.

#### 2. Reconciliation alert check (build-deps.ts:154)

```typescript
// BEFORE: scope.kind proxy
if (scope.kind === 'backtest') return 0;
```

Move to config:

```typescript
// Add to PipelineConfig
skipReconciliationCheck?: boolean;

// In factory — no branching on scope
getReconciliationAlertCount: config.skipReconciliationCheck
  ? async () => 0
  : async () => { /* actual DB query */ },
```

Backtest runner sets `skipReconciliationCheck: true`. Live and paper don't. Done.

#### 3. Timestamp requirements (record-trade.ts:177)

```typescript
// BEFORE: branches on isBacktest
if (isBacktest || backtestRunId) { /* require explicit timestamps */ }
```

This guards against backtest trades using wall-clock time (which collapses the equity curve). It's really "does this channel use a simulated clock?" Move to config:

```typescript
// Add to PipelineConfig (or pass through recordTrade)
requireExplicitTimestamps?: boolean;
```

Backtest sets `true`. Live and paper don't.

#### 4. Per-task pipeline wrapping (process-task.ts:57-65)

```typescript
// BEFORE: only live wraps recordTrade with taskId
const pipeline = env.scope.kind === 'live' ? { ...env.pipeline, recordTrade: ... } : env.pipeline;
```

Backtest tasks also have IDs. Just always wrap — no harm, no branching:

```typescript
// AFTER
const pipeline = {
  ...env.pipeline,
  recordTrade: (input) => env.pipeline.recordTrade({ ...input, taskId: task.id }),
  onPending: (orderId, ctx) => env.pipeline.onPending(orderId, { ...ctx, taskId: task.id }),
};
```

### Summary: how each runner configures behavior

```typescript
// Live runner (TradeStation account)
buildPipelineDeps({
  broker: liveService,
  env: { clock: () => new Date(), scope: 'live:U14368257', sendAlert: sendSystemAlert },
  config: { riskConfig: LIVE_RISK_DEFAULTS, agentIdentity: DEFAULT_TRADE_MODEL },
});

// Paper runner (IBKR paper account)
buildPipelineDeps({
  broker: paperService,
  env: { clock: () => new Date(), scope: 'paper:DU12345', sendAlert: sendSystemAlert },
  config: { riskConfig: PAPER_RISK_DEFAULTS, agentIdentity: DEFAULT_TRADE_MODEL },
});

// Backtest runner
buildPipelineDeps({
  broker: simBroker,
  env: { clock: simClock, scope: `bt:${runId}` },
  config: {
    riskConfig: BACKTEST_RISK_DEFAULTS,
    skipReconciliationCheck: true,
    requireExplicitTimestamps: true,
    manualTick: true,
    startingEquity: 100_000,
    agentIdentity: { provider: 'xai', model: 'grok-4-1-fast' },
  },
});
```

`channelId` (scope) is just a string for data isolation. Every behavioral difference is an explicit config/dep passed at construction. Zero `if (scope === ...)` inside the pipeline.

## PipelineConfig changes

```typescript
// BEFORE
export type PipelineConfig = {
  riskConfig: RiskCheckConfig;
  agentIdentity: { provider: string; model: string };
  disableRiskLimits?: boolean;
  startingEquity?: number;
  manualTick?: boolean;
};

// AFTER: two new flags absorb the scope.kind branches
export type PipelineConfig = {
  riskConfig: RiskCheckConfig;
  agentIdentity: { provider: string; model: string };
  disableRiskLimits?: boolean;
  startingEquity?: number;
  manualTick?: boolean;
  skipReconciliationCheck?: boolean;    // backtest: true
  requireExplicitTimestamps?: boolean;  // backtest: true
};
```

## Schema Migration

### Columns to add

| Table | Change |
|-------|--------|
| `trades` | Add `channelId TEXT NOT NULL DEFAULT 'live'` |
| `tasks` | Add `channelId TEXT` (nullable — legacy tasks may lack it) |
| `run_decisions` | Add `channelId TEXT` |
| `backtest_mtm_snapshots` | Add `channelId TEXT NOT NULL` |
| `orphan_fills` | Add `channelId TEXT` |

### Data migration (in the SQL migration file)

Existing live account ID comes from env (e.g. `TS_ACCOUNT_ID`). For the migration SQL, hardcode it or use a placeholder the migration script fills in.

```sql
-- trades: populate from existing data
UPDATE trades SET channel_id = 'bt:' || backtest_run_id WHERE backtest_run_id IS NOT NULL;
UPDATE trades SET channel_id = 'live:DEFAULT' WHERE backtest_run_id IS NULL;
-- Then run: UPDATE trades SET channel_id = 'live:<ACTUAL_ACCT_ID>' WHERE channel_id = 'live:DEFAULT';

-- tasks
UPDATE tasks SET channel_id = 'bt:' || backtest_run_id WHERE backtest_run_id IS NOT NULL;

-- run_decisions
UPDATE run_decisions SET channel_id = 'bt:' || backtest_run_id WHERE backtest_run_id IS NOT NULL;

-- backtest_mtm_snapshots (backtestRunId is NOT NULL here, so 1:1)
UPDATE backtest_mtm_snapshots SET channel_id = 'bt:' || backtest_run_id;

-- orphan_fills
UPDATE orphan_fills SET channel_id = 'bt:' || backtest_run_id WHERE backtest_run_id IS NOT NULL;
```

The migration script (TS wrapper around the SQL) reads `TS_ACCOUNT_ID` from env and patches the `live:DEFAULT` rows.

### Columns to drop (same migration)

- `trades.is_backtest`
- `trades.backtest_run_id`
- `tasks.backtest_run_id`
- `run_decisions.backtest_run_id`
- `backtest_mtm_snapshots.backtest_run_id`
- `orphan_fills.backtest_run_id`

### SQLite migration strategy

SQLite can't `ALTER COLUMN` or `DROP COLUMN` (pre-3.35). Use Drizzle's migration generation (`npm run db:generate`) — it handles the table rebuild internally. If needed, manual approach:

1. Create new table with correct schema
2. INSERT INTO new_table SELECT (with channel_id computed) FROM old_table
3. DROP old_table
4. ALTER TABLE new_table RENAME TO trades

## Files to Change

### Layer 1: Schema + Filters (foundation — do first)

| File | What changes |
|------|-------------|
| `src/db/schema.ts` | Remove `isBacktest` + `backtestRunId` from trades; remove `backtestRunId` from tasks, runDecisions, mtmSnapshots, orphanFills. Add `channelId` to all 5 tables. |
| `src/trades/filters.ts` | Delete `notBacktest`, `forRun`. Add `forChannel(channelId)`. |
| Drizzle migration | `npm run db:generate` after schema change, then edit SQL to include data migration. |

### Layer 2: Core pipeline (depends on Layer 1)

| File | What changes |
|------|-------------|
| `src/pipeline/build-deps.ts` | `TradeScope` becomes `string`. Kill all `scope.kind === 'backtest'` branches. Scope filter = `forChannel(scope)`. Emitter/callback scope = `{ channelId: scope }`. |
| `src/pipeline/process-task.ts` | Remove `env.scope.kind` conditional. Always wrap pipeline with taskId. Emitter gets `channelId` from scope. |
| `src/trades/record-trade.ts` | Replace `backtestRunId` + `isBacktest` params with `channelId`. Scope filter = `forChannel(channelId)`. OPEN values set `channelId`. Timestamp guard: use `channelId !== 'live'` or a separate `requireTimestamps` flag. |
| `src/decisions/emitter.ts` | `backtestRunId` → `channelId` in createEmitter signature and DB insert. |
| `src/orders/build-order-callbacks.ts` | `scope: { backtestRunId? }` → `scope: { channelId? }`. Spreads into orphan_fills. |

### Layer 3: Runners (depends on Layer 2)

| File | What changes |
|------|-------------|
| `src/live/runner.ts` | `scope: { kind: 'live' }` → `scope: 'live:<accountId>'` from env. Pass to buildPipelineDeps and processTask. |
| `src/live/factory.ts` | No change yet (isPaperTrade routing comes in the paper trading follow-up). |
| `src/backtest/runner.ts` | `scope: { kind: 'backtest', backtestRunId: runId }` → `scope: 'bt:<runId>'`. All `forRun(runId)` → `forChannel(channelId)`. Raw SQL `backtest_run_id` → `channel_id`. MTM snapshot inserts use `channelId`. |
| `src/backtest/sim-broker.ts` | `private backtestRunId` → `private channelId`. All `forRun(this.backtestRunId)` → `forChannel(this.channelId)`. recordTrade call passes `channelId`. |
| `src/reconciliation/reconciler.ts` | `where(and(isOpen, notBacktest))` → `where(and(isOpen, forChannel(channelId)))`. |
| `src/reconciliation/fill-sweep.ts` | `eq(trades.isBacktest, false)` → `eq(trades.channelId, channelId)`. |

### Layer 4: Web frontend (depends on Layer 1)

| File | What changes |
|------|-------------|
| `web/lib/queries.ts` | `tradeScope(runId?)` → `tradeScope(channelId)` using `eq(trades.channelId, channelId)`. Same for `taskScope`. All ~12 query functions that pass `runId` now pass `channelId`. `getRiskSnapshot` uses `forChannel(channelId)` instead of `isNull(backtestRunId)`. `getDecisionsForTrade` uses `trade.channelId`. |
| `web/app/backtests/actions.ts` | `eq(trades.backtestRunId, runId)` → `eq(trades.channelId, runId)` in delete functions. |
| `web/app/trades/actions.ts` | `backtestRunId: runId` → `channelId: runId` in decision lookup. |
| `web/app/trades/[id]/page.tsx` | `trade.backtestRunId` → `trade.channelId`. |
| `web/app/tasks/[id]/page.tsx` | `task.backtestRunId` → `task.channelId`. |
| `web/lib/run-scope.ts` | Rename `runId` param to `channelId` internally. URL param stays `?run=` for backward compat (or rename to `?channel=`). |

### Layer 5: Tests (depends on all above)

| File | What changes |
|------|-------------|
| `src/pipeline/build-deps.test.ts` | All `scope: { kind: 'backtest', backtestRunId }` → `scope: 'run-1'`. All `scope: { kind: 'live' }` → `scope: 'live'`. Assertions on `trade.channelId` instead of `trade.isBacktest` + `trade.backtestRunId`. |
| `src/backtest/test-fixtures.ts` | `CREATE_TRADES_SQL` DDL: replace `is_backtest` + `backtest_run_id` with `channel_id`. `insertOpenTrade` / `insertClosedTrade` / `insertOpenOptionTrade`: `backtestRunId` → `channelId`. |
| `src/backtest/sim-broker-pnl.test.ts` | `RUN_ID` constant stays. `backtestRunId: RUN_ID, isBacktest: true` → `channelId: RUN_ID`. SimBroker constructor `channelId` param. |
| `src/backtest/sim-broker-db.test.ts` | Same pattern as pnl test. |
| `src/orders/order-manager.test.ts` | If it references scope fields, update. |
| `src/backtest/sim-broker.test.ts` | Same pattern. |

## Paper Trading (follow-up — after channelId lands)

Once channelId is in, adding paper trading is trivial:

1. **Second sidecar instance** on port 8091, connecting to IB Gateway port 4002 (paper). Env: `IBKR_GATEWAY_PORT=4002 SIDECAR_PORT=8091 IBKR_ACCOUNT_ID=DU12345`.

2. **Second ibkrService** pointing at `http://localhost:8091/api`.

3. **Second pipeline bundle** in runner.ts:
   ```typescript
   const paperBundle = buildPipelineDeps({
     broker: paperBrokerService,
     env: { clock: () => new Date(), scope: 'paper:DU12345', sendAlert },
     config: { riskConfig: PAPER_RISK_DEFAULTS, agentIdentity: DEFAULT_TRADE_MODEL },
   });
   ```

4. **Route paper messages**: Remove the `if (isPaperTrade) return null` skip in factory.ts. Instead, tag the task with `channelId: 'paper:DU12345'`. Paper task runner picks up tasks scoped to paper channel.

5. **Web**: `?channel=paper:DU12345` shows paper trades. Dashboard can show both side by side.

6. **Reconciliation + fill sweep**: Pass `channelId: 'paper:DU12345'` to both. They query positions for that channel only.

All of this works because channelId is just a string — no new schema, no new type variants, no new branching. You just pass a different string at the top and everything scopes correctly.

## Multi-Account Live (same pattern)

Same story. Second TradeStation account, second IBKR live account, whatever:

```typescript
const bundle2 = buildPipelineDeps({
  broker: secondBrokerService,
  env: { clock: () => new Date(), scope: 'live:ACCT2', sendAlert },
  config: { riskConfig: LIVE_RISK_DEFAULTS, agentIdentity: DEFAULT_TRADE_MODEL },
});
```

Each account gets its own bundle, its own task queue (filtered by channelId on tasks), its own reconciliation. The pipeline is identical — only the string and the broker instance differ.

## Execution Order

1. Schema migration (Layer 1)
2. Core pipeline (Layer 2) — build-deps, record-trade, filters, emitter, callbacks
3. Runners (Layer 3) — live runner, backtest runner, sim-broker, reconciliation
4. Web frontend (Layer 4)
5. Tests (Layer 5) — can interleave with layers 2-4
6. Verify: run existing tests, run a backtest, check web dashboard
7. Paper trading follow-up (separate PR)
