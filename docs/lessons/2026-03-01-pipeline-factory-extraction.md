# Pipeline Factory Extraction: buildPipelineDeps()

Date: 2026-03-01

## Problem

Both runners (live + backtest) manually constructed ~80 lines of identical dependency wiring:
OrderManager, pendingIntents, riskDeps (6 fields), pipelineDeps (6 fields), sizingService,
buildOrderCallbacks. The only real differences were scope filters and clock source.

This caused parity drift bugs (e.g., `spreadMaxRisk` not forwarded in backtest,
`agentModel` missing from metadata). Every new dep required identical changes in 2 files.

Key insight: `getOpenPositions` was NOT a genuinely different data source — both runners
query the same `trades` DB table with different scope filters (`notBacktest` vs `forRun(runId)`).

## Decision

Created `buildPipelineDeps()` factory in `src/pipeline/build-deps.ts`. Takes 3 stable primitives:
- `broker: BrokerService` — implementation (live or sim)
- `env: Environment` — clock, scope (discriminated union), optional alerting
- `config: PipelineConfig` — risk config, agent identity, disableRiskLimits, startingEquity

Returns `PipelineBundle`: orderManager, pipelineDeps, pendingIntents, getOpenPositions, destroy.

The factory derives EVERYTHING internally:
- `getOpenPositions` from `env.scope` (same DB query, different scope filter)
- `riskDeps` from scope + clock + broker (getDailyClosedPnl, getStartingEquity, etc.)
- `OrderManager` with `buildOrderCallbacks` using scope-derived params
- `calculatePositionSize` with `spreadMaxRisk` + `MAX_CONTRACTS` always forwarded
- `recordTrade` with scope fields (taskId for live via lazy `getTaskId()`, backtestRunId for backtest)
- `checkRiskLimits` with bypass for `disableRiskLimits`

## Key Files

- `src/pipeline/build-deps.ts` — Factory: types + `buildPipelineDeps()` implementation
- `src/pipeline/build-deps.test.ts` — 11 unit tests (scope filtering, recordTrade, risk, sizing)
- `src/live/runner.ts` — Collapsed from ~270 to ~170 lines; no riskDeps/pipelineDeps construction
- `src/backtest/runner.ts` — ~80 lines of manual wiring replaced with ~10-line factory call
- `.claude/rules/pipeline-execution.md` — Updated: factory is the single construction site
- `.claude/rules/live-tasks.md` — Updated: documents _currentTaskId pattern

## Watch Out

- Live runner uses `_currentTaskId` mutable ref set before each task. The factory's
  `recordTrade` reads it lazily via `getTaskId()` closure. Do not move this to constructor time.
- `getDailyClosedPnl` uses `toDateKeyET(clock())` for backtest (simulated time) but
  `date('now')` for live (SQLite wall clock). Both use the shared scope filter.
- `getReconciliationAlertCount` returns 0 for backtest scope (table has no run scoping).
- `env.sendAlert` has wider severity type (`'critical' | 'warning' | 'info'`) than
  `CallbackDeps.sendAlert` (`'critical' | 'warning'`). Factory narrows via cast.
