---
paths: src/tasks/**, src/broker/tradestation.ts, src/broker/auth.ts
---

# Live Execution — Real Money

Code in these files handles **real broker orders with real money**. Exercise extra caution.

## runner.ts

This is the live task processing loop. It polls the DB for pending tasks, executes through the shared pipeline, and records results.

Key responsibilities:
- Builds `ResolvedPipelineDeps` with `liveService` (TradeStation broker)
- Creates `OrderManager` with wall-clock timer (default `manualTick: false`)
- Provides `getOpenPositions()` — queries DB filtered by `notBacktest` and trader
- Risk limits are **always enforced** (no `disableRiskLimits` option)
- Wraps `recordTrade()` with `{ taskId, isBacktest: false }`

## Positions

Live positions come from the `trades` table filtered by `isOpen` + `notBacktest`. This differs from backtest which uses `forRun(backtestRunId)`. Both return `Trade[]` — same shape, different scope.

## Risk Defaults

Live uses `LIVE_RISK_DEFAULTS` from `src/config/risk-defaults.ts`:
- `maxOnSymbol: 5` (vs 3 in backtest)
- Includes `getReconciliationAlertCount()` check (blocks trading if unresolved alerts)

If adding a new risk check, add it to both `BACKTEST_RISK_DEFAULTS` and `LIVE_RISK_DEFAULTS`.

## TradeStation API

`src/broker/tradestation.ts` implements `BrokerService`. OAuth tokens are managed in `auth.ts`. Never hardcode credentials — use environment variables via the secrets module.
