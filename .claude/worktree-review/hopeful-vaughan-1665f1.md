# Worktree review — hopeful-vaughan-1665f1 (server-side stops)

## Goal

Place GTC stop orders at IBKR immediately after every OPEN fill so a process crash, kill -9, or Mac sleep cannot leave a position unprotected. Stops live at the broker independently of the bot. On startup, reconcile stops for any open trade lacking one.

## Changes

- `src/broker/types.ts`: new `StopOrderParams` type (symbol, strategy, legs, action, qty, stopPrice, optional limitPrice).
- `src/broker/interface.ts`: `placeStopOrder()` added to `BrokerService`.
- `src/broker/ibkr/client.ts`: `placeStopOrder` impl — STP for stocks, STP LMT for options, GTC, posted via existing sidecar `/orders/single` with new `auxPrice` field.
- `src/backtest/sim-broker.ts`: stub returning `{ orderId: 'sim-no-stop', status: 'OPEN' }` (backtests are signal-driven).
- `src/classify/stub-broker.ts`, `src/local-api/routes/web-orders.test.ts`, `src/backtest/checkpoint-serialization.test.ts`: interface-conformance stubs.
- `sidecar/.../RequestBodies.java`, `OrderRoutes.java`: `auxPrice` field added to `PlaceSingleBody`, applied via `order.auxPrice()`, included in audit log.
- `src/db/schema.ts`: `TradeMetadata.stopOrderId?: string` (JSONB-only, no DDL).
- `src/config/stop-defaults.ts` (new): `STOP_DEFAULTS` constants and `computeStopParams(strategy, direction, entryPrice, legs, qty)`.
- `src/trades/stop-orders.ts` (new): `placeTradeStop`, `cancelTradeStop`, `cancelAndReplaceStop` lifecycle helpers.
- `src/reconciliation/stop-reconciler.ts` (new): `reconcileStops(broker, channelId)` — iterates open trades for a channel, verifies each stop alive at IBKR, places fresh ones where missing/dead, alerts on failures.
- `src/reconciliation/index.ts`: re-exports `reconcileStops`.
- `src/index.ts`: calls `reconcileStops` once per channel before ingestion starts.
- `src/pipeline/execute-resolved.ts`: wraps `recordFill` on both OPEN and REDUCE pending contexts to place / cancel / cancel-and-replace stops.
- `docs/lessons/2026-04-24-server-side-stops.md`: lesson file.

## Justification per change

| Change | Necessary | Notes |
|---|---|---|
| `StopOrderParams` + `placeStopOrder` on `BrokerService` | YES | Correct upstream point. Live IBKR vs sim diverge here, not in pipeline. |
| IBKR client `placeStopOrder` with STP / STP LMT | YES | Real broker work — cannot live anywhere else. |
| Sidecar `auxPrice` plumbing | YES | TWS API requires `auxPrice` for stop trigger; sidecar previously only carried `lmtPrice`. |
| `SimBroker.placeStopOrder` no-op | YES | Backtest exits on signal events; satisfies interface, does no work. |
| `TradeMetadata.stopOrderId` | YES | Need to remember broker-assigned ID to cancel later. JSONB-only is correct. |
| `stop-defaults.ts` (`computeStopParams`) | YES | Encapsulates stop-pricing policy. Editorial decision the operator should own. |
| `stop-orders.ts` lifecycle helpers | YES | Three callers (executor OPEN, executor TRIM/CLOSE, reconciler) need the same DB+broker dance. Right shape. |
| `stop-reconciler.ts` | YES | The whole point: post-crash protection. Without this the feature is useless. |
| Pipeline wrapping `recordFill` to place/cancel stops | MOSTLY | Approach is sound, but the OPEN path also runs for `ADD` — see Concerns. |

## Concerns

### 1. ADD action leaks stops at IBKR (CORRECTNESS BUG)

The `!isPositionReducing` branch in `execute-resolved.ts` covers both `OPEN` and `ADD` (line 537: `action: signalAction === 'ADD' ? 'ADD' : 'OPEN'`). On ADD, the wrapped `recordFill` calls `placeTradeStop` which overwrites `metadata.stopOrderId` with a new IBKR order ID **without cancelling the prior stop**. The original stop survives at IBKR with the original quantity but is no longer tracked by the DB.

Consequences:
- The orphaned earlier stop persists indefinitely until it triggers or expires.
- Cancellation on later CLOSE/TRIM only cancels the *latest* `stopOrderId`.
- The startup reconciler does not detect this because the trade *has* a `stopOrderId` and the broker reports it `OPEN`.

Additionally, the ADD's stop is computed with `fill.filledPrice` (just the add fill) and `size.quantity` (just the add quantity), not the position's average entry or total quantity. The new stop is priced for the wrong cost basis at the wrong size.

### 2. No tests for the stop logic itself

`stop-orders.ts`, `stop-reconciler.ts`, `stop-defaults.ts` ship with zero unit tests. Existing tests are interface-conformance stubs returning `{ orderId: 'NO-STOP' }`. Nothing verifies:

- `computeStopParams` produces the documented prices for STOCK LONG/SHORT, OPTION LONG/SHORT, and refuses spreads.
- `placeTradeStop` writes `stopOrderId` to metadata after a successful broker call.
- `cancelTradeStop` is no-op when `stopOrderId` is absent and clears it on success.
- `cancelAndReplaceStop` uses the *current* DB quantity post-TRIM.
- `reconcileStops` re-places when the broker order is gone vs. skips when alive.

This is exactly the "real, not theatre" rubric line. Without these tests, every refactor downstream is Russian roulette.

### 3. Fire-and-forget stop placement (race window)

The OPEN path detaches stop placement: `placeTradeStop(...).catch(err => alert)`. The `recordFill` callback returns before the stop POST completes. If the bot crashes in this window, the trade exists in the DB without `stopOrderId` and the reconciler will catch it on next boot — but only if the bot restarts. A long crash with a moving market is exactly the failure this feature is supposed to prevent.

A safer pattern: await the stop placement inline in `recordFill`, with retry. Three retries of a 15 s POST is at most 45 s of delay vs. an unbounded unprotected window.

### 4. `cancelAndReplaceStop` reads its own write via lazy Postgres read

After TRIM `recordFill` commits, `cancelAndReplaceStop` re-reads the trade row in a separate query. This is correct **only if** `recordFill` has fully committed before this fires. The wrapper does `await reduceRecordFill(fill)` then schedules the cancel-replace via `.catch(...)` (fire-and-forget). The await ensures order. Acceptable, but the invariant is implicit — a comment would prevent later refactors from breaking it.

### 5. Stop defaults are silent policy

`STOCK_LOSS_PCT: 0.05`, `OPTION_LONG_LOSS_PCT: 0.50`, `OPTION_SHORT_GAIN_MULT: 3.0`, `STP_LMT_BUFFER_PCT: 0.10` are hard-coded. For single-user pre-live this is fine, but worth noting: a 5 % stock stop is inside normal noise for high-vol tickers; an option going to zero (long ITM expiry day) will fire a 50 % stop early. Policy decision worth a follow-up conversation.

### 6. Spreads silently skipped — recurring reminder missing

`reconcileStops` `sendSystemAlert(severity: 'critical')` only for failed *placements*, not for skipped spreads. Open spread positions therefore have no protection and no recurring reminder. The lesson admits this is "v2 backlog" — fine, but a single warn-level alert listing unprotected spreads on each reconciliation pass would prevent quietly forgetting.

### 7. Sidecar must be rebuilt and redeployed

Java change: `PlaceSingleBody` has a new field. The new TS client cannot work against an old sidecar — Jackson tolerates the field absent, but `OrderRoutes` only sets `order.auxPrice()` if it is present, and old sidecar JARs do not parse it. Pin "rebuild sidecar before deploying TS bits" in the merge checklist.

### 8. Quality gates

- `npx tsc --noEmit`: PASS.
- `npm test`: PASS (565 tests).
- `npx knip`: errored on missing `@vitejs/plugin-react` in this worktree's `web/` — not introduced by this change (node_modules likely not installed in worktree). Re-run in main after merge.

## Verdict

REWORK.

The architecture is right — stop placement upstream in `BrokerService`, lifecycle helpers in `src/trades/`, reconciler at startup, no `if (isBacktest)` branching, a sim-broker stub that won't fire spuriously. This is how the rails want broker capabilities added, and the lesson author understood the problem.

But the ADD-path stop-leak (concern #1) is a real correctness bug for a feature whose entire purpose is correctness under failure. Combined with zero unit tests on the policy logic (concern #2) and a race window between fill and stop placement (concern #3), this is not safe to merge for go-live as-is. The fixes are small and localised.

## Required fixes (blocking)

1. **ADD path must cancel the prior stop before placing a new one, sized to the *total* post-ADD quantity at the blended entry price.** Either route ADD through `cancelAndReplaceStop` (which reads the trade post-write to get the new quantity and post-blend entryPrice), or branch the OPEN-path wrapper on `signalAction === 'ADD'` and call cancel-then-place explicitly. Add a test covering the OPEN→ADD→CLOSE sequence to verify exactly one IBKR stop exists at any point.

2. **Add unit tests for `computeStopParams`, `placeTradeStop`, `cancelTradeStop`, `cancelAndReplaceStop`, and `reconcileStops`.** Use a fake `BrokerService` that records calls so the tests assert (a) the right `StopOrderParams` reach the broker, (b) `metadata.stopOrderId` is written on placement and cleared on cancel, (c) the reconciler skips alive stops and re-places dead ones.

3. **Await stop placement inline on the OPEN/ADD path** (with the existing 2-retry / 15 s timeout in `placeStopOrder`). Keep the alert on terminal failure, but do not return from `recordFill` while the position is still unprotected.

## Required fixes (non-blocking, do at the same time)

4. Comment in `cancelAndReplaceStop` documenting that it must be called *after* the TRIM `recordTrade` transaction has committed.
5. `reconcileStops` should emit one warn-level alert per pass listing open spread trades by id/symbol — they have no protection and the operator should know, even if the long-term fix is v2.
6. Add a one-line operator note to the lesson file: "Rebuild and redeploy the sidecar (`./gradlew :sidecar:bootJar`) before deploying the TypeScript bits — old sidecars silently drop `auxPrice`."

## Reviewer verdict

Agree with REWORK. Falsification attempts below; all major concerns hold.

**Architecture check (rails compliance).** No `if (isBacktest)` branches in `src/pipeline/` or `src/orders/`. `placeStopOrder` lives on `BrokerService` (interface.ts:14-18), implemented by `createIbkrService` (ibkr/client.ts:557), `SimBroker` (sim-broker.ts:1020-1023), and `STUB_BROKER` (stub-broker.ts:33). The pipeline wrapper in `execute-resolved.ts:552-570` dispatches through `deps.broker` with no mode check. Rails-correct.

**Sim-broker "respects stops" check.** Thesis claim ("signal-driven exits, so stub is fine") holds. `SimBroker.placeStopOrder` returns `{orderId: 'sim-no-stop', status: 'OPEN'}` and never evaluates; backtests exit on ingested signals. Confirmed no backtest caller invokes `reconcileStops` (only `src/index.ts` does). Minor cruft: every backtest trade stamps `metadata.stopOrderId = 'sim-no-stop'` and later clears it on close/trim. Not a correctness bug, but pollutes `trade_events` and blurs the broker-capability boundary — a cleaner design would make sim-broker's `placeStopOrder` throw (so `placeTradeStop` could guard on a `supportsStops` flag, or the pipeline could opt out via `deps.placeStop`). Non-blocking.

**Test verification.** Grep confirms zero tests invoke `placeTradeStop`, `cancelTradeStop`, `cancelAndReplaceStop`, `computeStopParams`, or `reconcileStops`. The two modified tests (`web-orders.test.ts`, `checkpoint-serialization.test.ts`) are interface-conformance stubs only. For a feature whose failure mode is "unbounded loss on process crash", this is disqualifying on its own.

**ADD-path leak (concern #1) confirmed.** `isPositionReducing = signalAction === 'CLOSE' || 'TRIM' || 'LEG_OFF'` (line 478). ADD falls into the `!isPositionReducing` branch, which always calls `placeTradeStop` with `fill.filledPrice` and `size.quantity` (the ADD's qty, not blended post-ADD quantity). `placeTradeStop` overwrites `metadata.stopOrderId` without cancelling the prior one. Prior stop survives at IBKR at original size, invisibly. Startup reconciler cannot detect this (trade has a `stopOrderId`, IBKR reports it OPEN). Real correctness bug.

**Fire-and-forget (concern #3) confirmed.** Line 560 uses `.catch(...)` without `await`. `recordFill` returns before the stop POST completes. Thesis is right that awaiting with retry bounds the unprotected window.

**Additional finding.** `cancelTradeStop` on CLOSE fires with `signal.tradeId ?? recorded.tradeId`. On a CLOSE signal, `signal.tradeId` must point to the open trade being closed; if the orchestrator ever resolves CLOSE with `signal.tradeId = undefined` (fallback to `recorded.tradeId`), `recorded.tradeId` is the newly-created CLOSE event row's trade id, not the originally-opened trade. Needs a quick confirmation in `resolveOrchestrator` that CLOSE always emits `signal.tradeId`.

**Verdict: REWORK.** Blocking fixes 1-3 from the thesis are necessary and sufficient. Architecture is sound; safety-critical glue is not.

## Reviewer verdict

REWORK (independent review).

**Agreements with thesis.**
- Rails compliance verified: `placeStopOrder` is added to `BrokerService` (`src/broker/interface.ts:17`), implemented by `createIbkrService` (`src/broker/ibkr/client.ts:557`), `SimBroker.placeStopOrder` (`src/backtest/sim-broker.ts:1020`), and `STUB_BROKER` (`src/classify/stub-broker.ts`). The pipeline wrapper in `src/pipeline/execute-resolved.ts:557-567` and `:629-639` dispatches via `deps.broker` with no `if (isBacktest)` branch. Architecturally the right shape.
- ADD-path stop leak (concern #1) confirmed. `isPositionReducing` (line 478) is `CLOSE | TRIM | LEG_OFF`; ADD falls through into the OPEN branch which always calls `placeTradeStop` and overwrites `metadata.stopOrderId` without cancelling the prior IBKR order. The new stop is also priced from `fill.filledPrice` of the ADD only and sized at `size.quantity` (just the add), not blended-entry × total post-ADD qty. Real correctness bug.
- Fire-and-forget (concern #3) confirmed: `placeTradeStop(...).catch(...)` (line 560) returns from `recordFill` before the broker POST completes. Identical pattern on TRIM/CLOSE (lines 631, 636). For a feature whose entire point is crash protection, this race is exactly the failure mode it must prevent.
- Test gap (concern #2) confirmed: zero tests under `src/**/*.test.ts` exercise `placeTradeStop`, `cancelTradeStop`, `cancelAndReplaceStop`, `computeStopParams`, or `reconcileStops`. The two modified tests are interface-conformance stubs returning `{ orderId: 'NO-STOP' }`. Disqualifying for go-live safety code.

**Disagreements / refinements.**
- Sim-broker stub returning `{orderId: 'sim-no-stop', status: 'OPEN'}` is correct for backtest semantics (signal-driven exits), but it leaks a fake `stopOrderId='sim-no-stop'` into every backtest trade's `metadata`. Not a correctness bug since backtests don't run `reconcileStops`, but it pollutes `trade_events` JSON. Minor — non-blocking.
- The thesis's concern #4 (cancelAndReplaceStop reads-its-own-write) is fine in practice: line 625 `await reduceRecordFill(fill)` completes the TRIM commit before the `.catch()` schedules the cancel-and-replace, and `cancelAndReplaceStop` re-reads the trade. A comment would help future-proof against re-ordering, but no live bug today.

**Missed by thesis.**
- `cancelTradeStop` on the REDUCE path uses `signal.tradeId ?? recorded.tradeId` (line 628). If `signal.tradeId` is ever undefined on a CLOSE/TRIM (e.g. a fallback path in the orchestrator), `recorded.tradeId` is the freshly-created CLOSE event's parent trade id, which may or may not coincide with the original OPEN trade. Worth confirming the orchestrator always resolves `signal.tradeId` for CLOSE/TRIM/LEG_OFF before relying on this.
- The startup `reconcileStops` skips spreads silently (only logs `info`). Open spread positions therefore have zero protection AND no recurring operator visibility. A warn-level alert per pass listing unprotected spreads would close the gap until v2.
- `STOP_DEFAULTS.STOCK_LOSS_PCT = 0.05` is well inside normal noise for high-vol tickers; `OPTION_LONG_LOSS_PCT = 0.50` will trigger early on long ITM expiry-day options whose premium decays past the threshold. Policy decisions worth one operator conversation before go-live.

**Verdict reasoning.** Architecture is correct: capability lives on `BrokerService`, lifecycle helpers in `src/trades/`, reconciler at startup, no mode branching in pipeline. But the ADD-path leak silently orphans stops at IBKR and the fire-and-forget pattern leaves an unprotected window — both defeat the feature's stated purpose under exactly the failure modes it exists to handle. Combined with zero unit tests on the safety-critical glue, not safe to merge for go-live. Fixes are localized; rework is small and well-scoped.
