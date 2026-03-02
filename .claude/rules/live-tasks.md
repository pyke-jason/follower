---
paths: src/live/**, src/broker/tradestation/**
---

# Live Execution

## runner.ts

Live task processing loop. Polls DB for pending tasks, executes through the shared pipeline.

Uses `buildPipelineDeps()` from `src/pipeline/build-deps.ts` with:
- `scope: { kind: 'live' }`
- `sendAlert: sendSystemAlert`
- Risk limits always enforced (no `disableRiskLimits`)

The factory builds a stateless pipeline bundle. `taskId` is injected per-task by `processTask()`, which wraps `pipeline.recordTrade` and `pipeline.onPending` to thread the current `task.id` through. This avoids mutable module-level state.

## Per-Task Pipeline Wrapping (processTask)

For live scope, `processTask` wraps the pipeline to inject `task.id`:
- `recordTrade(input)` → `recordTrade({ ...input, taskId: task.id })`
- `onPending(orderId, ctx)` → `onPending(orderId, { ...ctx, taskId: task.id })`

This ensures fill callbacks (which fire asynchronously) carry the taskId of the task that placed the order, not whatever task happens to be running at fill time.

Backtest uses the pipeline as-is — `backtestRunId` is baked immutably at factory construction.

## Positions

Both live and backtest positions come from the `trades` table — same query, different scope filter (`notBacktest` vs `forRun(runId)`). The `buildPipelineDeps()` factory derives the filter from `env.scope`.

## Risk Defaults

Live uses `LIVE_RISK_DEFAULTS` from `src/config/risk-defaults.ts`:
- `maxOnSymbol: 5` (vs 3 in backtest)
- Includes `getReconciliationAlertCount()` check (blocks trading if unresolved alerts)

If adding a new risk check, add it to both `BACKTEST_RISK_DEFAULTS` and `LIVE_RISK_DEFAULTS`.

## TradeStation API

`src/broker/tradestation/` implements `BrokerService`. OAuth tokens are managed in `auth.ts`. Never hardcode credentials — use environment variables via the secrets module.
