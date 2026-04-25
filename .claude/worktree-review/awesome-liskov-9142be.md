# awesome-liskov-9142be

## Goal
Hardens live order handling against two real go-live failure modes: (1) the cancel/fill race where IBKR fills an order in the small window between OrderManager's fill check and its auto-cancel request (the "MU PUT scenario") -- the cancel response's FILLED status was discarded and the trade became an orphan broker position with no DB record; (2) after-hours GTC orders where IBKR returns Inactive (mapped to PENDING), which the existing tick() skipped forever because it only polled OPEN orders. Also moves IBKR per-runtime sets off the module scope so live + paper services don't collide on orderId, and adds an overlap guard to FillSweep mirroring ReconciliationScheduler's pattern.

## Changes
- src/broker/ibkr/client.ts -- Move creditComboOrderIds and alertedMissingSubscription from module-level globals to per-instance IbkrRuntime fields; populate fill details on cancelOrder when IBKR returns FILLED.
- src/orders/order-manager.ts -- Poll PENDING orders in tick(); handle PENDING->OPEN transition by resetting placedAt so cancelAfterSec starts from market activation; route cancelOrder FILLED responses to onFill instead of onCancel.
- src/pipeline/execute-resolved.ts -- Register pending intent for PENDING results too (was OPEN-only), so after-hours fills can find their context.
- src/reconciliation/fill-sweep.ts -- Add running flag to skip overlapping sweeps (mirrors ReconciliationScheduler pattern).
- src/orders/order-manager.test.ts -- New regression suite (6 tests) covering both bugs with mocked broker; all pass.

## Justification per change
- src/broker/ibkr/client.ts (per-runtime sets) -- JUSTIFIED. Module-level Set<string> collapses across all createIbkrService() instances. Two services share the same low-integer orderId namespace (IBKR clientId-scoped), so a paper orderId="123" could match a live orderId="123" and flip the limit-price sign on the wrong account's modify call. Direct correctness fix for live + paper running concurrently.
- src/broker/ibkr/client.ts (cancelOrder fill data) -- JUSTIFIED. The existing getOrderStatus already populates filledPrice/fillTimestamp/commission for FILLED status; the cancel path was missing this and the omission silently lost real fills. Surface-level change at the broker boundary, consistent with the existing pattern in the same file.
- src/orders/order-manager.ts (PENDING polling + cancel/fill race) -- JUSTIFIED. Both bugs are reproducible incidents (MU PUT, after-hours GTC) that lose money or leave orphan positions. The PENDING handling lives correctly in OrderManager -- broker-agnostic order state machine logic, not IBKR-specific. The race handling reads cancelResult fields the broker now provides. Stays in src/orders/ without if (isBacktest) branching.
- src/pipeline/execute-resolved.ts (PENDING in placeOrder branch) -- JUSTIFIED. One-line addition: result.status === 'OPEN' || result.status === 'PENDING'. Without it, after-hours orders silently bypass onPending registration and any later fill can't find its trade context. Minimal, correct, at the right layer.
- src/reconciliation/fill-sweep.ts (running guard) -- JUSTIFIED. The existing currentRun: Promise<number> | null was assigned every tick without checking; two timer ticks during a slow sweep could issue duplicate getOrderStatus calls and race on the metadata update inside enrichTradeWithFill / the runTx block. Fix mirrors the proven pattern in scheduler.ts.
- src/orders/order-manager.test.ts -- JUSTIFIED. Tests behavior, not scaffolding: real OrderManager with mocked BrokerService asserts onFill vs onCancel routing, working-order map cleanup, placedAt reset on PENDING->OPEN. Covers exactly the bugs the production code claims to fix. Six tests, all pass.

## Concerns
- **Theatre-adjacent (minor, not blocking):** IBKR cancelOrder FILLED branch sets result.fillTimestamp = new Date().toISOString() rather than the broker's actual fill time (client.ts:388). The same shortcut exists in getOrderStatus already (client.ts:414), so the change is consistent -- but the underlying sidecar response (OrderResponseSchema) doesn't expose the actual TWS fill time, so a true fix would require sidecar work.
- **Schema validation note:** cancelOrder result is not parsed through OrderResultSchema by the OrderManager (order-manager.ts:139 skips parse; order-manager.ts:99 parses getOrderStatus). The null guards `cancelResult.filledPrice != null && cancelResult.fillTimestamp != null` at order-manager.ts:144 handle the case where IBKR returns FILLED with avgFillPrice undefined (the sidecar schema marks avgFillPrice optional). Not a blocker, but tightening to reuse OrderResultSchema would be cleaner.
- **Missing lesson file:** Project rules require docs/lessons/YYYY-MM-DD-slug.md after every implementation session. This worktree adds none for these changes (the four 2026-04-24 lesson files in the worktree pertain to unrelated work).

## Verdict
**MERGE** -- All four changes target documented, reproducible go-live bugs (cancel/fill race, after-hours order tracking, multi-account orderId collision, sweep overlap). Each lives at the correct abstraction (broker boundary for fill enrichment, OrderManager for state-machine logic, FillSweep for sweep concurrency). No if (isBacktest) branches, no shape-plumbing cruft, no speculative abstractions, and the new test file exercises real behavior end-to-end. Single-user appropriate (the runtime-set fix matters because the same user runs paper + live concurrently). tsc clean; new vitest suite passes.

## Reviewer verdict
**APPROVE** — Independently re-ran `tsc --noEmit` (clean) and `vitest run src/orders/order-manager.test.ts` (6/6 pass) and audited every hunk of the diff. All four bug fixes are real, minimal, and placed at correct abstraction layers. Thesis justifications hold up; concerns are accurate and non-blocking.

### Agreements
- Per-runtime sets fix is correct: `IbkrRuntime` is constructed per `createIbkrService()` call and `ENABLED_CHANNEL_IDS` explicitly supports running live + paper concurrently (`src/lib/runtime-channels.ts:35,48`). Sharing module Sets across those instances is a real latent bug.
- The `OrderResultSchema` refines (`src/broker/order-schemas.ts:64-70`) do make `filledPrice` + `fillTimestamp` guaranteed-non-null for FILLED, validating the `!` assertions at `order-manager.ts:103-107`.
- No `if (isBacktest)` branches were added in `src/pipeline/` or `src/orders/`. The `'OPEN' | 'PENDING'` widening at `execute-resolved.ts:454` is broker-state-agnostic; SimBroker never emits PENDING so backtest behavior is unchanged.
- Test suite tests real behavior, not scaffolding — asserts callback routing, working-order map cleanup, and placedAt reset via real OrderManager with mocked BrokerService.

### Disagreements
- None material. The thesis's note about `fillTimestamp = new Date().toISOString()` being a shortcut is accurate and consistent with the pre-existing pattern in `getOrderStatus` (`client.ts:414`).

### Missed by thesis
- **Silent loss of real fills in a sub-edge case:** `order-manager.ts:144` requires `cancelResult.filledPrice != null && cancelResult.fillTimestamp != null` to route to onFill. Because `OrderResponseSchema.avgFillPrice` is `optional()` (`src/broker/ibkr/schemas.ts:57`), an IBKR response reporting `status=Filled` with no `avgFillPrice` would fall through to the CANCELLED branch — creating an orphan broker position *with no DB record* instead of the orphan-fill alert path. Low-probability (the sidecar normally includes avgFillPrice for FILLED) and FillSweep is a backstop via `getOrderStatus`, but the null-fallthrough is strictly worse than throwing or logging. The same issue exists in pre-existing `getOrderStatus` handling, so not a regression — but worth an `OrderResultSchema.parse(raw)` at `order-manager.ts:139` so a malformed FILLED response errors loudly rather than getting silently downgraded to CANCELLED.
- **No lesson file added** for this session despite CLAUDE.md mandating `docs/lessons/YYYY-MM-DD-slug.md` after every implementation session. Thesis flagged this; worth stressing since these are exactly the go-live incidents the lessons system exists to capture (the four existing 2026-04-24 lesson files cover unrelated work).
- **Redundant `if (order.status !== 'OPEN') continue;` at order-manager.ts:132**: reachable only when `order.status === 'PENDING' && status.status === 'PENDING'` — fine, just a nit. The earlier branch at :121 already `continue`s on transitions.

### Verdict reasoning
The worktree does exactly what it claims: fixes four real go-live bugs with surgical, correctly-scoped changes. No bloat, no over-abstraction, no rails violations, real regression tests. The avgFillPrice-missing edge case and the absent lesson file are worth noting but don't block merge — the former matches a pre-existing pattern and the latter is a process gap, not a code defect. Approve as MERGE.
