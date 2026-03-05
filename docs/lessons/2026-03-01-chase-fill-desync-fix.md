# Lesson: Chase/Fill Desync Fix

## Problem

The backtest runner called `broker.advanceTo(time)` then `orderManager.tick(time)` sequentially. `advanceTo` replays all market ticks against the *current* limit price, then `tick` batch-applies *all* pending chase adjustments at once. This means chase price improvements never interleave with tick evaluation -- the limit stays stale during tick replay, and by the time chase runs, all ticks are consumed.

Concrete case: NFLX 250912P01182500 had active bids ($0.82-$0.92) while the SELL limit was $1.11. Two chase steps would have lowered the limit to $0.81, crossing the $0.90 bid for a fill. Instead, `advanceTo` evaluated all ticks at the stale $1.11 (no fills), then `tick` batch-dropped the limit to $-1.89 with no ticks left. Affected ~9% of backtest trades.

## Decision

Added `advanceWithChaseInterleaving()` helper that sub-steps through time at the minimum chase interval across all active orders. Each sub-step:

1. `broker.advanceTo(subStepTime)` -- evaluate ticks at current limit
2. `orderManager.tick(subStepTime)` -- apply 1 chase step, update limit

This ensures each chase adjustment gets evaluated against the next batch of ticks before the next adjustment fires.

Also added `Math.max(0.01, newPrice)` price floor in order-manager as a safety net against negative prices.

Fast path: when no chase orders exist, falls through to the original single `advanceTo` + `tick` -- zero overhead.

## Key Files

- `src/backtest/runner.ts:627-682` -- `advanceWithChaseInterleaving()` helper
- `src/backtest/runner.ts:277` -- day-boundary call site (was `advanceTo` + `tick`)
- `src/backtest/runner.ts:347` -- per-message call site (was `advanceTo` + `tick`)
- `src/orders/order-manager.ts:157` -- `Math.max(0.01, newPrice)` price floor

## Watch Out

- The `from` param in `advanceWithChaseInterleaving` only controls the loop stepping start time. SimBroker tracks its own `lastAdvanceTime` internally, so duplicate tick replay cannot happen even if `from` is imprecise.
- When multiple orders have different chase intervals, `minIntervalMs` drives the sub-step granularity. Each rule's own `sinceLastAdj < rule.intervalSec` guard inside `OrderManager.tick()` prevents premature adjustment for rules with longer intervals.
- Early exit: if all chase orders fill or cancel mid-loop, the helper advances the remaining time in one shot and breaks.
- Line 301 standalone `orderManager.tick(clock.now())` after the day-boundary cancel loop must NOT be replaced -- it processes cancellation callbacks, not chase interleaving.
