---
paths: src/pipeline/**, src/orders/**
---

# Pipeline & Order Execution

## Shared Code — Backtest AND Live

These files execute identically in both backtest and live. **Never** add path-specific branching (`if (isBacktest)`) here. Differences belong in `BrokerService` implementations or the caller that builds `ResolvedPipelineDeps`.

- `execute-resolved.ts` — Main executor. Takes `ResolvedSignal[]`, places orders via `BrokerService` abstraction.
- `process-task.ts` — Bridge: task queue -> `resolveOrchestrator()` -> `executeResolvedSignals()`.
- `spread-midpoint.ts` — Computes net bid/ask for multi-leg orders. Broker-agnostic.

## NEVER USE MARKET ORDERS ON OPTIONS

`buildOrderParams()` falls back to `orderType: 'MARKET'` when `limitPrice` is falsy. This is catastrophic for options (bid-ask spreads of $1-3+). Every code path must ensure `limitPrice` is set:

- OPEN: `getSpreadMidpoint()` computes midpoint. If `signal.limitPrice` is set, use `Math.min(abs(signal.limitPrice), mid)`.
- CLOSE/TRIM/LEG_OFF: Always compute `mid` from `getSpreadMidpoint()`.
- If `getSpreadMidpoint()` can throw, the caller **must** handle the error — never let it silently produce `undefined` limitPrice.

## Order Defaults

Two sets: `ORDER_DEFAULTS` (opening) and `CLOSE_ORDER_DEFAULTS` (position-reducing).

Position-reducing orders:
- No `cancelAfterSec` — persist until filled or day boundary
- Wider step amounts (e.g., $0.15 vs $0.10 for options)
- `maxSteps` cap prevents infinite chasing

**Do not add `cancelAfterSec` to CLOSE/TRIM/LEG_OFF orders.** They must persist.

## ResolvedPipelineDeps Interface

```
broker, orderManager?, calculatePositionSize, checkRiskLimits, recordTrade, onPending?
```

Both paths provide identical function shapes. The implementations differ:
- Broker: `SimBroker` (backtest) vs `liveService` (live)
- Positions: scoped by `backtestRunId` vs `notBacktest` filter
- Risk: optionally disabled in backtest, always enforced in live
- recordTrade: wraps shared `recordTrade()` with `{backtestRunId, isBacktest}` or `{taskId, isBacktest: false}`

When adding a new dep, add it to **both** `src/backtest/runner.ts` AND `src/tasks/runner.ts`.

## Direction Reversal on Close

Position-reducing orders must reverse direction: `LONG -> SHORT`, `SHORT -> LONG`. This is already handled in `execute-resolved.ts`. If copying or refactoring this logic, always preserve the reversal.
