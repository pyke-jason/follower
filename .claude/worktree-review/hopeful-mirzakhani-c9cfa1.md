# Worktree Audit: hopeful-mirzakhani-c9cfa1 — short-selling-audit

## Goal

Productionize four short-stock concerns before going live: backtest margin model, pre-flight borrow locate, account-summary excessLiquidity passthrough, and reconciler forced-buy-in detection.

## Changes

1. `src/backtest/margin-model.ts` — SHORT STOCK `initial` changed from `marketValue * 0.50` → `marketValue * 1.50`. Comment cites Reg-T 220.12 (100% proceeds + 50% deposit = 150%).
2. `src/backtest/margin-model.test.ts` — property test updated to expect 1.50, plus a new concrete "short 100 SPY @ $450 → initial = $67,500" example.
3. `sidecar/.../TwsBridge.java` — `contractDetails()` now emits `shortable` (0 / 1.5 / 2.5) in the resolve response.
4. `src/broker/ibkr/schemas.ts` — `ContractResolveResponseSchema.shortable: z.number().optional()`.
5. `src/broker/ibkr/client.ts` — adds `interpretShortable()`, `checkShortLocate()`, calls the latter inside `placeOrder()` when `legs.length === 1 && type === 'STOCK' && action === 'SELL' && !isClosing`. Throws on hard-to-borrow (`shortable < 1.5`), system-alert on limited (`< 2.5`), fail-open on sidecar fetch error. Adds permanent-error classification for "short locate failed". Wires `excessLiquidity` from `summary` into the returned `AccountBalance`.
6. `src/broker/ibkr/client.test.ts` — 7 unit tests for `interpretShortable` boundaries.
7. `src/broker/types.ts` — `AccountBalance.excessLiquidity?: number` added.
8. `src/reconciliation/reconciler.ts` — DB_ONLY path: when missing position is SHORT STOCK, log warn ("Potential forced buy-in") and add `potentialForcedBuyIn: true` into the `expected` payload (serialized into Discord alert).
9. `docs/lessons/2026-04-24-short-selling-audit.md` — new lesson, well-written.

`npx tsc --noEmit` clean. `npx vitest run` — 573 tests pass. `knip` could not run (pre-existing missing web deps in worktree, unrelated).

## Justification per change

### Margin model 0.50 → 1.50 — INCORRECT, REJECT

This is the load-bearing claim of the worktree, and it's wrong for this codebase's convention. The `initial` field is consumed in exactly one place: `src/backtest/sim-broker.ts:859`, where unfilled working orders accumulate `workingOrderMargin += woMargin.initial`, and buying power is computed as `equity − totalMaintenanceMargin − workingOrderMargin`. After fill, `initial` is no longer used — only `maintenance`.

The codebase's `initial` semantics are "pre-fill encumbrance against equity", not "gross Reg-T collateral requirement". This is consistent with LONG STOCK also using 0.50 (its 50% Reg-T deposit, not a 100% gross). For SHORT STOCK at $45,000:

- After fill: cash +$45k, market value −$45k → equity unchanged. Maintenance = 30% × $45k = $13,500. Available BP = equity − $13,500.
- Pre-fill (working): 0.50 × $45k = $22,500 reservation. Symmetric to LONG STOCK and slightly conservative vs the post-fill $13,500 maintenance figure.
- New 1.50: $67,500 reservation — 5× the post-fill maintenance encumbrance, asymmetric vs LONG STOCK's 0.50, and disconnected from how `initial` is actually consumed.

The commit message claims "every backtest with a short stock under-reported margin by 3×". That's only true if `initial` represented gross Reg-T requirement — but it doesn't, the LONG STOCK case proves that. With this change, working short-stock orders falsely consume 5× more buying power than the resulting filled position, suppressing simulated short fills during the working window in ways that don't reflect any real broker behavior. The original 0.50 was correct for this field's role; the change should be reverted (or, if a gross-collateral concept is genuinely wanted, a separate field added — but that would also require sim-broker changes, which aren't in this worktree).

### TwsBridge `shortable` emit — JUSTIFIED

Tiny additive change; pulls a TWS contractDetails field that was already available. Necessary for the locate check to work.

### Schema + Locate check + permanent-error classification — JUSTIFIED with caveats

The room actually signals SHORT STOCK (`src/parsing/badges.ts:12` maps "Short" → OPEN+SHORT; `src/intents/orchestrator/llm-path.ts` has explicit SHORT STOCK examples). Routing this to live IBKR without a borrow check risks rejection storms or unintended naked shorts on hard-to-borrow names. The check is gated tightly (single-leg, STOCK, SELL, !isClosing), upstream of the order POST, and lives in the broker implementation (rails-compliant — not in pipeline/orders). Tests exercise the boundary thresholds. Classifying "short locate failed" as `permanent` prevents pointless retries.

Caveats:
- `checkShortLocate()` issues a SECOND `/contracts/resolve` POST instead of extending `resolveStockContract()` to return shortable. There's an in-memory contract cache that's bypassed. Mild waste of a sidecar RTT per short open. Not a blocker — skipping cache is arguably correct because borrow availability moves while conIds don't.
- No integration test exercising the `placeOrder` short-locate path (only `interpretShortable` is unit-tested). Acceptable but a gap.
- Fail-open on sidecar fetch error means a flaky sidecar will just silently let shorts through with a warning alert. Defensible (IBKR will reject anyway), but noted.

### excessLiquidity passthrough — BLOAT

Schema already parsed `excessLiquidity` (from main); this PR forwards it into `AccountBalance` and through `getAccountBalance()`. Zero current consumers — `daily-balance.ts` doesn't read it, no risk-check uses it. The lesson markdown doesn't justify it beyond "it was returned but never forwarded". Adding plumbing without a consumer is exactly the speculative abstraction the rubric forbids. Either land a consumer (e.g. write it into `daily_balances`) or drop the change.

### Reconciler forced-buy-in detection — JUSTIFIED, MINIMAL

Two-line change: log.warn + spread `potentialForcedBuyIn: true` into the existing `expected` payload (typed as `unknown`, JSON-serialized into Discord by `notify.ts:33`). No new alert type, no new schema, no behavioral change beyond a clearer operator signal. SHORT STOCK going DB_ONLY is genuinely a different failure mode from option DB_ONLY (forced buy-in vs missed manual close), and operators will want this context. Cheap, correct, useful.

## Concerns

- **Margin change is the headliner and it's wrong.** It will cause backtest BP to be wildly conservative on shorts during the working-order window, distorting fill rates and equity curves on any backtest that includes short stock entries. The "3× under-reported" framing in the lesson misreads the field's semantics.
- **`excessLiquidity` is dead code today.** Either wire a consumer or drop it.
- **Locate check makes a redundant resolve call** that bypasses the contract cache. Functional, but the cleaner shape is to extend `resolveStockContract` to return shortable and have `checkShortLocate` call it.
- **No integration test** for the locate-check path inside `placeOrder` (mocked sidecar). The interpreter is tested but the wiring isn't.
- **Sidecar must be rebuilt** for the locate check to work — flagged in the lesson but not enforced anywhere. If the Java sidecar is forgotten, every locate check returns `shortable=undefined` → "limited" path, alerting on every short. Acceptable since it's noisy not silent, but noted.

## Verdict: REWORK

The locate check + Java emit + reconciler buy-in flag are good, well-scoped, rails-compliant productionization that the live launch genuinely needs — keep them. The margin-model change is incorrect for this codebase's convention and would actively distort backtest results for any run touching short stock. The `excessLiquidity` plumbing is bloat without a consumer. Land the locate check as-is, fix the cache redundancy if cheap, drop or wire the excessLiquidity field, and revert the margin constant. Do not merge as-is.

## Required fixes

1. **Revert `src/backtest/margin-model.ts` SHORT STOCK initial back to `marketValue * 0.50`** and revert the corresponding test changes (property test expectation + the new concrete "67,500" example). The 0.50 figure is consistent with LONG STOCK and matches how `initial` is consumed (working-order encumbrance against equity, not gross Reg-T collateral). If a gross-collateral concept is actually wanted, that's a separate, larger change touching `sim-broker.ts` consumption — out of scope here.
2. **Either drop `excessLiquidity` from `AccountBalance` and the IBKR client passthrough, or land a consumer** (e.g. capture it in `daily-balance.ts` alongside `buyingPower`/`equity`, schema column added). No speculative plumbing.
3. **Optional: have `resolveStockContract` return `shortable`** and have `checkShortLocate` consume the resolved contract instead of issuing a second POST. Avoids a duplicate sidecar call per short open.
4. **Optional but recommended: one integration test** for `placeOrder` short-locate wiring (mocked sidecar returning `shortable: 0` → throws; `shortable: 2.5` → proceeds). Covers the wiring the unit tests don't.

## Reviewer verdict

Tried to falsify; thesis holds. Agreeing with REWORK.

**Bloat hypothesis falsified.** The room actively signals SHORT STOCK outright, not just via bearish options. `src/parsing/badges.ts:12` maps "Short" → OPEN+SHORT; fixtures in `stock-exits.json`, `add-to-position.json` (AMD short, TSLA short), and `direction.json` include concrete SHORT STOCK cases that route to `SELL STOCK` orders. This worktree's domain is real, so the locate check + sidecar `shortable` emit + reconciler forced-buy-in flag are legitimately needed before live launch.

**Margin claim confirmed wrong.** Verified `src/backtest/sim-broker.ts:819-864`: `marginReq.initial` is consumed at exactly one site (line 859), for unfilled working-order BP encumbrance. Filled positions use `marginReq.maintenance` (line 825). Post-fill SHORT STOCK at $45k: cash +$45k, MV −$45k, equity unchanged, maintenance $13.5k (30%). Pre-fill encumbrance of 1.50 × $45k = $67.5k is 5× the post-fill maintenance; the working order would block 5× the buying power its eventual filled state consumes. Also asymmetric with LONG STOCK, which remains at 0.50. The thesis's reading of `initial` as "pre-fill encumbrance against equity" (not "gross Reg-T collateral") is correct. The commit's "3× under-reported" framing confuses two different concepts.

**excessLiquidity bloat confirmed.** `grep -rn excessLiquidity src/` returns exactly three hits: schema parse, client passthrough, type declaration. Zero readers. `daily-balance.ts:40` writes `buyingPower` + `equity` but not `excessLiquidity`. No risk check reads it. Pure speculative plumbing.

**Locate-check gate is correct.** `isClosing` is set from `isPositionReducing = CLOSE || TRIM || LEG_OFF` (`execute-resolved.ts:326,476`). So `SELL STOCK && !isClosing` covers both OPEN and ADD to a short — correct. LONG STOCK CLOSE (SELL, isClosing=true) correctly skips. ADD to LONG (BUY) correctly skips. No false positives on cover-to-close.

**Reconciler change is minimal and safe.** Verified `src/reconciliation/reconciler.ts`: only the SHORT STOCK DB_ONLY branch gets a warn + `potentialForcedBuyIn: true` spread into the existing `expected` payload. No new alert types, no schema changes, behavior is unchanged for option DB_ONLYs.

**One addition to required fixes:** The lesson markdown itself repeats the incorrect "under-reported by 3×" framing — it needs updating or removal once the margin revert lands, otherwise future readers will re-introduce the same bug citing the lesson as precedent.

Path: `/Users/jason/Workspace/trade-follower-3/.claude/worktree-review/hopeful-mirzakhani-c9cfa1.md`

## Reviewer verdict

**REWORK** — independent falsification attempt confirms the thesis.

### Agreements

- **Bloat hypothesis falsified.** The chat room signals SHORT STOCK directly. `src/parsing/badges.ts:12` maps `'Short' → { direction: 'SHORT', action: 'OPEN' }`. Fixtures in `src/intents/evals/fixtures/add-to-position.json` carry concrete AMD and TSLA SHORT STOCK cases routed to `SELL STOCK` orders. The borrow-locate, sidecar `shortable` emit, and reconciler forced-buy-in flag are domain-real and needed before live launch.

- **Margin-model change is wrong.** Verified at `src/backtest/sim-broker.ts:819-862`: `marginReq.initial` is consumed at exactly one site (line 859), inside the working-orders loop, accumulated into `workingOrderMargin` and subtracted from equity for buying-power. Filled positions use only `marginReq.maintenance` (line 825). LONG STOCK uses `0.50` for `initial`; raising SHORT STOCK to `1.50` (margin-model.ts:99) creates a 3:1 asymmetry that doesn't reflect any post-fill broker behavior. A pre-fill working short would block 5× the BP its own filled state would. The lesson markdown's "under-reported by 3×" framing confuses gross Reg-T collateral with the field's actual semantics.

- **`excessLiquidity` plumbing is dead.** `grep -rn excessLiquidity src/ web/src/` returns three hits: `schemas.ts:92` parse, `client.ts:570` passthrough, `types.ts:88` declaration. No reader. `daily-balance.ts` doesn't persist it. Speculative abstraction.

- **Locate-check gating is correct.** `params.isClosing` derives from `isPositionReducing = CLOSE || TRIM || LEG_OFF` (`src/pipeline/execute-resolved.ts:326,476,491`). Combined with `legs.length === 1 && type === 'STOCK' && action === 'SELL'`, this fires on OPEN/ADD short stock and skips both LONG STOCK CLOSE (BUY-to-close excluded by SELL) and SHORT STOCK CLOSE/TRIM (excluded by `!isClosing`). No false positives on cover-to-close.

- **Reconciler change is minimal and safe.** Two-line spread of `potentialForcedBuyIn: true` into the existing `expected` payload, gated only on `direction === 'SHORT' && strategy === 'STOCK'`. No new alert types or schema. Behavior unchanged for option DB_ONLYs.

### Disagreements

None. The thesis is internally consistent and load-bearing claims hold under direct file inspection.

### Missed by thesis

- The lesson file (`docs/lessons/2026-04-24-short-selling-audit.md`) propagates the same incorrect "3× under-reported" margin framing. Future readers will cite the lesson as precedent and re-introduce the bug. The thesis flags revert of the constant + tests but doesn't require rewriting the lesson section that motivates it. Add this to required fixes.
- No verification that `placeOrder()`'s second `/contracts/resolve` POST (inside `checkShortLocate`) carries the same conId/sec-type expectations as the cached `resolveStockContract()` call — minor risk of drift if the sidecar resolve contract evolves.

### Verdict reasoning

Locate check + Java emit + reconciler buy-in flag are well-scoped, rails-compliant, and necessary. The margin constant is the headline change and it is wrong for this codebase's `initial` semantics; merging it would silently distort backtest fill rates and equity curves on every short. `excessLiquidity` is bloat. Land the locate-check stack; revert margin (with lesson rewrite); drop or wire excessLiquidity. Do not merge as-is.

Path: `/Users/jason/Workspace/trade-follower-3/.claude/worktree-review/hopeful-mirzakhani-c9cfa1.md`
