# Push-Based Live Runner

## Problem

The live runner polls the DB every 3 seconds for PENDING tasks. This has three issues:

1. **Staleness** — No age guard on the PENDING query. If the runner was stopped or behind, it processes tasks from hours ago. The stale IN_PROGRESS recovery on startup re-queues old tasks back to PENDING, making this worse.
2. **Latency** — Up to 3s delay between task creation and processing.
3. **Indirection** — Factory writes to DB, runner reads from DB. The ingestion callback already has the full Task in hand but throws it away and only keeps the ID.

## Task Write Consolidation

Today there are two paths that write task rows:

- **Live**: `factory.ts` inserts task -> returns `taskId` -> runner reads task back from DB -> passes `Task` to `processTask()` -> `processTask` does a no-op idempotent insert (already exists).
- **Backtest**: `taskFromMessage()` builds an in-memory `Task` -> passes it to `processTask()` -> `processTask` writes it to DB (the real insert).

Both paths converge at `processTask(task: Task, env)`. The live path does a pointless write-then-read roundtrip.

**Fix**: Factory returns the full `Task` object (from `.returning()`). Runner accepts `Task`, not `taskId`. No DB read needed. `processTask()` remains the idempotent write point for both paths.

## Error Handling: No Task-Level Requeue

### Current state (dead code)

`handleTaskError()` checks `instanceof BrokerTransientError` to decide whether to requeue a task. Investigation revealed that **`BrokerTransientError` is never thrown anywhere in the codebase**. The broker clients (`ibkr/client.ts`, `tradestation/client.ts`) already handle transient errors at the client level via `withRetry()` in `src/lib/resilient.ts`:

- IBKR: `ibkrClassify()` categorizes errors as transient/permanent. `withRetry()` retries transient errors up to 5x (reads) or 2x (writes) with exponential backoff.
- TradeStation: Similar classification and retry at the client level.

By the time an error reaches the runner, it has already survived broker-level retries. Re-running the entire pipeline (LLM classification, position sizing, risk checks) would be wasteful and pointless.

### New behavior

If `processTaskShared()` throws, the task is FAILED. No requeue. The broker already retried at the right level.

```typescript
// Inside handleTask():
try {
  await processTaskShared(task, { ... });
} catch (err) {
  await handleTaskError(task.id, err);
  // handleTaskError marks FAILED and re-throws
  // Circuit breaker records the failure
}
```

### Cleanup

- Remove `BrokerTransientError` requeue branch from `handleTaskError()` — it's dead code
- Remove `requeueTask()` from `task-lifecycle.ts` — no callers
- Remove `BrokerTransientError` import from `task-lifecycle.ts`
- Keep `BrokerTransientError` class in `errors.ts` (circuit breaker still checks it for log level classification; can be cleaned up separately)

## Why Not a Shared Queue

The backtest runner has fundamentally different orchestration:

- **Day boundaries**: Clock advancement, order expiry sweeps, auto-close positions, MTM snapshots
- **Shadow tracking**: Records followed/skipped opens for unfollowed exit detection
- **Stats accumulation**: Mutable stats map updated per-message across thousands of iterations
- **Fatal errors**: A single task failure crashes the entire backtest (correct behavior)
- **Simulation clock**: `manualTick: true` on OrderManager, explicit `tick()` at each time step

A shared queue would require a complex hook system (`onTaskBetween`, `classifyError`, `onTaskComplete`) with backtest passing 5+ callbacks and live ignoring most of them. That's a leaky abstraction.

**The correct shared boundary already exists**: `processTaskShared()` in `process-task.ts`. Both runners call it identically. Everything above it (task scheduling, error policy, housekeeping) is runner-specific.

## Design

### Architecture: Three Clean Seams

```
SignalR message
  |
  v
[Ingestion]  --stores message-->  DB (messages table)
  |
  v
[Factory]    --creates task---->  DB (tasks table)  --returns Task-->
  |
  v
[Composition Root (index.ts)]  --submitTask(task)-->
  |
  v
[Runner]     --claims & processes-->  Pipeline (processTaskShared)
```

**Seam 1 -- Factory** (`live/factory.ts`): Pure. Message in, task row + object out. Returns `Task | null`. Zero knowledge of runner.

**Seam 2 -- Composition root** (`index.ts`): Wires factory output to runner input. The only place that knows both exist.

**Seam 3 -- Runner** (`live/runner.ts`): Owns an in-memory queue and sequential drain loop. Exports `submitTask(task: Task)`. Zero knowledge of ingestion or factory.

### Runner Internal Design

```typescript
// Public API
export function submitTask(task: Task): void         // enqueue + wake
export function stopRunner(): void                   // stop accepting, drain
export async function awaitDrain(): Promise<void>    // wait for queue empty + current task

// Internal
const queue: Task[] = [];
let draining = false;
let accepting = true;
let currentTaskPromise: Promise<void> | null = null;

function submitTask(task: Task): void {
  if (!accepting) return;   // shutdown guard
  queue.push(task);
  if (!draining) drainQueue();
}

async function drainQueue(): Promise<void> {
  draining = true;
  while (queue.length > 0) {
    const task = queue.shift()!;
    currentTaskPromise = claimAndProcess(task);
    await currentTaskPromise;
    currentTaskPromise = null;
  }
  draining = false;
}
```

### Staleness Guard

Inside `claimAndProcess(task)`:

```typescript
async function claimAndProcess(task: Task): Promise<void> {
  const ageMs = Date.now() - new Date(task.createdAt).getTime();
  if (ageMs > STALE_THRESHOLD_MS) {
    const reason = `stale: created ${Math.round(ageMs / 1000)}s ago`;
    await expireTask(task.id, reason);
    sendSystemAlert({
      title: 'Task expired (stale)',
      message: `Task ${task.id} expired: ${reason}. Check runner health.`,
      severity: 'warning',
    });
    return;
  }

  // Circuit breaker gate
  if (!await circuitBreaker.checkHealth()) {
    // Don't expire -- leave PENDING for retry after circuit closes
    // Re-enqueue with delay
    setTimeout(() => submitTask(task), circuitBreaker.currentBackoffMs());
    return;
  }

  // Atomic claim -- still needed: web UI skipTask() could race
  const claimed = await db.update(schema.tasks)
    .set({ status: 'IN_PROGRESS', startedAt: new Date().toISOString() })
    .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, 'PENDING')))
    .returning();

  if (claimed.length === 0) return;  // skipped via web UI or already claimed

  await handleTask(task);
}
```

No DB read. The Task object is already in hand from the factory. The atomic claim is a pure guard against the web UI's `skipTask()` action racing with processing.

### Staleness Threshold

**60 seconds.** Rationale:
- Messages arrive in real-time via SignalR; any task >60s old missed its window
- Market conditions change rapidly; executing on stale signals is worse than skipping
- Configurable via `STALE_THRESHOLD_MS` constant for easy tuning

### New Status: EXPIRED

Add `EXPIRED` as a terminal task status:
- Used when a task is too old to process safely
- Distinguished from FAILED (which means "tried and errored") and SKIPPED (which means "human chose to skip")
- Web frontend needs to display it (add to `STATUSES` array in `task-list.tsx`)

```typescript
// task-lifecycle.ts -- new function
export async function expireTask(taskId: string, reason: string): Promise<void> {
  await db.update(schema.tasks)
    .set({ status: 'EXPIRED', error: reason, completedAt: new Date().toISOString() })
    .where(eq(schema.tasks.id, taskId));
}
```

### Startup: Expire Stale Tasks

Replace the current "re-queue stale IN_PROGRESS" with "expire everything old":

```typescript
// On init, before accepting submissions:
const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
const now = new Date().toISOString();

// Expire stale PENDING tasks (leftover from previous run)
await db.update(schema.tasks)
  .set({ status: 'EXPIRED', error: 'stale: process restarted', completedAt: now })
  .where(and(
    eq(schema.tasks.status, 'PENDING'),
    sql`created_at < ${staleThreshold}`,
    sql`(channel_id = ${liveChannelId} OR channel_id IS NULL)`,
  ));

// Expire stale IN_PROGRESS tasks (interrupted by previous crash)
await db.update(schema.tasks)
  .set({ status: 'EXPIRED', error: 'stale: interrupted by restart', completedAt: now })
  .where(and(
    eq(schema.tasks.status, 'IN_PROGRESS'),
    sql`(channel_id = ${liveChannelId} OR channel_id IS NULL)`,
  ));
```

No re-queuing. If it was pending from the last run, it's stale. If it was in-progress, it was interrupted.

Alert if any tasks were expired on startup (batch count, not per-task):

```typescript
const expiredCount = pendingExpired.length + inProgressExpired.length;
if (expiredCount > 0) {
  sendSystemAlert({
    title: 'Stale tasks expired on startup',
    message: `${expiredCount} task(s) expired (${pendingExpired.length} pending, ${inProgressExpired.length} interrupted). Signals were missed during downtime.`,
    severity: 'warning',
  });
}
```

## Periodic Side Effects

Two behaviors are currently coupled to the poll loop and need new homes:

### 1. Expiry Warnings (every 5 min)

Move to an independent `setInterval` in `runner.ts`, started by `initRunner()`:

```typescript
let expiryTimer: ReturnType<typeof setInterval> | null = null;

// In initRunner():
expiryTimer = setInterval(() => {
  checkExpiryWarnings(() => getOpenPositions()).catch(() => {});
}, 5 * 60 * 1000);

// In destroyOrderManager():
if (expiryTimer) clearInterval(expiryTimer);
```

### 2. Circuit Breaker Health Probing

Currently piggybacks on the 3s poll loop (with 30s cache internally). Move to an independent timer:

```typescript
let healthTimer: ReturnType<typeof setInterval> | null = null;

// In initRunner():
healthTimer = setInterval(async () => {
  await circuitBreaker.checkHealth();
}, 30_000);  // Match existing cache interval

// In destroyOrderManager():
if (healthTimer) clearInterval(healthTimer);
```

The circuit breaker's internal 30s cache means frequent calls are cheap, but we only need to probe every 30s anyway.

## Shutdown Sequence

```typescript
// index.ts shutdown():

stopIngestion();          // 1. Stop accepting messages (non-blocking)
stopRunner();             // 2. Stop accepting task submissions (sets accepting=false)

// 3. Wait for queue drain + current task (bounded by 30s)
await Promise.race([
  awaitDrain(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
]);

destroyOrderManager();    // 4. Stop WS listener, clear order manager, clear timers
await reconScheduler?.stop();
await fillSweep?.stop();
await closeBrowser();
releaseLock(LOCK_PATH);
process.exit(0);
```

### Race condition: message arrives after stopIngestion()

`stopIngestion()` is non-blocking -- the supervision loop may still have an in-flight SignalR callback. If that callback calls `submitTask()` after `stopRunner()`, the submission is silently dropped (`if (!accepting) return`). The task sits in DB as PENDING and gets expired on next startup. This is acceptable -- the message is <100ms old and the process is shutting down.

## Ingestion Callback Fix

Agent investigation found that the ingestion callback is async but typed as sync void, with no error handling. Fix while we're here:

```typescript
// index.ts -- updated callback
startIngestion(async (msg) => {
  try {
    const stored = await db.select()
      .from(schema.messages)
      .where(eq(schema.messages.id, msg.Id))
      .limit(1);

    if (stored[0]) {
      const task = await createTaskFromMessage(stored[0]);
      if (task) submitTask(task);
    }
  } catch (err) {
    console.error('[Ingest] Task creation failed:', err);
  }
});
```

Also fix the type in `ingest.ts`:

```typescript
// ingest.ts -- fix callback type
type OnMessage = (msg: SignalRMessage) => void | Promise<void>;
```

And await it in the handler:

```typescript
await onMessage?.(msg);  // was: onMessage?.(msg)
```

## Concurrency: Multiple SignalR Messages

SignalR can fire multiple messages concurrently. With the push model, this is fine:
- Each calls `submitTask(task)` which pushes to the queue
- Queue drains sequentially (one task at a time)
- No double-processing: atomic claim (UPDATE where status=PENDING) prevents it
- `onConflictDoNothing` in factory prevents duplicate tasks for the same message

## Factory Return Type Change

`createTaskFromMessage()` currently returns `string | null` (task ID). Change to `Task | null`:

```typescript
// factory.ts -- updated return
export async function createTaskFromMessage(message: Message): Promise<Task | null> {
  // ... existing validation ...

  const [task] = await db.insert(schema.tasks).values({
    messageId: message.id,
    taskType,
    status: 'PENDING',
    assignee: 'agent',
    context,
  }).onConflictDoNothing().returning();

  if (!task) {
    console.log(`[Factory] Duplicate task skipped for message ${message.id}`);
    return null;
  }

  console.log(`[Factory] Created ${taskType} task ${task.id} for ${message.author}`);
  return task;  // was: return task.id
}
```

The `.returning()` already gives us the full row. We were discarding it.

## Files Changed

| File | Change |
|------|--------|
| `src/live/runner.ts` | Replace poll loop with push queue. New exports: `submitTask(task: Task)`, `stopRunner`, `awaitDrain`. Remove `startTaskRunner`, `stopTaskRunner`. Add independent timers for expiry + health. Simplify error handling (no requeue). |
| `src/live/factory.ts` | Return `Task \| null` instead of `string \| null`. No logic change -- `.returning()` already gives the full row. |
| `src/index.ts` | Wire `submitTask(task)` into ingestion callback. Update shutdown to use `stopRunner()` + `awaitDrain()`. Remove `startTaskRunner()` call. Add try-catch to callback. |
| `src/pipeline/task-lifecycle.ts` | Add `expireTask()`. Remove `requeueTask()` and `BrokerTransientError` requeue branch from `handleTaskError()` (dead code). |
| `src/ingestion/ingest.ts` | Fix callback type to `void \| Promise<void>`, await callback invocation. |
| `web/app/tasks/task-list.tsx` | Add 'EXPIRED' to STATUSES array. |
| `web/app/tasks/[id]/page.tsx` | Handle EXPIRED status display (same as FAILED, different label). |
| `.claude/rules/live-tasks.md` | Update documentation to reflect push model. |

## Files NOT Changed

| File | Why |
|------|-----|
| `src/pipeline/process-task.ts` | Stateless shared code. Already accepts `Task` object. Idempotent insert handles both paths. The correct shared boundary -- both runners call this identically. |
| `src/pipeline/execute-resolved.ts` | Shared executor. Unchanged. |
| `src/pipeline/build-deps.ts` | Factory. Unchanged. |
| `src/backtest/runner.ts` | Fundamentally different orchestration (day boundaries, clock, shadows, stats). Already passes in-memory `Task` to `processTask()`. Not forced into a shared queue. |
| `src/lib/circuit-breaker.ts` | Already generic. Unchanged. |
| `src/lib/expiry-warning.ts` | Already a pure function. Unchanged. |
| `src/lib/resilient.ts` | Broker-level retry (`withRetry`) already handles transient errors before they reach the runner. This is the correct retry layer. |

## No Safety-Net Poll

There is no fallback poll loop. Rationale:
- The only valid path to execution is `submitTask()`
- On startup, leftover PENDING/IN_PROGRESS are expired (too old by definition)
- If push is broken, the system should alert (ingestion down = healthcheck fails), not silently poll stale data
- Simplicity: one path to execution, not two

## Testing Strategy

1. **Unit test `submitTask` + drain**: Push 3 Task objects, verify sequential processing, verify staleness rejection.
2. **Unit test shutdown**: Submit tasks, call `stopRunner()`, verify no new submissions accepted, `awaitDrain()` resolves after current task.
3. **Unit test circuit breaker gate**: Submit task with circuit open, verify re-enqueue with delay.
4. **Unit test startup expiry**: Seed PENDING + IN_PROGRESS tasks older than 60s, verify they're EXPIRED after init.
5. **Integration test**: Full flow from `createTaskFromMessage` -> `submitTask` -> `processTaskShared` completion.

## Questions Resolved

| Question | Decision | Rationale |
|----------|----------|-----------|
| Staleness threshold | 60 seconds | Real-time signals; market conditions change fast |
| EXPIRED status | New status value | Semantically distinct from FAILED and SKIPPED |
| Task-level requeue | Removed (dead code) | `BrokerTransientError` is never thrown. Broker retries at client level via `withRetry()`. Re-running entire pipeline is wasteful. |
| Shared queue for backtest | No | Backtest has day boundaries, clock, shadows, stats. Shared boundary is `processTaskShared()`. Forcing a shared queue = leaky abstraction. |
| Safety-net poll | None | One execution path. Alert on ingestion failure instead. |
| Entry point type | `submitTask(task: Task)` not `submitTask(taskId)` | No DB roundtrip. Factory already has full row from `.returning()`. Consistent with backtest which passes in-memory Task. |
| Factory return type | `Task \| null` instead of `string \| null` | `.returning()` already gives full row; we were discarding it |
| Task write consolidation | `processTask()` remains idempotent write point | Live: factory writes + processTask no-ops. Backtest: processTask writes. Already converged. |
| Error retry layer | Broker client (`withRetry` in `resilient.ts`) | Retries transient HTTP/network errors 2-5x with backoff before they reach the pipeline. Correct layer -- no need to re-classify or re-size. |
