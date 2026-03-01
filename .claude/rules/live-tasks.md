---
paths: src/live/**, src/broker/tradestation.ts, src/broker/auth.ts
---

# Live Execution

## runner.ts

Live task processing loop. Polls DB for pending tasks, executes through the shared pipeline.

Key differences from backtest:
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
