---
paths: src/backtest/**
---

# Backtest Code

## Timestamps Are Mandatory

Backtest trades **must** have explicit timestamps — `openedAt`, `closedAt`, `trimmedAt`. Never fall back to `new Date()` or wall-clock time. `recordTrade()` enforces this with guards that throw if timestamps are missing in backtest mode.

When calling `recordTrade()`, always pass explicit ISO timestamps from the simulation clock.

## SimBroker Isolation

`SimBroker` implements `BrokerService` — it must not leak into shared pipeline code. Only files in `src/backtest/` should import `SimBroker` or `SimClock`.

The shared pipeline uses the `BrokerService` interface exclusively. If you need SimBroker-specific behavior, put it behind the interface.

## Fill Models

SimBroker supports multiple fill models (`orats`, `natural`, `midpoint`). The fill model is a backtest config concern — it never affects shared execution logic.

## OrderManager in Backtest

Backtest creates `OrderManager` with `manualTick: true`. The backtest runner explicitly calls `tick()` at each simulation time step. **Never** use wall-clock timers in backtest.

## Scoping

All backtest trades and positions are scoped by `backtestRunId`. The `forRun(runId)` filter ensures data isolation between runs. When querying positions or trades in backtest context, always include the run scope.

## Databento Cache

Market data comes from Databento via `src/backtest/market-data.ts` and `databento-tape.ts`. **Databento charges per byte.** Fetch minimum columns, narrowest date ranges, prefer cache. Never mass-delete `.cache/databento/` files. Empty `[]` cache files are valid (they prevent re-fetching).

## Dynamic Timezones

`dayBoundsUTC()` dynamically detects EST/EDT. Never hardcode UTC offsets (e.g., `-5` or `-4`).
