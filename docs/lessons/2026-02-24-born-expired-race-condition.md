# Born-Expired Position Race Condition

## Problem
OPEN orders with multi-step price chase can span the day boundary in the backtest runner.
The day boundary logic only cancelled CLOSE orders, then ran `sweepExpired` and `autoCloseExpiring`.
If an OPEN order's price chase filled AFTER the sweep, the resulting position had already-expired
option legs — a "born expired" position.

Concrete case: Dave W's SPY 250905C 645 CALL (SIM-23) was placed during Sep 5 message processing
with a 9-step price chase. At the Sep 5→Sep 8 boundary, the sweep ran at wall-clock 22:19:40.997
but SIM-23 filled at 22:19:40.999, creating position 222b115a with 9/05 expiry legs on 9/08.
When the CLOSE signal arrived Sep 8 09:31, `getQuote()` hit Databento 422 on the expired OCC
symbol. The position was finally swept at the 09-08→09-09 boundary (one day late).

## Decision
Extend day boundary cancellation to also cancel OPEN orders whose option legs expired before
the new trading day. A 9/05 expiry option can't fill on 9/08 — the contract no longer exists.

## Key Files
- `src/backtest/runner.ts:376-399` — day boundary order cancellation (fix location)
- `src/backtest/sim-broker.ts:500-519` — sweepExpired (runs after cancellation)
- `src/backtest/sim-broker.ts:541-575` — autoCloseExpiring

## Watch Out
- The check uses `leg.expiry < msgDay` (strict less-than), NOT `<=`. Same-day-expiry orders
  should still be allowed to fill during that day's message processing.
- Only checks `leg.type !== 'STOCK'` legs — stock legs don't expire.
- `pendingIntents.delete(wo.orderId)` must be called alongside `broker.cancelOrder()` to
  prevent orphaned intent mappings.
