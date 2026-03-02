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
broker, orderManager, calculatePositionSize, checkRiskLimits, recordTrade, onPending
```

ALL fields are REQUIRED (no `?`). `orderManager` and `onPending` are never optional — orders always go through OrderManager with pending intent tracking.

When adding a new dep, add it to **both** `src/backtest/runner.ts` AND `src/live/runner.ts`.

Parity invariants (enforced by code review):
- `calculatePositionSize` MUST forward `input.spreadMaxRisk` to the sizer
- `recordTrade` MUST include `agentModel` in metadata
- `buildOrderCallbacks` MUST provide `onOrphanFill` and `onOrphanCancel`
- `RiskCheckDeps` has NO optional fields — both paths provide all deps

## Direction on Close — No Reversal

`deriveDirection(legs)` returns the ORDER direction from the signal legs' sides: SELL legs → SHORT (selling), BUY legs → LONG (buying back). For position-reducing orders, the signal legs already carry the correct closing side (e.g., SELL to close a LONG). Do NOT reverse the direction — `deriveDirection` already returns what `isBuyOrder` needs for fill logic.
