---
paths: src/live/**
---

# Live Execution

## runner.ts

Live task processing loop. Polls DB for pending tasks, executes through the shared pipeline.

Uses `buildPipelineDeps()` from `src/pipeline/build-deps.ts` with:
- `scope: liveChannel(accountId)` — format `'live:<accountId>'` (broker agnostic)
- `sendAlert: sendSystemAlert`
- Risk limits always enforced (no `disableRiskLimits`)

The factory builds a stateless pipeline bundle. `broker` selection is delegated to `selectBroker()` from `src/broker/select.ts`, which picks the broker implementation based on the `BROKER` env var. See `selectBroker()` for supported brokers and their required env vars.

## Per-Task Pipeline Wrapping (processTask)

`processTask()` wraps the pipeline to inject `taskId` — applied to ALL tasks (live AND backtest):
- `recordTrade(input)` → `recordTrade({ ...input, taskId: task.id })`
- `onPending(orderId, ctx)` → `onPending(orderId, { ...ctx, taskId: task.id })`

This ensures fill callbacks (which fire asynchronously) carry the taskId of the task that placed the order, not whatever task happens to be running at fill time. The wrapping happens unconditionally in `process-task.ts`.

For live, scope format `'live:<accountId>'` is baked at factory construction via `liveChannel(accountId)`. For backtest, `'bt:<runId>'` via `btChannel(runId)`.

## Positions

Both live and backtest positions come from the `trades` table — same query, different scope filter (`forChannel(channelId)`). The `buildPipelineDeps()` factory derives the filter from `env.scope`.

## Risk Defaults

Live uses `LIVE_RISK_DEFAULTS` from `src/config/risk-defaults.ts` (stricter `maxOnSymbol` than backtest). Includes `getReconciliationAlertCount()` check (blocks trading if unresolved DB-only reconciliation alerts).

If adding a new risk check, add it to both `BACKTEST_RISK_DEFAULTS` and `LIVE_RISK_DEFAULTS`.

## Broker Selection

`selectBroker()` (`src/broker/select.ts`) is the single source of truth for live broker selection:
- Both brokers implement `BrokerService` interface
- TradeStation (`src/broker/tradestation/`) uses OAuth via `auth.ts`. Never hardcode credentials — use environment variables.
- IBKR (`src/broker/ibkr/`) uses sidecar + WebSocket. IBKR runner starts `startWsListener()` on init and stops it on shutdown to avoid listener leaks.
