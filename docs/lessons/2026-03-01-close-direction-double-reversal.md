## Problem

Option close orders failing to fill in backtest despite favorable market conditions.
AAPL $230 Call close at limit $10.27 was REJECTED after 20 price-chase steps down to $7.27,
even though bid was $10.65 (well above limit). The order should have filled immediately.

## Root Cause

Double-reversal bug in `execute-resolved.ts` line 398.

Close signal legs already carry the correct closing side (e.g., `side: "SELL"` to close a LONG).
`deriveDirection(SELL legs)` correctly returns `SHORT` (= "this is a sell order").
But line 398 reversed `SHORT -> LONG`, thinking it was the position direction that needed inverting.

This made `isBuyOrder(LONG) = true`, so `shouldFillLimit` used the BUY check (`limit >= ask`)
instead of the correct SELL check (`limit <= bid`).

Two effects:
- SELL closes where ask > limit never fill (AAPL: $10.27 >= $11.00 = false)
- SELL closes where ask < limit fill incorrectly (RBLX: $11.68 >= $11.35 = true, but bid $10.95 < limit)

## Decision

Removed the direction reversal. `deriveDirection` returns the ORDER direction from signal legs,
which is exactly what `isBuyOrder` needs for fill logic. No reversal needed.

Updated `.claude/rules/pipeline-execution.md` to document the correct semantics.

## Key Files

- `src/pipeline/execute-resolved.ts` — removed `closeDirection` reversal
- `.claude/rules/pipeline-execution.md` — corrected direction documentation
- `scratchpad/verify-fix-real-code.ts` — verification using real SimBroker.placeOrder()
- `scratchpad/verify-fill-comparison.ts` — tick-level proof across 5 option closes

## Watch Out

- `deriveDirection` returns ORDER direction (what side of the market the order is on), not POSITION direction
- For opens: order direction = position direction (BUY to go LONG)
- For closes: order direction != position direction (SELL to close LONG)
- Price chase direction (order-manager) uses `firstLeg.action`, not `isBuyOrder` — was already correct
- `recordTrade` for CLOSE actions ignores the `direction` param and uses `existing.direction` from DB
