# Live Path Hardening Plan

Status: PROPOSED
Date: 2026-03-01
Scope: `src/live/`, `src/orders/`, `src/pipeline/`, `src/broker/interface.ts`, `src/backtest/runner.ts`, `src/db/schema.ts`

8 issues identified during review, ranked by blast radius. Each produces a concrete, scoped change. No refactor safaris.

Consensus built from five parallel research agents: three analyzing hardening issues independently, two auditing live/backtest parity, one designing the shared factory.

### Design Principle: No Optional Callbacks in Production Code

Every callback and dependency that represents a critical system behavior is **REQUIRED**, not optional. If a caller doesn't wire it, the code should fail to compile — not silently degrade. In a system where slip-ups cost millions, an optional `onOrphanFill` is just a silent fill drop with extra steps.

Backtest gets the SAME handlers as live — orphan fills are persisted and alerted in both paths because it's the same business logic with different scoping columns. The factory wires all shared logic once; runners only provide infra.

---

## Issue 1 — Silent fill drop when pendingIntents is missing

**Risk**: Position exists at broker, never recorded in DB. Invisible P&L exposure.

**Root cause**: `build-order-callbacks.ts:28-29` — `onFill` silently returns if the orderId isn't in the `pendingIntents` map. Same pattern in `onCancel` (line 49) and `onAdjust` (line 69).

**Why it can happen**:
- Process restart clears the in-memory `pendingIntents` Map but broker orders persist
- Race condition if `pendingIntents.delete()` fires before `onFill` runs
- Bug in the Map key (e.g., orderId format mismatch between broker and local)

### Implementation

#### A. Add `onOrphanFill` to `CallbackDeps`

**File**: `src/orders/build-order-callbacks.ts:16-19`

```ts
type CallbackDeps = {
  pendingIntents: Map<string, ResolvedPendingContext>;
  createScopedEmitter: (messageId: string) => SignalEventEmitter;
  onOrphanFill: (order: FilledWorkingOrder) => Promise<void>;   // NEW — REQUIRED
  onOrphanCancel: (order: WorkingOrder) => Promise<void>;       // NEW — REQUIRED
};
```

**REQUIRED, not optional.** Both live and backtest must provide handlers. An optional callback here is just a silent fill drop with extra steps — the exact bug we're fixing. The compiler must force every caller to handle orphan events.

#### B. Replace silent returns

**File**: `src/orders/build-order-callbacks.ts`

1. `onFill` (line 29) — replace `if (!pending) return;` with:
   ```ts
   if (!pending) {
     await deps.onOrphanFill(order);  // no ?. — required callback
     return;
   }
   ```

2. `onCancel` (line 49-65) — replace the silent `pendingIntents.delete` with:
   ```ts
   if (!pending) {
     await deps.onOrphanCancel(order);  // no ?. — required callback
     return;
   }
   ```

3. `onAdjust` (line 69-70) — add when `!pending`:
   ```ts
   log.warn(`onAdjust: no pendingIntent for orderId=${order.orderId} — adjustment untracked`);
   ```
   (Adjustments don't create exposure, so warn-level logging is sufficient here.)

#### C. New `orphan_fills` table

**File**: `src/db/schema.ts`

```ts
export const orphanFills = sqliteTable('orphan_fills', {
  orderId: text('order_id').primaryKey(),
  symbol: text('symbol').notNull(),
  strategy: text('strategy').notNull(),
  direction: text('direction').notNull(),
  filledPrice: real('filled_price').notNull(),
  filledAt: text('filled_at').notNull(),
  filledQuantity: integer('filled_quantity'),
  commission: real('commission'),
  legs: text('legs'),          // JSON
  rawOrder: text('raw_order'), // JSON — full FilledWorkingOrder for forensics
  detectedAt: text('detected_at').notNull(),
  resolved: integer('resolved').default(0),
  // Scoping — same pattern as trades table
  taskId: text('task_id'),              // live
  backtestRunId: text('backtest_run_id'), // backtest
});
```

Separate from `trades` — prevents partial/incorrect records from affecting P&L, risk, or reconciliation.

#### D. Shared handlers — owned by the factory, not per-runner

Orphan detection is **business logic**, not infra. The handler is identical for live and backtest — the only difference is the scoping column (same as `recordTrade`). This belongs in the factory, not duplicated per runner.

**File**: `src/pipeline/build-deps.ts` — inside `buildProcessTaskDeps`:

```ts
const handleOrphanFill = async (order: FilledWorkingOrder) => {
  log.error(`ORPHAN FILL: orderId=${order.orderId} symbol=${order.params.symbol} ` +
    `strategy=${order.params.strategy} filled@${order.filledPrice} qty=${order.filledQuantity}`);
  await db.insert(schema.orphanFills).values({
    orderId: order.orderId,
    symbol: order.params.symbol,
    strategy: order.params.strategy,
    direction: order.params.direction,
    filledPrice: order.filledPrice,
    filledAt: order.filledAt.toISOString(),
    filledQuantity: order.filledQuantity ?? null,
    commission: order.commission ?? null,
    legs: JSON.stringify(order.params.legs),
    rawOrder: JSON.stringify(order),
    detectedAt: infra.clock().toISOString(),
    // Scoping — same pattern as recordTrade
    ...(infra.tradeScope.kind === 'backtest'
      ? { backtestRunId: infra.tradeScope.backtestRunId }
      : { taskId: infra.tradeScope.getTaskId() }),
  }).onConflictDoNothing();
  await sendSystemAlert({
    title: 'ORPHAN FILL — Position at broker with no DB record',
    message: `Order ${order.orderId}: ${order.params.direction} ${order.params.strategy} ` +
      `${order.params.symbol} filled @ $${order.filledPrice} qty=${order.filledQuantity}. ` +
      `Written to orphan_fills. Manual reconciliation required.`,
    severity: 'critical',
  });
};

const handleOrphanCancel = async (order: WorkingOrder) => {
  log.warn(`Orphan cancel: orderId=${order.orderId} symbol=${order.params.symbol}`);
  await sendSystemAlert({
    title: 'Orphan cancel — order cancelled with no pending intent',
    message: `Order ${order.orderId}: ${order.params.symbol}. State desync detected.`,
    severity: 'warning',
  });
};
```

Both handlers are wired into `buildOrderCallbacks` by the factory. Neither runner touches them. Same code path for live and backtest — because it IS the same logic.

The `orphan_fills` table gets scoping columns (`backtestRunId` / `taskId`) so orphan forensics are queryable per-environment, just like `trades`.

Do NOT auto-record the trade — we lack the `recordFill` closure, `messageId`, `signalIndex`, and `tradeId`. A partial record creates worse inconsistency than a clean gap with a forensic trail.

---

## Issue 2 — Risk check blind to working orders

**Risk**: Double/triple position exposure. Risk check passes for signal B while signal A's order is still filling.

**Root cause**: `risk-check.ts:59` — `getOpenTrades()` queries only the `trades` table. Working orders (placed but unfilled) live in `OrderManager.workingOrders` Map, invisible to the query.

**Real scenario**: With `cancelAfterSec: 60`, a limit order sits pending up to 60 seconds. If two signals arrive on the same symbol within that window, risk check sees 0 positions for both. Both place orders. Both fill. 2x intended exposure.

### Implementation

#### A. `getExposure()` method on OrderManager

**File**: `src/orders/order-manager.ts`

The exposure computation is purely a function of OrderManager's own `workingOrders` state. It belongs ON OrderManager, not as inline wiring in each runner:

```ts
export type WorkingOrderExposure = {
  totalCount: number;
  countBySymbol: Map<string, number>;
  totalNotional: number;
};

getExposure(): WorkingOrderExposure {
  const countBySymbol = new Map<string, number>();
  let totalNotional = 0;
  let totalCount = 0;
  for (const wo of this.workingOrders.values()) {
    if (wo.status !== 'OPEN') continue;
    totalCount++;
    const sym = wo.params.symbol;
    countBySymbol.set(sym, (countBySymbol.get(sym) ?? 0) + 1);
    totalNotional += notionalValue(
      wo.currentLimitPrice,
      wo.params.legs[0]?.quantity ?? 1,
      wo.params.strategy,
    );
  }
  return { totalCount, countBySymbol, totalNotional };
}
```

Uses `currentLimitPrice` because it tracks through price chase adjustments. Slightly conservative (may overcount), but far better than counting zero. Sync — reads in-memory state only.

#### B. Make ALL deps required on `RiskCheckDeps`

**File**: `src/orders/risk-check.ts:15-21`:

```ts
export type RiskCheckDeps = {
  getOpenTrades: (filters?: PositionFilters) => Promise<Trade[]>;
  getDailyClosedPnl: () => Promise<number>;
  getStartingEquity: () => Promise<number | null>;
  getCurrentEquity: () => Promise<number>;
  getReconciliationAlertCount: () => Promise<number>;       // was optional — now REQUIRED
  getWorkingOrderExposure: () => WorkingOrderExposure;       // NEW — REQUIRED, sync
};
```

**ALL deps are required.** The factory wires `getWorkingOrderExposure: () => orderManager.getExposure()` — one line, no duplication.

#### C. Merge into all three checks

**File**: `src/orders/risk-check.ts` — insert after line 62:

```ts
const workingExposure = deps.getWorkingOrderExposure();
const effectiveOnSymbol = openPositionsOnSymbol + (workingExposure.countBySymbol.get(input.symbol) ?? 0);
const effectiveTotal = totalOpenPositions + workingExposure.totalCount;
```

At line 78, merge notional:
```ts
const effectiveNotional = totalNotional + workingExposure.totalNotional;
```

Remove `?.` from existing `getReconciliationAlertCount` call (line 90-92) — now required:
```ts
const alertCount = await deps.getReconciliationAlertCount();
```

Update limit checks at lines 83-87 to use `effectiveOnSymbol`, `effectiveTotal`, `effectiveNotional`.

#### D. Update `RiskCheckResult` for observability

```ts
workingOrdersOnSymbol: number;
workingOrdersTotal: number;
workingOrderNotional: number;
```

All required. If we're computing exposure, we always have the numbers.

#### E. Factory wiring (not per-runner)

**File**: `src/pipeline/build-deps.ts` — inside `buildProcessTaskDeps`:

```ts
// In riskDeps:
getWorkingOrderExposure: () => infra.orderManager.getExposure(),
getReconciliationAlertCount: infra.riskDeps.getReconciliationAlertCount,
```

One line each. The runners provide `riskDeps` with their data sources, but `getWorkingOrderExposure` is always `orderManager.getExposure()` — no reason for it to vary.

### How Issues 1 and 2 Interact

They cover complementary windows:
- **Pre-fill** (issue 2): Working orders visible to risk checks. Prevents double entry.
- **Post-fill-drop** (issue 1): Orphan fills caught, persisted, alerted. Prevents silent position leakage.

Once `order-manager.ts:99` removes from `workingOrders` on fill, the order exits issue 2's coverage. If `onFill` then drops it (issue 1), the `orphan_fills` table + critical alert is the backstop.

---

## Issues 3 & 4 — Broker circuit breaker (combined)

**Risk**: Tasks claimed during broker outage are marked FAILED permanently (no retry). Loop burns through queue at ~20 tasks/minute.

**Root cause**: `runner.ts:138-152` — no health check before claiming. `runner.ts:101-113` — flat 3s interval regardless of failure history.

**Architectural decision**: Issues 3 and 4 are a single "broker circuit breaker" primitive. They share the same state (broker health), same trigger (task failures), and same remediation (stop claiming tasks). Two separate mechanisms would create overlapping systems tracking the same thing.

### Implementation

#### A. Add `isHealthy()` to BrokerService

**File**: `src/broker/interface.ts`:

```ts
export interface BrokerService {
  // ... existing methods ...
  isHealthy(): Promise<boolean>;
  // No isTransientError() — brokers throw BrokerTransientError at the source (src/lib/errors.ts)
}
```

**IBKR** (`src/broker/ibkr/client.ts`): Call `GET /api/status` via sidecar. The `StatusResponseSchema` already exists at `src/broker/ibkr/schemas.ts:13-21`. Check `connected === true && maintenance === false`. Reads in-memory flag — no IB Gateway round-trip. Use 3s timeout.

**TradeStation** (`src/broker/tradestation/client.ts`): Call `getAccountBalance()`. Piggybacks on existing auth + retry infra. Returns true on success, false on any error.

**SimBroker** (`src/backtest/sim-broker.ts`): `async isHealthy() { return true; }` — always healthy.

#### B. Circuit breaker state

**File**: `src/live/runner.ts` — add at module level (after line 81):

```ts
const HEALTH_CHECK_CACHE_MS = 30_000;   // cache healthy result 30s
const CIRCUIT_OPEN_THRESHOLD = 3;        // 3 consecutive failures → open
const BACKOFF_BASE_MS = 10_000;          // 10s initial backoff
const BACKOFF_MAX_MS = 300_000;          // 5 min cap

let consecutiveFailures = 0;
let circuitOpen = false;
let lastHealthCheckAt = 0;
let circuitOpenedAt = 0;
```

#### C. Modified `processPendingTasks` flow

Before the claim transaction:

```
1. If circuitOpen:
   a. Compute exponential backoff: min(10s * 2^(failures - threshold), 5min)
   b. If not enough time elapsed since circuitOpenedAt → return early
   c. Probe isHealthy()
   d. If healthy → close circuit (reset state, log, send info alert)
   e. If still unhealthy → reset circuitOpenedAt, return early

2. If NOT circuitOpen AND health cache expired (>30s):
   a. Probe isHealthy()
   b. If unhealthy → open circuit immediately (don't wait for 3 task failures)
```

After successful `handleTask`: reset `consecutiveFailures = 0`, `circuitOpen = false`.

Helpers:
```ts
async function probeBrokerHealth(): Promise<boolean> {
  lastHealthCheckAt = Date.now();
  return broker.isHealthy();  // uses BrokerService abstraction, not concrete impl
}

function openCircuit(reason: string): void {
  if (!circuitOpen) {
    circuitOpen = true;
    circuitOpenedAt = Date.now();
    console.warn(`[Runner] Circuit breaker OPEN: ${reason}`);
    sendSystemAlert({
      title: 'Broker circuit breaker OPEN',
      message: `${reason}. Task claiming paused until broker is healthy.`,
      severity: 'warning',
    });
  }
}
```

#### D. Tiered alert escalation

In the `startTaskRunner` catch block:

```
consecutiveFailures++
At  3 failures: openCircuit() — severity warning
At 10 failures: sendSystemAlert severity critical
At 30 failures: sendSystemAlert severity critical (triggers Pushover)
```

#### E. Typed broker errors — brokers throw, callers `instanceof`

Same pattern as `QuoteResolutionError`. Brokers throw typed errors at the source. No regex matching on message strings.

**File**: `src/lib/errors.ts` — add:

```ts
/**
 * Thrown by BrokerService implementations for transient infra failures
 * (network timeouts, connection refused, sidecar 503, etc.).
 * Callers use `instanceof BrokerTransientError` to decide retry vs permanent fail.
 */
export class BrokerTransientError extends Error {
  constructor(
    message: string,
    /** Original error for forensics. */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BrokerTransientError';
  }
}
```

**Broker implementations** wrap transient failures at the source:

**IBKR** (`src/broker/ibkr/client.ts`) — in the sidecar fetch wrapper:
```ts
catch (err) {
  if (isNetworkOrSidecarError(err)) {
    throw new BrokerTransientError(`IBKR sidecar: ${err.message}`, err);
  }
  throw err; // permanent errors pass through unmodified
}
```

**TradeStation** (`src/broker/tradestation/client.ts`) — in the API call wrapper:
```ts
catch (err) {
  if (isNetworkOrServerError(err)) {
    throw new BrokerTransientError(`TradeStation: ${err.message}`, err);
  }
  throw err;
}
```

**SimBroker** — never throws `BrokerTransientError`. No transient failures in simulation.

Each broker owns its own classification of what's transient (network errors, 503s, timeouts) vs permanent (auth failure, invalid symbol). The typed error is thrown at the source — closest to the knowledge.

#### F. Error handling in the shared pipeline, not per-runner

The `processTask` catch block IS shared code — both runners call `processTaskShared()`. Error classification and retry/fail decisions belong there, not duplicated in each runner's `handleTask`.

**File**: `src/pipeline/process-task.ts` — wrap the existing body in try/catch:

```ts
export async function processTask(task: Task, env: TaskEnv): Promise<void> {
  const messageId = task.messageId;
  if (!messageId) throw new TaskPermanentError(`Task ${task.id} has no messageId`);

  try {
    // ... existing orchestrator + executor logic ...
  } catch (err) {
    if (err instanceof BrokerTransientError) {
      throw err;  // bubble up as-is — caller knows it's retryable by type alone
    }
    throw err;  // all other errors bubble up unmodified
  }
}
```

The runner's catch block becomes trivial — it just handles the task record:

```ts
// In the factory's onTaskError callback (shared):
onTaskError: async (task: Task, err: unknown) => {
  if (err instanceof BrokerTransientError) {
    await db.update(schema.tasks)
      .set({ status: 'PENDING', startedAt: null })
      .where(eq(schema.tasks.id, task.id));
    log.warn(`Task ${task.id} requeued (broker transient): ${err.message}`);
    return 'REQUEUED';
  }
  const msg = err instanceof Error ? err.message : String(err);
  await failTask(task.id, msg);
  return 'FAILED';
},
```

This is wired by the factory — same for live and backtest. Runners don't touch error handling at all.

#### Edge cases

- **Stale tasks after long outage**: Existing stale-recovery at `runner.ts:89-99` requeues IN_PROGRESS tasks >5min old on restart.
- **Partial outage** (quotes work, orders fail): Health check passes but tasks fail. Consecutive failure counter catches this after 3.
- **IBKR maintenance window**: Sidecar `/api/status` returns `maintenance: true` during nightly reset (23:45-00:45 ET). `isHealthy()` returns false, preventing task waste.

---

## Issue 5 — `task.messageId!` non-null assertion

**Risk**: Runtime crash if messageId is null. Emitter created with bad messageId before processTask's guard runs. Would cause NOT NULL constraint violation on `run_decisions.messageId` (schema.ts:168).

**Root cause**: `runner.ts:232` — `messageId: task.messageId!`. CLAUDE.md forbids `!` assertions.

### Implementation

The guard already exists in the shared pipeline — `processTask` (process-task.ts:38-39) throws if `messageId` is missing. The live runner's `!` assertion happens BEFORE calling `processTask` because it creates the emitter early.

**Fix**: Move emitter creation into the factory's `buildTaskEnv` so it's AFTER the guard. The runner never touches `task.messageId` directly.

**File**: `src/pipeline/build-deps.ts` — in `buildTaskEnv`:

```ts
const buildTaskEnv = (input: TaskEnvInput): TaskEnv => {
  // messageId validated by processTask:39 before emitter is used.
  // Emitter creation deferred — no !assertion needed.
  const emitter = input.createEmitter(input.task);
  return { ... pipeline, emitter, ... };
};
```

**File**: `src/live/runner.ts` — remove `task.messageId!`. The runner just calls:

```ts
await processTaskShared(task, buildTaskEnv({ task, ... }));
```

No guard needed in the runner — `processTask` owns that validation. No `!` assertion — the runner never reads `task.messageId`.

---

## Issue 6 — `task.context` cast without validation

**Risk**: Corrupt DB data becomes a silent runtime bomb. Violates boundary validation rule.

**Root cause**: `runner.ts:166` — `const context = (task.context || {}) as TaskContext` is a raw `as` cast on data from the DB boundary.

**Additional violation**: `TaskContext` type (schema.ts:391-404) has `[key: string]: unknown` index signature — banned by CLAUDE.md.

### Implementation

#### A. Create Zod schema, derive type

**File**: `src/db/schema.ts` — replace the hand-written type at line 391:

```ts
export const TaskContextSchema = z.object({
  messageId: z.string().optional(),
  messageTimestamp: z.string().optional(),
  author: z.string().optional(),
  cleanText: z.string().optional(),
  rawHtml: z.string().optional(),
  badges: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  actionHint: z.string().nullable().optional(),
  directionHint: z.string().nullable().optional(),
  detectedStrategies: z.array(z.object({
    strategy: z.string(),
    confidence: z.number(),
    strikes: z.array(z.number()).optional(),
    expiry: z.string().optional(),
    price: z.number().optional(),
    quantity: z.number().optional(),
  })).optional(),
  confidence: z.number().optional(),
}).passthrough();

export type TaskContext = z.infer<typeof TaskContextSchema>;
```

`.passthrough()` allows extra keys at parse time without polluting the inferred type — replaces the banned index signature.

#### B. Parse in the shared pipeline, not per-runner

`task.context` is read in the shared pipeline — that's where the parse belongs. Neither runner should touch `task.context` directly.

**File**: `src/pipeline/process-task.ts` — at the top of `processTask()`, before any business logic:

```ts
const context = TaskContextSchema.parse(task.context ?? {});
```

Parse failure throws ZodError → caught by the shared error handler → `failTask`. Both runners get validated context automatically. No per-runner cast, no per-runner parse.

#### C. Verify consumers

`TaskContext` is imported in 4 files:
- `src/pipeline/process-task.ts` — will use `.parse()` (the fix, shared)
- `src/live/factory.ts` — writes context, not reads; no change needed
- `src/agent/deterministic-skips.ts` — receives already-parsed context; no change
- `src/lib/skip-position-alert.ts` — receives already-parsed context; no change

---

## Issue 7 — Dead `startTask()` export in recorder.ts

**Risk**: Confusion / misuse. Someone calls it thinking it's the right way to mark a task IN_PROGRESS, creating a race with the atomic claim transaction.

**Root cause**: `recorder.ts:30-37` exports `startTask()` but it's never imported anywhere. Confirmed: only `completeTask` and `failTask` are imported (`runner.ts:3`). Zero call sites across entire codebase.

### Implementation

**File**: `src/live/recorder.ts`

Delete lines 30-37. No callers to update.

---

---

## Bonus: Harden `ResolvedPipelineDeps` (same principle)

**File**: `src/pipeline/execute-resolved.ts:44-62`

`orderManager` and `onPending` are currently optional. Same problem — if a caller forgets to wire them, limit orders silently fall through to raw `broker.placeOrder()` with no tracking, no price chase, no pending intent registration.

Make both required:

```ts
export type ResolvedPipelineDeps = {
  broker: BrokerService;
  orderManager: OrderManager;                          // was optional — REQUIRED
  calculatePositionSize: (...) => Promise<PositionSize>;
  checkRiskLimits: (...) => Promise<RiskCheckResult>;
  recordTrade: (...) => Promise<RecordTradeResult | null>;
  onPending: (orderId: string, context: ResolvedPendingContext) => void;  // was optional — REQUIRED
};
```

Then remove the `if (deps.orderManager)` branch in `placeOrder()` (execute-resolved.ts:239-244) — always goes through `orderManager.submitOrder()`.

Backtest already provides both. No new wiring needed.

---

---

## Issue 8 — Live/Backtest Business Logic Parity (THE most important issue)

**Risk**: Business logic divergence between live and backtest paths means backtests don't accurately predict live behavior. A bug in one path isn't caught by the other. The swap from backtest to live should be **literally just changing the broker, clock, and scoping** — nothing else.

**Goal**: Both runners wire identical business logic through a shared factory. The ONLY differences are infra primitives (broker implementation, clock source, scoping keys). Everything else — sizing, risk checks, callbacks, trade recording — is wired ONCE.

### Parity Audit — Current Divergences

Line-by-line comparison of `src/live/runner.ts` vs `src/backtest/runner.ts` business logic wiring:

| Area | Live | Backtest | Verdict |
|------|------|----------|---------|
| **spreadMaxRisk** | NOT passed to `calculatePositionSize` | Passed via `input.spreadMaxRisk` | **BUG** — live sizing ignores spread max risk for debit spreads. Position size could be 2-3x too large. |
| **agentModel in metadata** | Not recorded in trade metadata | `{ agentModel: 'provider:model' }` in `recordTrade` metadata | **GAP** — live trades lack model attribution. No way to audit which model made which trade. |
| **getReconciliationAlertCount** | Provided (blocks on unresolved alerts) | Not provided (optional on type) | **Fixed by Issue 2** — making it required forces backtest to provide `() => 0`. |
| **getWorkingOrderExposure** | Not provided | Not provided | **Fixed by Issue 2** — required on both. Live wires OrderManager, backtest wires `ZERO_EXPOSURE`. |
| **disableRiskLimits** | Never available | `config.disableRiskLimits` escape hatch | **Intentional** — never disable risk in production. Factory keeps this as backtest-only config. |
| **maxOnSymbol** | `LIVE_RISK_DEFAULTS.maxOnSymbol: 5` | `BACKTEST_RISK_DEFAULTS.maxOnSymbol: 3` | **Intentional config** — different risk appetite. Both use `checkRiskLimits`, just different configs. |
| **pendingIntents** | Module-level singleton (survives across tasks) | Per-run (scoped to `runBacktestInner`) | **Correct for each** — live persists across tasks, backtest isolates per run. Factory owns the Map. |
| **OrderManager lifetime** | Singleton, `destroyOrderManager()` on shutdown | Per-run, `destroy()` at end of `runBacktestInner` | **Correct for each** — infra difference, not business logic. |
| **getOpenPositions** | Queries `trades` table with `[isOpen, notBacktest]` | Calls `broker.getOpenTrades(filters)` on SimBroker | **Correct** — different data sources, same `Trade[]` shape. Infra swap. |
| **emitter scope** | `{ messageId, taskId }` | `{ messageId, backtestRunId }` | **Correct** — different scoping keys. Per-task concern, not business logic. |
| **clock** | `() => new Date()` | `() => clock.now()` with `manualTick: true` | **Correct** — fundamental infra difference. |
| **onOrphanFill / onOrphanCancel** | Not wired (Issue 1) | Not wired (Issue 1) | **Fixed by Issue 1** — shared handler in factory: persist + alert for both paths, scoped by `TradeScope`. |

**Critical bugs to fix**: `spreadMaxRisk` and `agentModel` are genuine business logic divergences — the factory eliminates both.

### Architecture: `buildProcessTaskDeps` Factory

Extract all business logic wiring into a single factory function in `src/pipeline/build-deps.ts`. Each runner provides only infra primitives. The factory owns all shared logic.

#### A. `RunnerInfra` — what each runner provides

**File**: `src/pipeline/build-deps.ts`

```ts
export type RunnerInfra = {
  // ── Core infra (different per environment) ──
  broker: BrokerService;
  orderManager: OrderManager;
  clock: () => Date;

  // ── Scoping (how trades/events are attributed) ──
  tradeScope: TradeScope;

  // ── Position data (different source per environment) ──
  getOpenPositions: (filters?: PositionFilters) => Promise<Trade[]>;

  // ── Risk deps (pre-built by each runner with its own data sources) ──
  riskDeps: RiskCheckDeps;    // ALL fields required (per Issue 2)
  riskConfig: RiskCheckConfig;
  disableRiskLimits?: boolean; // backtest only — factory guards this

  // ── Agent identity ──
  agentIdentity: { provider: string; model: string };
};

export type TradeScope =
  | { kind: 'live'; getTaskId: () => string }
  | { kind: 'backtest'; backtestRunId: string };
```

Every field is **REQUIRED** (except `disableRiskLimits`, which defaults to `false`). The compiler forces every runner to explicitly provide every infra primitive.

#### B. Factory function — wires all business logic ONCE

```ts
export type BuiltDeps = {
  pendingIntents: Map<string, ResolvedPendingContext>;
  pipelineDeps: ResolvedPipelineDeps;
  buildTaskEnv: (taskEnvInput: TaskEnvInput) => TaskEnv;
  /** Shared error handler — classify + requeue/fail. Runners call this, don't implement their own. */
  onTaskError: (task: Task, err: unknown) => Promise<'REQUEUED' | 'FAILED'>;
};

export type TaskEnvInput = {
  task: Task;
  emitter: SignalEventEmitter;
  onResult: (result: ProcessTaskResult) => Promise<void>;
  classifySkip?: (result: ...) => string;
  traderFilter?: string;  // for getPositions scoping
};

export function buildProcessTaskDeps(infra: RunnerInfra): BuiltDeps {
  const pendingIntents = new Map<string, ResolvedPendingContext>();

  // 1. Wire OrderManager callbacks — SAME logic for both paths (Issue 1)
  const callbacks = buildOrderCallbacks({
    pendingIntents,
    createScopedEmitter: (messageId) => createEmitter({
      messageId,
      ...(infra.tradeScope.kind === 'backtest'
        ? { backtestRunId: infra.tradeScope.backtestRunId }
        : { taskId: undefined }),
    }),
    onOrphanFill: handleOrphanFill,   // shared — persists + alerts for both paths
    onOrphanCancel: handleOrphanCancel, // shared — warns + alerts for both paths
  });
  infra.orderManager.setCallbacks(callbacks);

  // 2. Position sizing — ALWAYS passes spreadMaxRisk (fixes live gap)
  const calculatePositionSize = async (input: {
    trader: string; symbol: string; entryPrice: number;
    strategy: string; spreadMaxRisk?: number;
  }) => {
    const tc = await getTrader(input.trader);
    const balance = await infra.broker.getAccountBalance();
    const sizer = buildPositionSizer(tc?.positionSizingConfig);
    return sizer.calculateSize({
      symbol: input.symbol,
      strategy: input.strategy,
      entryPrice: input.entryPrice,
      equity: balance.equity,
      spreadMaxRisk: input.spreadMaxRisk,   // ALWAYS forwarded — was missing in live
      maxQuantity: MAX_CONTRACTS[input.strategy],
    });
  };

  // 3. Risk check — unified, no optional deps
  const checkRiskLimits = infra.disableRiskLimits
    ? async () => ({ allowed: true as boolean, dailyPnl: 0, ... })  // backtest escape hatch
    : (input) => checkRiskLimitsShared(input, infra.riskDeps, infra.riskConfig);

  // 4. Trade recording — ALWAYS includes agentModel (fixes live gap)
  const recordTrade = (input: RecordTradeInput) => recordTradeShared({
    ...input,
    ...(infra.tradeScope.kind === 'live'
      ? { taskId: infra.tradeScope.getTaskId(), isBacktest: false }
      : { backtestRunId: infra.tradeScope.backtestRunId, isBacktest: true }),
    metadata: {
      ...input.metadata,
      agentModel: `${infra.agentIdentity.provider}:${infra.agentIdentity.model}`,
    },
  });

  // 5. Pending intent registration
  const onPending = (orderId: string, ctx: ResolvedPendingContext) => {
    pendingIntents.set(orderId, ctx);
  };

  const pipelineDeps: ResolvedPipelineDeps = {
    broker: infra.broker,
    orderManager: infra.orderManager,    // REQUIRED (per Bonus)
    calculatePositionSize,
    checkRiskLimits,
    recordTrade,
    onPending,                            // REQUIRED (per Bonus)
  };

  // 6. Helper to build per-task env (emitter, onResult are per-task concerns)
  const buildTaskEnv = (input: TaskEnvInput): TaskEnv => ({
    getPositions: async (symbol) => {
      const filters: PositionFilters = symbol ? { symbol } : {};
      if (input.traderFilter) Object.assign(filters, { trader: input.traderFilter });
      const rows = await infra.getOpenPositions(filters);
      return rows.map(tradeToOpenPosition);
    },
    llm: /* passed through from runner */ input.llm ?? infra.llm,
    pipeline: pipelineDeps,
    emitter: input.emitter,
    onResult: input.onResult,
    classifySkip: input.classifySkip,
  });

  return { pendingIntents, pipelineDeps, buildTaskEnv };
}
```

#### C. What each runner looks like after refactoring

**Live runner** (`src/live/runner.ts`) — shrinks from ~90 lines of dep wiring to ~30:

```ts
const orderManager = new OrderManager({ broker: liveService, clock: () => new Date() });

const { pendingIntents, pipelineDeps } = buildProcessTaskDeps({
  broker: liveService,
  orderManager,
  clock: () => new Date(),
  tradeScope: { kind: 'live', getTaskId: () => currentTaskId },
  getOpenPositions,    // queries trades table with [isOpen, notBacktest]
  riskDeps,            // all fields required — no ?. allowed
  riskConfig: { ...LIVE_RISK_DEFAULTS },
  agentIdentity: DEFAULT_TRADE_MODEL,
});

// handleTask just builds the per-task env:
const emitter = createEmitter({ messageId: task.messageId, taskId: task.id });
await processTaskShared(task, {
  getPositions: ..., llm: provider, pipeline: pipelineDeps, emitter, onResult: ...
});
```

**Backtest runner** (`src/backtest/runner.ts`) — same pattern:

```ts
const orderManager = new OrderManager({
  broker, clock: () => clock.now(), manualTick: true,
});

const { pendingIntents, pipelineDeps } = buildProcessTaskDeps({
  broker,
  orderManager,
  clock: () => clock.now(),
  tradeScope: { kind: 'backtest', backtestRunId: runId },
  getOpenPositions: (filters) => broker.getOpenTrades(filters),
  riskDeps,            // all fields required — backtest provides () => 0 for reconciliation
  riskConfig,
  disableRiskLimits: config.disableRiskLimits,
  agentIdentity,
});
```

#### D. `OrderManager.setCallbacks()` — late binding

**File**: `src/orders/order-manager.ts`

Currently callbacks are set at construction and immutable. The factory needs to set callbacks AFTER construction because it owns the `pendingIntents` Map that the callbacks close over.

Add a method:

```ts
setCallbacks(callbacks: Pick<OrderManagerConfig, 'onFill' | 'onCancel' | 'onAdjust'>): void {
  if (this.workingOrders.size > 0) {
    throw new Error('Cannot setCallbacks while orders are active');
  }
  this.onFill = callbacks.onFill;
  this.onCancel = callbacks.onCancel;
  this.onAdjust = callbacks.onAdjust;
}
```

Guard ensures callbacks can't change mid-flight.

**Alternative**: Pass callbacks at construction as today, but have the factory create the OrderManager too. This avoids `setCallbacks()` entirely but means the factory returns the OrderManager — slightly wider scope. Either approach works. Prefer whichever keeps OrderManager construction closer to the runner (since live vs backtest use different `manualTick`/`clock` configs).

#### E. What the factory guarantees

After this refactoring, the only differences between live and backtest are:

| Concern | Where it lives | Runner provides |
|---------|---------------|-----------------|
| Broker implementation | `RunnerInfra.broker` | `liveService` vs `SimBroker` |
| Clock source | `RunnerInfra.clock` | `() => new Date()` vs `() => clock.now()` |
| Trade scoping | `RunnerInfra.tradeScope` | `{ kind: 'live', getTaskId }` vs `{ kind: 'backtest', backtestRunId }` |
| Position data source | `RunnerInfra.getOpenPositions` | DB query vs `broker.getOpenTrades()` |
| Risk config values | `RunnerInfra.riskConfig` | `LIVE_RISK_DEFAULTS` vs `BACKTEST_RISK_DEFAULTS` |
| Risk dep data sources | `RunnerInfra.riskDeps` | Real DB/broker queries vs sim clock/broker queries |
| Disable risk (backtest only) | `RunnerInfra.disableRiskLimits` | `false` (default) vs `config.disableRiskLimits` |
| Emitter scope per task | Per-task in runner | `{ taskId }` vs `{ backtestRunId }` |
| `classifySkip` / `onResult` | Per-task in runner | Different post-processing logic |
| OrderManager config | Runner constructs it | `manualTick`, clock differ |

Everything else — position sizing (with `spreadMaxRisk`), risk checking, trade recording (with `agentModel`), pending intent tracking, orphan fill/cancel handling, order callbacks — is wired **identically by the factory**. Zero duplication.

### Divergences Fixed by the Factory

1. **`spreadMaxRisk` always forwarded** — `calculatePositionSize` in the factory always passes `input.spreadMaxRisk` to the sizer. Live currently drops it. This is a real P&L bug for debit spread sizing.

2. **`agentModel` always recorded** — `recordTrade` in the factory always adds `agentModel` to metadata. Live currently drops it. Enables model attribution for live trade auditing.

3. **`onOrphanFill` / `onOrphanCancel` are factory internals** — same handler for both paths, scoped by `tradeScope`. Not a per-runner concern at all. No way to forget them, no way to diverge them.

4. **`getReconciliationAlertCount` + `getWorkingOrderExposure` required** — `RiskCheckDeps` type has no optional fields. Backtest must explicitly provide `() => 0` and `ZERO_EXPOSURE`.

5. **One `buildOrderCallbacks` call site** — currently duplicated in both runners. Factory calls it once. `pendingIntents` Map owned by factory, not by the runner.

---

## Implementation Order

| Phase | Issues | Rationale |
|-------|--------|-----------|
| 1 | 7 | Zero-risk quick win. Dead code removal. |
| 2 | 6 | Schema/type change. `TaskContextSchema` Zod parse in shared `processTask`. Removes banned index signature. |
| 3 | Bonus | Make `orderManager` + `onPending` required on `ResolvedPipelineDeps`. Prerequisite for factory. |
| 4 | 1 | Critical safety. Required `onOrphanFill`/`onOrphanCancel` callbacks + `orphan_fills` table + `setCallbacks()` on OrderManager. |
| 5 | 2 | Critical safety. ALL `RiskCheckDeps` fields required. `getExposure()` on OrderManager. |
| 6 | 5, 8 | **The big one.** Extract `buildProcessTaskDeps` factory with shared `onTaskError`, emitter creation, error handling. Both runners become thin infra wrappers. Fixes `spreadMaxRisk`, `agentModel`, `messageId!` assertion. |
| 7 | 3-4 | Operational resilience. `BrokerTransientError` in `src/lib/errors.ts`, `isHealthy()` on interface, circuit breaker in live poll loop (the ONLY live-specific business logic). |

## Testing Strategy

- **Issue 1**: Test that `onOrphanFill` is called when `pendingIntents` has no entry for a filled order. Verify `orphan_fills` table write + alert.
- **Issue 2**: Unit test in `risk-check.test.ts` — provide `getWorkingOrderExposure` returning 5 on a symbol at max → verify `allowed: false`.
- **Issues 3-4**: Test that `isHealthy() → false` prevents task claiming. Test consecutive failure counter opens circuit at threshold. Test transient broker error requeues task to PENDING.
- **Issue 5**: Already guarded in shared `processTask:39`. Test that missing `messageId` throws → factory `onTaskError` marks task FAILED.
- **Issue 6**: Test that corrupt JSON context triggers ZodError → failTask.
- **Issue 7**: Deletion — no test needed.
- **Issue 8**: Unit test for `buildProcessTaskDeps` — verify that both `tradeScope: 'live'` and `tradeScope: 'backtest'` produce identical `pipelineDeps` structure (same function signatures, same callbacks). Integration test: run existing backtest tests against factory-built deps — results must be identical. Verify `spreadMaxRisk` is forwarded by checking sizer input. Verify `agentModel` appears in recorded trade metadata.

## Files Modified

| File | Issues | Changes |
|------|--------|---------|
| `src/orders/build-order-callbacks.ts` | 1 | Add required `onOrphanFill` + `onOrphanCancel` to deps, replace silent returns |
| `src/db/schema.ts` | 1, 6 | Add `orphan_fills` table; replace TaskContext with Zod-derived type |
| `src/orders/risk-check.ts` | 2 | Add `WorkingOrderExposure` type, make ALL deps required, merge into 3 checks |
| `src/orders/order-manager.ts` | 1, 2, 8 | Add `setCallbacks()` for late binding, add `getExposure()` for working order risk |
| `src/lib/errors.ts` | 3-4 | Add `BrokerTransientError` (same pattern as `QuoteResolutionError`) |
| `src/broker/interface.ts` | 3-4 | Add `isHealthy(): Promise<boolean>` |
| `src/broker/ibkr/client.ts` | 3-4 | Implement `isHealthy`, throw `BrokerTransientError` at source |
| `src/broker/tradestation/client.ts` | 3-4 | Implement `isHealthy`, throw `BrokerTransientError` at source |
| `src/backtest/sim-broker.ts` | 3-4 | Add `isHealthy() → true` (never throws `BrokerTransientError`) |
| `src/pipeline/build-deps.ts` | 5, 8 | **NEW FILE** — `buildProcessTaskDeps` factory, `RunnerInfra` type, `TradeScope` type, shared `onTaskError` handler |
| `src/pipeline/process-task.ts` | 6 | Add `TaskContextSchema.parse()` at entry point (shared validation) |
| `src/pipeline/execute-resolved.ts` | Bonus | Make `orderManager` + `onPending` required, remove fallback branch |
| `src/live/runner.ts` | 3-4, 8 | Circuit breaker state machine (poll loop only), refactor to use factory |
| `src/backtest/runner.ts` | 8 | Refactor to use factory (eliminates ~60 lines of duplicated dep wiring) |
| `src/live/recorder.ts` | 7 | Remove dead `startTask` |
