---
paths: src/backtest/**
---

# Backtest Code

## Timestamps Are Mandatory

`recordTrade()` throws if backtest trades are missing explicit timestamps. Always pass ISO timestamps from the simulation clock — never omit `openedAt` (OPEN/ADD actions) or `closedAt` (CLOSE/TRIM/LEG_OFF actions).

## Fill Models

SimBroker supports multiple fill models (`orats`, `natural`, `midpoint`). The fill model is a backtest config concern — it never affects shared execution logic.

## OrderManager in Backtest

Backtest creates `OrderManager` with `manualTick: true`. The backtest runner explicitly calls `tick()` at each simulation time step. **Never** use wall-clock timers in backtest.

## Scoping

All backtest trades and positions are scoped by `channelId = btChannel(runId)` (format: `'bt:<runId>'`). The `forChannel(channelId)` filter ensures data isolation between runs. When querying positions or trades in backtest context, always include the channel scope.

## Market Data

`src/backtest/market-data.ts` and `databento-tape.ts`. Databento charges per byte — see CLAUDE.md DATABENTO COSTS MONEY rule.
