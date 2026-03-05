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

## buildPipelineDeps() Factory (`build-deps.ts`)

Single construction site for all pipeline dependencies. Runners provide 3 primitives:
- `broker: BrokerService` — implementation (live or sim)
- `env: Environment` — clock, scope (channelId string e.g. `'live:U123'`, `'bt:<runId>'`), optional alerting
- `config: PipelineConfig` — risk config, agent identity, sizing

**When adding a new dep**, add it to `buildPipelineDeps()` in `build-deps.ts`. Do NOT add it to individual runners — the factory is the only place pipeline deps are constructed.

Parity invariants (enforced by the factory):
- `calculatePositionSize` ALWAYS forwards `input.spreadMaxRisk` to the sizer
- `recordTrade` ALWAYS includes `agentModel` in metadata and `channelId` from scope
- `getOpenPositions` derived from `env.scope` via `forChannel(scope)` (same DB query, different scope filter)
- `riskDeps` derived from `env.scope` + `env.clock` + `broker`
- `RiskCheckDeps` has NO optional fields — factory provides all deps

## Direction on Close — No Reversal

`deriveDirection(legs)` returns the ORDER direction from the signal legs' sides: SELL legs → SHORT (selling), BUY legs → LONG (buying back). For position-reducing orders, the signal legs already carry the correct closing side (e.g., SELL to close a LONG). Do NOT reverse the direction — `deriveDirection` already returns what `isBuyOrder` needs for fill logic.
