---
paths: src/pipeline/**, src/orders/**
---

# Pipeline & Order Execution

## Shared Code -- Backtest AND Live

These files execute identically in both backtest and live. **Never** add path-specific branching (`if (isBacktest)`) here. Differences belong in `BrokerService` implementations or the caller that builds `ResolvedPipelineDeps`.

- `execute-resolved.ts` -- Main executor. Takes `ResolvedSignal[]`, places orders via `BrokerService` abstraction.
- `process-task.ts` -- Bridge: task queue -> `resolveOrchestrator()` -> `executeResolvedSignals()`.
- `leg-pricing.ts` -- Pricing primitives: `getMidpoint()` and `getQuoteMark(broker, legs, fraction)` (always positive), `isCreditOrder()` (structural first, quote fallback), `isCreditOrderStructural()` (pure structural, sync, no quotes).
- `build-deps.ts` -- Factory that constructs `ResolvedPipelineDeps` from 3 runner-provided primitives.
- `task-lifecycle.ts` -- Task state transitions: `completeTask`, `failTask`, `expireTask`, `handleTaskError`. `handleTaskError` marks FAILED then **re-throws** so the caller (drain loop / circuit breaker) can track failures.

## Limit Prices -- Always Positive

`limitPrice` is ALWAYS a positive number. Credit vs debit is determined by leg structure (`isCreditOrder`), never by price sign. The `zPrice` schema enforces `> 0`.

- OPEN credit: `Math.max(sigPrice, mid)` -- maximize what you receive.
- OPEN debit/stock: `Math.min(sigPrice, getQuoteMark(broker, legs, 0.75))` -- minimize what you pay, compared against the 75% mark (not midpoint) to avoid paying full ask.
- CLOSE/TRIM/LEG_OFF: `getMidpoint()` directly (already positive).
- If `getMidpoint()` can throw, the caller **must** handle the error -- never let it silently produce `undefined` limitPrice.

## Credit/Debit Determination

Two code paths exist and choosing the wrong one can flip order direction:

- **OPEN path** uses `isCreditOrder()` -- tries structural first (deterministic, sync, free), falls back to live quotes when structural returns null. Quotes are needed for calendars, ratios, iron condors, and other non-vertical structures.
- **CLOSE path** uses `isCreditOrderStructural() ?? false` -- structural only, defaults to debit (false) if indeterminate. This avoids a quote fetch on close.

Do not mix these up. The close path intentionally skips quotes because close pricing uses midpoint directly and the credit/debit flag only affects chase direction.

## Chase Profiles

Order chase behavior is controlled by `CHASE_PROFILES` in `execute-resolved.ts` -- named profiles (one per strategy + action combination) selected by `selectChaseProfile(strategy, isPositionReducing, isBuy)`. Each profile defines step sizing, slippage bounds, and optional `cancelAfterSec`. The actual step amount and chase limit are computed by `resolveChaseParams(profile, signalPrice, isBuy)`.

Key invariants:
- Opening profiles have `cancelAfterSec` set -- orders cancel if not filled within the timeout window
- Closing profiles (triggered when `isPositionReducing=true`) have **no** `cancelAfterSec` -- they persist until filled or day boundary. Reason: a cancelled close leaves an unhedged position with no automated exit, which is worse than any slippage.
- `maxSteps` is derived from `chaseRange / stepAmount`, preventing infinite chasing

**Do not add `cancelAfterSec` to position-reducing (CLOSE/TRIM/LEG_OFF) profiles.** They must persist.

## ResolvedPipelineDeps Interface

Defined in `execute-resolved.ts`. All fields are REQUIRED (no `?`):
- Core order execution: `broker`, `orderManager` -- never optional, orders always go through OrderManager with pending intent tracking
- Position sizing: `calculatePositionSize`
- Risk checks: `checkRiskLimits`, `recordTrade`
- Pending intent callback: `onPending` -- never optional

When adding a new field, ensure it has no `?` marker and is wired through the factory.

## buildPipelineDeps() Factory (`build-deps.ts`)

Single construction site for all pipeline dependencies. Runners provide 3 primitives:
- `broker: BrokerService` -- implementation (live or sim)
- `env: Environment` -- clock, scope (channelId string, e.g. `'ibkr:live:U14368257'`, `'bt:<runId>'`), optional alerting
- `config: PipelineConfig` -- risk config, agent identity, sizing

Channel ID format is `<broker>:<mode>:<accountId>` for live/paper or `bt:<runId>` for backtests. See `src/lib/channel.ts` for constructors.

**When adding a new dep**, add it to `buildPipelineDeps()` in `build-deps.ts`. Do NOT add it to individual runners -- the factory is the only place pipeline deps are constructed.

Parity invariants (enforced by the factory):
- `calculatePositionSize` receives `legs: Leg[]` -- the sizer owns all risk calculation including credit spread risk (PCS/CCS: `strikeWidth - premium`)
- `recordTrade` ALWAYS includes `agentModel` in metadata and `channelId` from scope
- `getOpenPositions` derived from `env.scope` via `forChannel(scope)` (same DB query, different scope filter)
- `riskDeps` derived from `env.scope` + `env.clock` + `broker`
- `RiskCheckDeps` has NO optional fields -- factory provides all deps

## deriveDirection -- No Manual Reversal

`deriveDirection(legs)` returns the ORDER direction used by `isBuyOrder` in the broker's fill logic. It has three cases:

1. **Single leg:** `BUY` -> `LONG`, `SELL` -> `SHORT`.
2. **Unequal leg counts:** more BUY legs -> `LONG`, more SELL legs -> `SHORT`.
3. **Equal-count spreads (e.g., verticals):** uses strike comparison to determine debit/credit structure. For CALLs, buying the lower strike = debit = `LONG`. For PUTs, buying the higher strike = debit = `LONG`.

For position-reducing orders, the signal legs already carry the correct closing side (e.g., SELL to close a LONG). Do NOT reverse the direction after `deriveDirection` -- it already produces what `isBuyOrder(params)` needs (`direction === 'LONG'` -> buy fill, `direction === 'SHORT'` -> sell fill).
