---
paths: src/live/**
---

# Live Execution

## Architecture — Multi-Channel, Push-Based

The runner operates one independent queue per channel (broker + account). Each channel has its own `BrokerService`, `PipelineBundle`, and `BrokerCircuitBreaker`. Channels process tasks sequentially within their queue but are independent of each other.

## runner.ts — Task Flow

Tasks are pushed, not polled. There is no safety-net poll loop.

1. SignalR delivers a message -> ingestion stores it in the DB
2. Composition root (`src/index.ts`) queries the stored message, calls `createTasksFromMessage()` (one task per enabled channel), then calls `submitTask(task)` for each
3. Runner routes the task to the correct channel queue by `task.channelId`, drains sequentially (one at a time per channel)

**Key exports:**
- `initRunner()` — called after `loadSecrets()`. Sets up per-channel broker pipelines, expires stale tasks, starts timers. Returns `{ channels: RuntimeChannelService[] }`.
- `submitTask(task: Task)` — enqueues a task to its channel. Silently drops if `stopRunner()` was called or `channelId` is unknown.
- `stopRunner()` — stops accepting new submissions (shutdown).
- `awaitDrain()` — resolves when all channel queues are empty and no task is in-flight.
- `destroyOrderManager()` — clears all timers, destroys per-channel pipeline bundles, resets state.

**Staleness guard:** Tasks older than 60s (`STALE_THRESHOLD_MS`) are EXPIRED, not processed. Alert sent per expiry.

**Circuit breaker gate:** If broker health check fails, the task is re-submitted with a 10s delay via `setTimeout(() => submitTask(task), 10_000)`. The task is NOT expired -- it retries once the broker recovers.

**Atomic claim:** `UPDATE status=IN_PROGRESS WHERE status=PENDING` guards against the web UI's `skipTask()` racing with the runner.

**No task-level requeue on errors.** Broker retries happen at the client level (`withRetry` in `src/lib/resilient.ts`). If an error survives retries and reaches the runner, the task is marked FAILED via `handleTaskError()`. The runner records the failure on the circuit breaker and continues draining.

## factory.ts — Task Creation

Two exports, both async:
- `createTaskFromMessage(message, channelId)` — returns `Task | null` (full object from `.returning()`). Inserts a task row with `onConflictDoNothing` for idempotency. No knowledge of the runner.
- `createTasksFromMessage(message, channelIds)` — calls the singular form once per channel. Used by `src/index.ts` for multi-channel fan-out.

Task type is determined by confidence: `>= 0.7` with badges -> `EXECUTE_TRADE`, otherwise `REVIEW_MESSAGE`. Messages without badges always go to `REVIEW_MESSAGE` regardless of confidence.

## runtime-health.ts — Broker Health Tracking

`upsertRuntimeHealth(channelId, fields)` — fire-and-forget DB upsert (sync `.run()`, never awaited) that records broker health, circuit breaker state, and last error per channel. Called throughout the runner after health checks, task success, and task failure. Read by the web dashboard for operational visibility.

## Startup Behavior

`initRunner()` expires stale tasks before accepting submissions:
- PENDING tasks older than 60s -> EXPIRED ("stale: process restarted")
- All IN_PROGRESS tasks -> EXPIRED ("stale: interrupted by restart")
- Batch alert sent if any tasks were expired

## Periodic Timers

Independent of task processing:
- **Expiry warnings**: every 5 min, checks open positions approaching option expiration
- **Health probe**: every 30s, probes broker health per channel and updates `runtime_health` table

Both cleared by `destroyOrderManager()`.

## Error Handling

- `handleTaskError()` (from `src/pipeline/task-lifecycle.ts`) marks the task FAILED and re-throws
- Runner catches the re-throw, records on circuit breaker, updates runtime health, continues draining
- `BrokerTransientError` (`src/lib/errors.ts`) is used by the circuit breaker for log-level classification (`recordFailure` checks `instanceof`). No broker currently throws it, but the class and its consumer are live code -- do not remove without updating the circuit breaker.

## Risk Defaults

Live uses `LIVE_RISK_DEFAULTS` from `src/config/risk-defaults.ts`. Key difference from backtest: live allows higher `maxOnSymbol` (5 vs 3) to accommodate multi-trader overlap on the same symbol. All other limits are identical.

Live also enforces `getReconciliationAlertCount()` -- blocks new trades if unresolved reconciliation alerts exist. Backtest skips this check.

When adding a new risk parameter, add it to both `BACKTEST_RISK_DEFAULTS` and `LIVE_RISK_DEFAULTS` in `src/config/risk-defaults.ts`.

## Broker Selection

Documented in `broker-interface.md`. The runner calls `getRuntimeChannelServices()` from `src/broker/select.ts` during `initRunner()` to get the list of enabled channels with their broker instances.
