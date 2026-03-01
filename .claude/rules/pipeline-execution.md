---
paths: src/pipeline/**, src/orders/**
---

# Pipeline & Order Execution

## Shared Code — Backtest AND Live

These files execute identically in both backtest and live. **Never** add path-specific branching (`if (isBacktest)`) here. Differences belong in `BrokerService` implementations or the caller that builds `ResolvedPipelineDeps`.

- `execute-resolved.ts` — Main executor. Takes `ResolvedSignal[]`, places orders via `BrokerService` abstraction.
- `process-task.ts` — Bridge: task queue -> `resolveOrchestrator()` -> `executeResolvedSignals()`.
- `spread-midpoint.ts` — Computes net bid/ask for multi-leg orders. Broker-agnostic.

## Limit Price Sources per Action

Every code path must ensure `limitPrice` is set for non-stock orders (see CLAUDE.md NEVER MARKET ON OPTIONS):

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

When adding a new dep, add it to **both** `src/backtest/runner.ts` AND `src/live/runner.ts`.

## Direction Reversal on Close

Position-reducing orders must reverse direction: `LONG -> SHORT`, `SHORT -> LONG`. This is already handled in `execute-resolved.ts`. If copying or refactoring this logic, always preserve the reversal.
