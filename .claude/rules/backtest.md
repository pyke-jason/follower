---
paths: src/backtest/**
---

# Backtest Code

## Time Simulation — SimClock + advanceTo

Backtest time is controlled by two mechanisms that must stay synchronized:

1. **`SimClock`** (`clock.ts`) — mutable clock. `clock.advance(to)` moves sim time forward. All code that reads "now" in backtest uses `clock.now()` (injected via `env.clock` in `buildPipelineDeps`).
2. **`SimBroker.advanceTo(time)`** — replays Databento market ticks between the previous advance time and `time`, evaluating working orders for fills against each tick.
3. **`OrderManager.tick(time)`** — evaluates chase adjustments and cancel-after timeouts at `time`.

The runner calls all three in sequence for each message: `clock.advance()`, then `broker.advanceTo()`, then `orderManager.tick()`. For chase orders, `advanceWithChaseInterleaving()` sub-steps through time at the chase interval so chase adjustments fire between ticks.

**Never use wall-clock time in backtest.** No `Date.now()`, no `setTimeout`, no `setInterval`. All time flows through `SimClock`.

## Timestamps on Trade Records

Always pass explicit ISO timestamps from the simulation clock to `recordTrade()` — `openedAt` for OPEN/ADD, `closedAt` for CLOSE/TRIM/LEG_OFF. Without them, `recordTrade()` silently defaults to wall-clock `new Date()`, which produces wrong timestamps for historical replay. The `requireExplicitTimestamps` flag on `PipelineConfig` makes `recordTrade()` throw instead of defaulting, but the backtest runner does not currently enable it — timestamps arrive via the `SimBroker` fill callback path instead.

## Fill Models

`SimBroker` supports three fill models (`orats`, `natural`, `midpoint`) defined in `FillModelSchema` (`types.ts`). The fill model controls how `SimBroker` determines fill prices from Databento ticks — it is evaluated inside `SimBroker.tryFillOrder()` only. It never appears in shared pipeline code (`execute-resolved.ts`, `process-task.ts`). The fill model is a backtest config concern set at launch.

## OrderManager — manualTick Mode

The backtest passes `manualTick: true` through `buildPipelineDeps()` config, which disables `OrderManager`'s 1-second wall-clock auto-tick timer. The runner is responsible for calling `bundle.orderManager.tick()` explicitly at each simulation step. `OrderManager` is created by the `buildPipelineDeps()` factory, not directly by backtest code.

## Day-Boundary Logic

The runner tracks day transitions via message timestamps. On each new trading day:

1. **Final tick advance** — `advanceWithChaseInterleaving()` to previous day's market close, giving working orders a last chance to fill.
2. **Cancel stale close orders** — unfilled close orders from previous day are cancelled.
3. **Cancel expired-leg orders** — open orders with legs that expired before the new day.
4. **Auto-close expiring options** — `broker.autoCloseExpiring()` closes positions with options expiring on the boundary day at market price.
5. **Sweep expired** — `broker.sweepExpired()` closes any remaining expired options at intrinsic value (fallback).
6. **MTM snapshot** — mark-to-market unrealized PnL written to `backtest_mtm_snapshots` for equity curve.
7. **Margin check** — warns if equity drops below maintenance margin.

This is the most bug-prone part of the runner. When modifying day-boundary behavior, test with multi-day backtests that include option expirations.

## ShadowTracker

`ShadowTracker` (`shadow-tracker.ts`) is backtest-only. It records which OPEN signals were skipped (risk limits, no quote, etc.) so that later exit signals for the same author:symbol can be classified as `unfollowed_exit` instead of a pipeline failure. If a later OPEN for the same author:symbol executes, the shadow is cleared.

## Scoping

All backtest data is scoped by `channelId = btChannel(runId)` (format: `'bt:<runId>'`). The `forChannel(channelId)` filter ensures data isolation between runs. Always include the channel scope when querying positions or trades.

## Market Data

`market-data.ts` (price provider) and `databento-tape.ts` (HTTP client + tick parsing). Tick data is cached in `tick-cache.db` via `tick-cache-db.ts`. Databento charges per byte fetched — never delete valid cache entries. Use `--refresh-quote-cache` only when you know cached data is stale.
