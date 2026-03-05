---
paths: src/pipeline/**, src/orders/**
---

# Pipeline & Order Execution

## Shared Code — Backtest AND Live

These files execute identically in both backtest and live. **Never** add path-specific branching (`if (isBacktest)`) here. Differences belong in `BrokerService` implementations or the caller that builds `ResolvedPipelineDeps`.

- `execute-resolved.ts` — Main executor. Takes `ResolvedSignal[]`, places orders via `BrokerService` abstraction.
- `process-task.ts` — Bridge: task queue -> `resolveOrchestrator()` -> `executeResolvedSignals()`.
- `leg-pricing.ts` — Canonical leg-level pricing: `getMidpoint()` (always positive) + `isCreditOrder()` (from leg structure, no quotes).

## Limit Prices — Always Positive

`limitPrice` is ALWAYS a positive number. Credit vs debit is determined by leg structure (`isCreditOrder`), never by price sign. The `zPrice` schema enforces `> 0`.

- OPEN debit: `Math.min(signalPrice, mid)` — minimize what you pay.
- OPEN credit: `Math.max(signalPrice, mid)` — maximize what you receive.
- CLOSE/TRIM/LEG_OFF: `getMidpoint()` directly (already positive).
- If `getMidpoint()` can throw, the caller **must** handle the error — never let it silently produce `undefined` limitPrice.

## Chase Profiles

Order chase behavior is controlled by `CHASE_PROFILES` in `execute-resolved.ts` — named profiles (one per strategy + action combination) selected by `selectChaseProfile(strategy, isPositionReducing, isBuy)`. Each profile defines step sizing, slippage bounds, and optional `cancelAfterSec`. The actual step amount and chase limit are computed by `resolveChaseParams(profile, signalPrice, isBuy)`.

Key invariants:
- Opening profiles have `cancelAfterSec` set — orders cancel if not filled within the timeout window
- Closing profiles (triggered when `isPositionReducing=true`) have **no** `cancelAfterSec` — they persist until filled or day boundary
- `maxSteps` is derived from `chaseRange / stepAmount`, preventing infinite chasing

**Do not add `cancelAfterSec` to position-reducing (CLOSE/TRIM/LEG_OFF) profiles.** They must persist.

## ResolvedPipelineDeps Interface

Defined in `execute-resolved.ts`. All fields are REQUIRED (no `?`):
- Core order execution: `broker`, `orderManager` — never optional, orders always go through OrderManager with pending intent tracking
- Position sizing: `calculatePositionSize`
- Risk checks: `checkRiskLimits`, `recordTrade`
- Pending intent callback: `onPending` — never optional

When adding a new field, ensure it has no `?` marker and is wired through the factory.

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
