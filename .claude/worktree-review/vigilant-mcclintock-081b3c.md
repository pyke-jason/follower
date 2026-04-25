# vigilant-mcclintock-081b3c — Live Failure Mode Audit

## Goal

Pre-live "exhaustive audit of failure paths, detection times, recovery correctness" (per `docs/lessons/2026-04-24-live-failure-mode-audit.md`). Ships five concrete fixes derived from the audit, plus a long narrative lesson cataloguing failure modes and recovery.

## Changes

1. `src/live/runner.ts` — 120s `Promise.race` timeout around `processTaskShared()` in `handleTask`; swap `.catch(()=>{})` on `checkExpiryWarnings` with a logging catch.
2. `src/pipeline/execute-resolved.ts` — `LIVE_ORDERS_ENABLED === '0'` kill switch at the top of `placeOrder()`.
3. `src/local-api/routes/web-mutations.ts` — add `orders: 'LIVE_ORDERS_ENABLED'` to `TOGGLE_ENV` so the web UI can flip it.
4. `src/orders/build-order-callbacks.ts` — wrap `pending.recordFill(order)` in try/catch; on DB failure, insert into `orphan_fills` + CRITICAL alert.
5. `src/broker/ibkr/client.ts` — cap `creditComboOrderIds` at 2000 and `alertedMissingSubscription` at 500 with FIFO eviction.

## Justification per change

### 1. 120s task timeout (runner.ts)
**Failure addressed:** A hung LLM call (no timeout in `AnthropicAgent.run()`) would stall the single-channel queue indefinitely, blocking every subsequent signal. This is real: the upstream SDK does not impose a wall-clock timeout on streaming calls, and ibkr/databento retries each have their own budgets that can chain into minute-scale hangs.

**Assessment:** Legitimate fix. The value (120s) is justified in the comment relative to `cancelAfterSec: 60` chase profiles + LLM overhead. Upstream-enough? Arguably the retry/timeout discipline belongs at the `Agent` base — but a task-level guard is the correct outer belt regardless, since non-LLM steps (databento, broker) can also hang. The belt-and-suspenders choice is acceptable.

**Caveat (acknowledged implicitly in the lesson, not explicitly):** `Promise.race` does NOT abort the underlying work. No `AbortSignal` is threaded into `processTaskShared`. The timed-out task continues running in the background and can still (a) submit an order to IBKR and (b) call `completeTask()` on a task already marked FAILED. The first case is the serious one — an order placed after the timeout has no task tracking the fill. The reconciliation fill-sweep + orphan-fill handler would eventually catch it, but this is not the clean cancel one might expect. Worth calling out, but not a blocker given the alternative is indefinite hang.

### 2. LIVE_ORDERS_ENABLED kill switch (execute-resolved.ts)
**Failure addressed:** No panic button to halt orders without killing the process. For a single-user system going live, this is mandatory.

**Rails concern:** `src/pipeline/execute-resolved.ts` is **shared pipeline code** (explicitly called out in `.claude/rules/pipeline-execution.md` as the canonical "no `if (isBacktest)` here" file). A `process.env.LIVE_ORDERS_ENABLED` gate is not strictly an `isBacktest` branch, but if the env var leaks into a backtest process, the backtest will silently emit `REJECTED` for every order. In practice backtests are launched via `npm run backtest` / `tsx src/backtest/launch.ts` as a separate process, so contamination risk is low — but the variable name includes "LIVE_" while gating code that runs in both modes. This is a minor rails smell, not a violation.

**Better home:** Either (a) gate in `BrokerService` implementations (so `SimBroker` is unaffected by definition), or (b) route via `ResolvedPipelineDeps` so the flag is only wired in the live factory. `BrokerService` placement is the canonical answer — the sidecar-level IBKR client or the factory that selects it could check the flag and short-circuit `placeOrder`. Current placement works but doesn't follow the pattern in the rules file.

**Persistence gap (real bug):** The toggle is stored via `KeychainProvider.set()`, which writes to keychain + `process.env[key]`. But `LIVE_ORDERS_ENABLED` is NOT in `SECRET_KEYS` in `src/lib/secrets/keychain-provider.ts`. That means on next process restart, `load()` will not restore the keychain value into `process.env`, and trading will silently resume. For a kill switch, this is the wrong failure mode. The fix is trivial: add `'LIVE_ORDERS_ENABLED'` to the `SECRET_KEYS` list. The worktree did not do this.

### 3. Toggle wiring (web-mutations.ts)
**Failure addressed:** Wires the kill switch to the existing `/settings/toggles/:id` endpoint. One-line addition, no concerns.

### 4. Orphan-fill handler on recordFill failure (build-order-callbacks.ts)
**Failure addressed:** Concrete gap. Fill confirms at IBKR → emit ORDER_FILLED → `recordFill(order)` writes to DB. If DB is down, the position is live at the broker but untracked locally. Nothing else catches this cleanly — the existing `orphanFills` table and orphan-fill handler only fire when `pendingIntents.get(order.orderId)` returns null (i.e., the pending intent was lost), not when `recordFill` itself throws.

**Assessment:** Solid. Reuses the existing `orphanFills` table + alert pathway. Double-catch ensures even if the orphan insert fails, the CRITICAL alert still fires. Not defensive theatre — this is the explicit DB-failure-mid-fill scenario the audit called out.

**Single nit:** the outer catch sends a critical alert even if the orphan insert succeeded. The alert wording is the same either way; the operator flow is the same (manual reconciliation). Fine.

### 5. Cap unbounded Sets (ibkr/client.ts)
**Failure addressed:** `creditComboOrderIds` grows forever (deleted on cancel, NOT on fill) → memory leak across a long-lived session. `alertedMissingSubscription` grows by unique symbol.

**Assessment:** Memory pressure from these two Sets is minuscule for a single-user bot (2000 × ~12-char string = ~24KB). The fix is essentially free, but the severity claim in the lesson is accurate ("LOW").

**Subtle risk in the order path:** `creditComboOrderIds` is read in `modifyOrder()` to re-apply the negative sign for credit BAG orders. Evicting an entry for an order that is still working (rare: 2000+ open credit combos at once) would cause `modifyOrder` to send a positive limit price to a BAG that expects negative, silently flipping the order's economics. For a single-user bot this is essentially unreachable (2000 concurrent open credit combos is not a scenario that occurs), but the eviction is unbounded-in-principle and happens inside live order code. A safer approach: delete on `onFill` at the `OrderManager` level, or index the Set to only contain open orders. The chosen cap+FIFO is the simplest patch and the concrete risk is negligible.

## Concerns

- **Kill switch doesn't persist across restart.** `LIVE_ORDERS_ENABLED` is missing from `SECRET_KEYS`. This is the single real bug in the PR — a kill switch that resets when the process crashes is worse than no kill switch because it gives a false sense of security.
- **Timeout does not abort work.** Acknowledged implicitly. An `AbortSignal` threaded through `processTask` → orchestrator → `placeOrder` would be cleaner and is listed as "consider" in the lesson's remaining recommendations (though not explicitly as "abort"). Acceptable for now.
- **Kill-switch env check lives in shared pipeline code.** Low-probability contamination, but the cleaner placement is in a `BrokerService` decorator or the runner-level bundle factory. Not a blocker.
- **Minor rails smell:** Repeats `process.env.LIVE_ORDERS_ENABLED` instead of reading through `getProvider()` / secrets. Consistent with `src/index.ts:66` doing the same for `LIVE_INGESTION_ENABLED`, so at least the pattern is consistent — but the pattern itself is a latent issue.
- **`evictOldestIfNeeded` uses `.values().next().value as string` with a non-null `as` cast.** If the Set is empty at call-time this is fine (the guard `size >= max` prevents entry) but the cast is a lie to TS. Trivial.

## Verdict

**MERGE with one required fix.**

Four of five changes map to concrete failure modes identified in the audit and are implemented correctly: the orphan-fill handler closes a genuine DB-mid-fill gap, the task timeout is the single biggest improvement to live readiness in this PR (indefinite-hang → 2-minute bounded), the cap-and-evict is cheap insurance, and the expiry-warning log change is a pure improvement.

The kill switch is the critical item — and it has a real defect: the env var isn't in `SECRET_KEYS`, so the toggle doesn't survive restart. For a trading kill switch this matters. It's a one-line fix and gates the merge.

The shared-pipeline placement of the kill switch is a minor rails concern (belongs in `BrokerService` or the factory, per `docs/rails.md`'s "pipeline is shared" rule), but not a blocker given the env-var pattern matches `LIVE_INGESTION_ENABLED` elsewhere and contamination risk is low in practice.

Not bloat, not theatre — the audit is thorough, every change has a specific named failure, and the "comments say what, not why" anti-pattern is avoided. The long failure-mode lesson file is actually useful reference material, not a dump.

## Required fixes

1. **Add `'LIVE_ORDERS_ENABLED'` to `SECRET_KEYS` in `src/lib/secrets/keychain-provider.ts`.** Without this, toggling orders off via the web UI won't survive a process restart — the toggle value lives only in `process.env` for the life of the current process and is not re-loaded from keychain on next boot.

## Suggested (non-blocking) follow-ups

- Thread an `AbortSignal` through `processTask` so the 120s timeout actually cancels in-flight fetches / broker calls. Currently the timeout unblocks the queue but the work leaks.
- Move the `LIVE_ORDERS_ENABLED` check out of `src/pipeline/execute-resolved.ts` and into either the live runner's `buildPipelineDeps` factory or a `BrokerService` decorator, per the "pipeline is shared" rail.
- Consider an explicit onFill-triggered delete for `creditComboOrderIds` instead of FIFO cap; cap is harmless now but the semantics match the actual lifecycle better.

## Reviewer verdict

**REWORK** (one-line blocker confirmed; thesis is otherwise accurate)

### Agreements
- **Persistence gap is real and load-bearing.** Verified: `SECRET_KEYS` (`src/lib/secrets/keychain-provider.ts:8-40`) lists `LIVE_INGESTION_ENABLED` but not `LIVE_ORDERS_ENABLED`. `provider.set()` writes keychain + `process.env`, but `load()` only re-hydrates keys in `SECRET_KEYS`. Toggling orders off via `/settings/toggles/orders` survives only the current process. For a kill switch this is the wrong failure mode, exactly as the thesis states. One-line fix.
- **Shared-pipeline placement is a real rails smell.** `src/pipeline/execute-resolved.ts` is named in `docs/rails.md:50` ("pipeline code is shared") and the rule's checklist explicitly forbids env/mode branching here. Belongs in a `BrokerService` decorator or `buildPipelineDeps` factory. Acceptable as posted because contamination risk is low (backtest is a separate process), but the rails smell stands.
- **Timeout-doesn't-abort caveat is correct.** `Promise.race` leaves the in-flight `processTaskShared` running. An order placed after timeout escapes task tracking; reconciliation/orphan-fill is the only safety net. Thesis flags this honestly.
- **Orphan-fill handler is the strongest change.** Schema fields (`src/db/schema.ts:296-311`) match the new insert exactly. `deps.scope`/`deps.clock`/`sendAlert` shapes match existing usage in the same file. Closes a real DB-mid-fill gap.
- **Cap+FIFO on the Sets is cheap and correct.** The thesis's note about a 2000+-concurrent-credit-combo eviction silently flipping `modifyOrder` sign is theoretically real but operationally unreachable.

### Disagreements
- None material. The thesis is calibrated — it doesn't oversell the audit, names the kill-switch defect plainly, and flags the pipeline-placement rails issue without making it a blocker.

### Missed
- **Zero tests.** Five behavioral changes in live order paths, no test additions (`grep` for `LIVE_ORDERS_ENABLED`/`TASK_TIMEOUT`/`orphanFills` across `*.test.ts` returns nothing). The kill switch in particular is a one-line gate that's trivially testable; the orphan-fill catch path is also testable with a mocked `recordFill` rejection. Thesis doesn't mention this.
- **`evictOldestIfNeeded` empty-set assertion.** `set.values().next().value as string` would yield `undefined` if called on an empty set; the call-site guard (`size >= max`, max ≥ 1) prevents this in practice, but the cast is the kind of "for safety" lie that should be a real check.
- **No `npx tsc --noEmit && npm test` evidence in the audit.** Lesson file and PR don't show the quality gates were run; project's `CLAUDE.md` requires this before declaring done.

### Verdict
**REWORK.** Add `'LIVE_ORDERS_ENABLED'` to `SECRET_KEYS`, then merge. The four other changes are concrete failure-mode fixes (not defensive theatre — no "for safety" comments observed; comments cite specific named failures). The single blocker is one line.
