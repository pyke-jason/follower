# charming-euclid-da205a

## Goal
Add minimal flagging (no tax computation) for three pre-live tax/compliance gaps: (1) wash-sale awareness — warn operator when an OPEN happens within 30 days of a same-underlying loss close; (2) corporate-action detection — when reconciler sees a clean qty ratio (2:1, 3:1, 0.5x …), emit a separate `CORPORATE_ACTION_SUSPECTED` alert so the operator knows a QUANTITY_MISMATCH is probably a split, not a missed fill; (3) tax-lot attribution — author concluded IBKR already provides `averageCost` via existing `BrokerPosition` payload, no new code added.

## Changes
- `src/tax/wash-sale-detector.ts` — new module; queries closed loss trades on the same underlying within prior 30 days, returns flag + related trade id. Skips `bt:` channels.
- `src/trades/record-trade.ts` — calls `checkWashSale()` on OPEN; stamps `washSaleClosedAtLoss` + loss amount on CLOSE and on full TRIM (when remaining qty <= 0). Sends warning alert to operator on potential wash.
- `src/db/schema.ts` — extends `TradeMetadata` with four optional wash-sale fields; extends `ReconciliationAlertType` union with `CORPORATE_ACTION_SUSPECTED`. JSONB column, no migration needed.
- `src/reconciliation/reconciler.ts` — `detectCorporateActionRatio()` helper inside the QUANTITY_MISMATCH loop; emits a sibling `CORPORATE_ACTION_SUSPECTED` alert with ratio + cost-aligned flag. Auto-resolve clause extended to handle the new alert type.
- `src/reconciliation/notify.ts` — adds purple Discord color for `CORPORATE_ACTION_SUSPECTED`.
- `docs/lessons/2026-04-24-tax-lots-wash-sales-corporate-actions.md` — author's rationale (matches code).

## Justification per change
- `src/reconciliation/reconciler.ts` — **JUSTIFIED**. Corporate-action detection is real go-live value: an autonomous bot seeing a 4:1 split as a QUANTITY_MISMATCH could panic-close at huge basis loss. A 30-line ratio check transforms a useless red alert into actionable context. Lives in the right place. Auto-resolve correctly extended.
- `src/reconciliation/notify.ts` — **JUSTIFIED**. Trivial color-table extension, required for the new alert type.
- `src/db/schema.ts` (alert union) — **JUSTIFIED**. Necessary backing for corporate-action change.
- `src/db/schema.ts` (washSale* metadata fields) — **SUSPECT**. Only exists to back the wash-sale plumbing.
- `src/tax/wash-sale-detector.ts` — **SUSPECT**. See below.
- `src/trades/record-trade.ts` (wash-sale wiring) — **SUSPECT**. See below.

Wash-sale plumbing fails the rubric:
1. **Broker is authoritative for tax.** IBKR issues 1099-B with wash-sale adjustments already computed. Parallel tax tracking on top of broker statements is bloat per the audit rubric.
2. **Detection without prevention is theatre.** A copy-bot trading repeated SPY/QQQ names will generate wash-sale warnings constantly; the operator will mute them within a week. The feature does not block, pause, or delay any trade.
3. **Runs after payload is built, before insert.** It's purely after-the-fact awareness, which is exactly what 1099-B provides authoritatively.
4. **Per-OPEN DB query on the live hot path.** Small but non-zero overhead for zero gating value.

Corporate-action half can ship cleanly without wash-sale half — they share only the lesson file.

## Concerns
- **Bloat**: `src/tax/wash-sale-detector.ts` (entire file) and wiring in `src/trades/record-trade.ts:317-329, 508-511, 655-659`. Parallel to broker 1099-B.
- **Theatre**: `src/trades/record-trade.ts:317-329` — non-blocking warning that the operator will train themselves to ignore.
- **Not upstream enough (minor)**: `src/tax/wash-sale-detector.ts:43` re-implements `channelId.startsWith('bt:')` inline instead of importing `isBacktestChannel` from `src/lib/channel.ts`.
- **Missing test coverage**: no `wash-sale-detector.test.ts`; no test for `detectCorporateActionRatio()`. The 2%/15% tolerances are judgment calls worth pinning behaviorally.

No rails violation — bt-skip lives inside the helper, not at the call site. Reconciler isn't shared pipeline.

## Verdict
**REWORK** — corporate-action detection is genuinely useful for go-live (low cost, high signal when an actual split happens) and should merge. Wash-sale plumbing duplicates broker 1099-B work, doesn't gate execution, and will produce alert fatigue. Strip the wash-sale half; keep corporate-action.

## Required fixes
1. Delete `src/tax/wash-sale-detector.ts` entirely.
2. `src/trades/record-trade.ts` — revert wash-sale wiring at ~lines 317-329 (OPEN), 508-511 (CLOSE), 655-659 (full TRIM); remove `checkWashSale` import at line 22.
3. `src/db/schema.ts:555-562` — remove the four `washSale*` fields from `TradeMetadata`. Keep the `CORPORATE_ACTION_SUSPECTED` union extension at line 273.
4. `docs/lessons/2026-04-24-tax-lots-wash-sales-corporate-actions.md` — narrow the lesson to the corporate-action change; note that wash-sale was deferred because broker 1099-B is authoritative.
5. (If keeping wash-sale anyway) — add `src/tax/wash-sale-detector.test.ts`; use `isBacktestChannel` from `src/lib/channel.ts`; add tests for `detectCorporateActionRatio` covering 2:1, 3:1, 0.5, and false-positive (50→100 partial-fill) cases.

## Reviewer verdict
**REWORK** — thesis is largely correct but under-sells the wash-sale problems and misses real false-positive hazards on the corporate-action half. Net disposition still "strip wash-sale, keep corp-action," but corp-action needs tightening before merge.

### Agreements
- Corporate-action detection is the real win — cheap, lives in the right place, auto-resolve correctly extended, costAligned cross-check is thoughtful.
- Wash-sale duplicates IBKR 1099-B's authoritative wash-sale computation for tax-filing purposes.
- `startsWith('bt:')` should use `isBacktestChannel` from `src/lib/channel.ts`.
- Zero test coverage for either new code path.
- Claim about tax-lot tracking being a no-op verified: `BrokerPosition.averageCost` (`src/broker/types.ts:58`) already flows through.

### Disagreements
- Thesis frames wash-sale as "theatre." That's too strong — real-time Discord awareness differs from year-end 1099-B reconciliation (operator can adjust behavior during the year rather than discover disallowed losses in April). The weakness is over-triggering, not uselessness.
- Thesis calls wash-sale wiring "small but non-zero overhead." The bigger smell is the mutation pattern at `record-trade.ts:314-329`: `values.metadata` is assigned pre-check, then `openMetadata` is mutated afterward. Works because they're the same reference, but fragile — one refactor that spreads `{...openMetadata}` into `values` silently drops the wash-sale stamps. Thesis missed this.

### Missed by thesis
- **Option-roll false positive**: `extractUnderlying('SPY  260307C00450000')` returns `'SPY'`, so closing SPY 450C at a loss and opening SPY 455C the next day fires the alert — but different strikes/expirations generally are NOT "substantially identical" under IRS rules. On a copy-bot trading weeklies, alert volume will be dominated by these legal non-washes, worsening the fatigue problem.
- **Corporate-action false positive is broader than thesis suggests**: a normal partial-fill scenario (DB records 50 shares, broker has 100 after a second fill arrives) produces ratio=2.0 exactly, passes the 2% qty tolerance, AND passes the 15% cost tolerance if entry price didn't move much. `costAligned=true` will be reported, giving the operator a false "confirmed split" signal. Thesis lists the case but doesn't note that the cost cross-check fails to save it.
- `sendAlert?.(...)` at `record-trade.ts:322` is not awaited (lifecycle alerts elsewhere are awaited). Minor, but inconsistent.
- `schema.ts` TradeMetadata extension is additive-only on a `typedJson` column — no migration needed, confirmed. Thesis glossed "no migration needed" without stating why.

### Verdict reasoning
The corporate-action helper is genuinely useful but needs tighter tolerances (1% qty; require costAligned=true before emitting, or downgrade to log-only when false) AND a test covering the 50→100 partial-fill case before go-live. The wash-sale half should be dropped for the thesis's reasons plus the option-roll false-positive. REWORK, not BLOCK — nothing here is dangerous, just overbuilt and under-tested for a pre-live ship.
