---
paths: src/backtest/**
---

# Backtest Code

## Timestamps

Always pass explicit ISO timestamps from the simulation clock to `recordTrade()` — never omit `openedAt` (OPEN/ADD actions) or `closedAt` (CLOSE/TRIM/LEG_OFF actions). If `requireExplicitTimestamps` is set in the pipeline config, `recordTrade()` will throw on missing timestamps; otherwise they silently default to wall-clock time (wrong for backtests).

## Fill Models

SimBroker supports multiple fill models (`orats`, `natural`, `midpoint`). The fill model is a backtest config concern — it never affects shared execution logic.

## OrderManager in Backtest

Backtest creates `OrderManager` with `manualTick: true`. The backtest runner explicitly calls `tick()` at each simulation time step. **Never** use wall-clock timers in backtest.

## Scoping

All backtest trades and positions are scoped by `channelId = btChannel(runId)` (format: `'bt:<runId>'`). The `forChannel(channelId)` filter ensures data isolation between runs. When querying positions or trades in backtest context, always include the channel scope.

## Market Data

`src/backtest/market-data.ts` and `databento-tape.ts`. Databento charges per byte — see CLAUDE.md DATABENTO COSTS MONEY rule.
