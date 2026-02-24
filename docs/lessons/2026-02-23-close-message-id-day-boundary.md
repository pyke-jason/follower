# closeMessageId Lost at Day Boundary Auto-Close

## Problem

NFLX PUT trade showed as "Auto" close in the UI despite an explicit exit message
("Exit NFLX with .12 loss per contract (15)") being processed at 3:43 PM. The exit
signal WAS correctly recognized — SIM-30 was created as a close order. But:

1. NFLX 250912P01182500 had sparse tick data (81 ticks), so the close order couldn't
   fill during the price-chase window at 3:43 PM.
2. At day boundary, runner.ts cancelled all unfilled close orders (step 0).
3. `pendingIntents.delete(wo.orderId)` erased the PendingOrderContext — losing the
   `recordFill` closure that captured `closeMessageId: opts.messageId`.
4. `autoCloseExpiring` then closed the position via `closePositionAtPrice` which has
   no message context → `closeMessageId = null` → UI shows "Auto".

## Decision

At day boundary, before cancelling close orders, extract the `recordFill` callback
from each pending context and save it keyed by `tradeId`. Pass this callback map to
`autoCloseExpiring`. When auto-closing a position that had a pending close order,
call `callback(price, at)` instead of `closePositionAtPrice` — preserving the
`closeMessageId` in the recorded trade event.

Added `tradeId?: string` to `PendingOrderContext` so the runner can build the map
without modifying `OrderParams` (which is a broker-level type). Set it in all three
position-reducing executors: `executeClose`, `executeTrim`, `executeLegOff`.

## Key Files

- `src/pipeline/execute.ts:31-43` — `PendingOrderContext` (added `tradeId`)
- `src/pipeline/execute.ts:455-464` — `executeClose` sets `tradeId: existing.id`
- `src/pipeline/execute.ts:613-622` — `executeTrim` same
- `src/pipeline/execute.ts:693-702` — `executeLegOff` same
- `src/backtest/runner.ts:376-399` — day boundary: builds `cancelledCloseCallbacks`
  before cancel loop, passes to `autoCloseExpiring`
- `src/backtest/sim-broker.ts:556-594` — `autoCloseExpiring` accepts optional
  callback map; uses callback over `closePositionAtPrice` when present
- `src/intents/evals/fixtures/exits.json` — exits-009 eval case added

## Watch Out

- `autoCloseExpiring` is a SimBroker-specific method (not on `BrokerService`
  interface), so the signature change only affects backtest paths.
- The final-day `autoCloseExpiring` call (after all messages processed) doesn't
  need `cancelledCloseCallbacks` — there's no preceding cancellation loop at that
  point.
- TRIM/LEG_OFF also use `isClosing = true` and were equally affected.
- The fix doesn't change `sweepExpired` — that's for positions that couldn't be
  quoted at auto-close time and represents a genuine fallback (no close signal
  expected there).
