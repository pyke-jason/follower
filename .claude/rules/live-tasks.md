---
paths: src/live/**
---

# Live Execution

## runner.ts — Push-Based Task Queue

Tasks are pushed to the runner, not polled from the DB. The flow:

1. SignalR delivers message -> ingestion stores it -> factory creates task row + returns `Task` object
2. Composition root (`index.ts`) calls `submitTask(task)` on the runner
3. Runner queues the Task, drains sequentially (one at a time)

**Key exports:**
- `initRunner()` — async, called after `loadSecrets()`. Sets up broker(s), pipeline, expires stale tasks, starts timers. Returns `{ channels: RuntimeChannelService[] }` (multi-channel).
- `submitTask(task: Task)` — enqueues a task. Silently drops if `stopRunner()` was called.
- `stopRunner()` — stops accepting new submissions (shutdown).
- `awaitDrain()` — waits for queue empty + current task done.
- `destroyOrderManager()` — clears timers, stops WS listener, destroys bundle.

**Staleness guard:** Tasks older than 60s are EXPIRED (not processed). Alert sent per expiry.

**Circuit breaker gate:** If broker is unhealthy, task is re-enqueued with 10s delay (not expired).

**Atomic claim:** `UPDATE status=IN_PROGRESS WHERE status=PENDING` guards against web UI `skipTask()` racing.

**No poll loop.** No safety-net poll. The only path to execution is `submitTask()`.

**No task-level requeue.** Broker retries happen at the client level (`withRetry` in `resilient.ts`). If an error survives retries and reaches the runner, the task is FAILED.

## factory.ts

`createTaskFromMessage(message)` returns `Task | null` (full object from `.returning()`). Zero knowledge of runner. The composition root wires factory output to `submitTask()`.

## Startup Behavior

`initRunner()` expires all stale tasks before accepting submissions:
- PENDING tasks older than 60s -> EXPIRED ("stale: process restarted")
- All IN_PROGRESS tasks -> EXPIRED ("stale: interrupted by restart")
- Batch alert sent if any tasks expired.

## Periodic Side Effects

Independent timers (not coupled to task processing):
- **Expiry warnings**: `setInterval` every 5 min, checks positions approaching expiration
- **Circuit breaker health**: `setInterval` every 30s, probes broker health

Both cleared by `destroyOrderManager()`.

## Error Handling

- `handleTaskError()` always marks FAILED and re-throws (no requeue branch)
- Runner catches the re-throw, records on circuit breaker, continues draining
- `BrokerTransientError` requeue was removed (dead code — never thrown)

## Per-Task Pipeline Wrapping (processTask)

`processTask()` wraps the pipeline to inject `taskId` -- applied to ALL tasks (live AND backtest):
- `recordTrade(input)` -> `recordTrade({ ...input, taskId: task.id })`
- `onPending(orderId, ctx)` -> `onPending(orderId, { ...ctx, taskId: task.id })`

This ensures fill callbacks carry the taskId of the task that placed the order. The wrapping happens unconditionally in `process-task.ts`.

## Positions

Both live and backtest positions come from the `trades` table -- same query, different scope filter (`forChannel(channelId)`). The `buildPipelineDeps()` factory derives the filter from `env.scope`.

## Risk Defaults

Live uses `LIVE_RISK_DEFAULTS` from `src/config/risk-defaults.ts` (stricter `maxOnSymbol` than backtest). Includes `getReconciliationAlertCount()` check (blocks trading if unresolved DB-only reconciliation alerts).

If adding a new risk check, add it to both `BACKTEST_RISK_DEFAULTS` and `LIVE_RISK_DEFAULTS`.

## Broker Selection

`getRuntimeChannelServices()` (`src/broker/select.ts`) is the single source of truth for live broker selection. Returns a map of `channelId → BrokerService` supporting multiple accounts/brokers concurrently.
- Both brokers implement `BrokerService` interface
- TradeStation (`src/broker/tradestation/`) uses OAuth via `auth.ts`. Never hardcode credentials -- use environment variables.
- IBKR (`src/broker/ibkr/`) uses sidecar + WebSocket.
