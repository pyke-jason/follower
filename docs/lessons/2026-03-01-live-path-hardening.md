# 2026-03-01 — Live Path Hardening

## Problem

The live runner had 8 issues identified in `docs/plans/live-path-hardening.md`:

1. **Orphan fill detection** — Fills/cancels for orders with no pending intent were silently ignored. No DB record, no alert.
2. **Risk check blind spots** — Working orders in OrderManager weren't counted toward position limits. Could over-allocate.
3. **Broker circuit breaker** — No health gating. If broker went down, tasks would claim and fail in a tight loop, flooding alerts.
4. **messageId! assertion** — `task.messageId!` non-null assertion in live runner. Should be explicit guard.
5. **spreadMaxRisk parity** — Live runner's `calculatePositionSize` didn't forward `input.spreadMaxRisk` to the sizer. Backtest did.
6. **TaskContext validation** — Hand-written type with `[key: string]: unknown` index signature. No runtime validation.
7. **Dead startTask() export** — Unused function in `src/live/recorder.ts`.
8. **agentModel parity** — Live runner's `recordTrade` didn't include `agentModel` in metadata. Backtest did.

## Decision

Implemented all 8 issues across 7 phases with dependency ordering. Key architectural choices:

- **BrokerTransientError** — New error class in `src/lib/errors.ts`. Broker implementations throw it for recoverable failures. Live runner catches it to requeue tasks instead of failing them permanently.
- **Circuit breaker in runner** — Exponential backoff (10s base, 5min cap), 3-failure threshold. Probes `isHealthy()` before resuming. Tiered alerting at 3/10/30 failures.
- **All callbacks required** — `onFill`, `onCancel`, `onAdjust` on OrderManager; `onOrphanFill`, `onOrphanCancel` on CallbackDeps; `orderManager` + `onPending` on ResolvedPipelineDeps. No optional fields, no fallback branches.
- **orphan_fills table** — Persistent record of fills with no matching pending intent. Live path sends critical alert + DB insert. Backtest path logs + DB insert (no alerts).
- **Working order exposure** — `OrderManager.getExposure()` returns count-by-symbol + total notional. Risk check merges with DB positions for effective limits.
- **TaskContextSchema** — Zod schema with `.passthrough()` replaces hand-written type. Validated at `processTask()` entry point.
- **build-deps.ts** — Shared factory types (`RunnerInfra`, `TradeScope`) documenting the live/backtest parity contract.

## Key Files

| File | Change |
|---|---|
| `src/lib/errors.ts` | Added `BrokerTransientError` |
| `src/broker/interface.ts` | Added `isHealthy()` to `BrokerService` |
| `src/broker/tradestation/client.ts` | Implemented `isHealthy` via `getAccountBalance()` |
| `src/broker/ibkr/client.ts` | Implemented `isHealthy` via `GET /api/status` |
| `src/backtest/sim-broker.ts` | `isHealthy` always true |
| `src/live/runner.ts` | Circuit breaker, BrokerTransientError requeue, orphan handlers, parity fixes |
| `src/backtest/runner.ts` | Orphan handlers, getWorkingOrderExposure, getReconciliationAlertCount |
| `src/orders/order-manager.ts` | Required callbacks, `getExposure()`, `WorkingOrderExposure` type |
| `src/orders/build-order-callbacks.ts` | `onOrphanFill` + `onOrphanCancel` required in `CallbackDeps` |
| `src/orders/risk-check.ts` | All deps required, working order exposure merged into checks |
| `src/pipeline/execute-resolved.ts` | `orderManager` + `onPending` required, removed fallback branch |
| `src/pipeline/process-task.ts` | `TaskContextSchema.parse()` at entry |
| `src/pipeline/build-deps.ts` | NEW — `RunnerInfra`, `TradeScope` shared types |
| `src/db/schema.ts` | `TaskContextSchema` Zod, `orphan_fills` table |
| `src/live/recorder.ts` | Removed dead `startTask()` |
| `.claude/rules/pipeline-execution.md` | Updated parity invariants |

## Watch Out

- **Pre-existing scorer.ts errors** — 3 TS errors in `src/intents/evals/scorer.ts` (`StockLeg` missing `expiry`/`strike`). Not caused by this work.
- **drizzle-kit push** — Failed due to CJS/ESM issues. Used `sqlite3` CLI to create `orphan_fills` table directly. Next `drizzle-kit push` on a clean env should pick it up from the schema.
- **Sidecar not tested live** — `isHealthy()` for IBKR hits `GET /api/status` on the sidecar. Verified the code path compiles and the schema parses, but didn't spin up IB Gateway for an end-to-end test.
- **Circuit breaker alerts** — Uses `sendSystemAlert` which goes to Pushover. The tiered escalation (3/10/30) means up to 3 alerts before circuit opens. In a real outage, expect ~1 warning + periodic probes.
- **Risk check working orders** — `getExposure()` only counts orders with status `OPEN`. Pending/queued orders are not counted until the broker confirms them open.
