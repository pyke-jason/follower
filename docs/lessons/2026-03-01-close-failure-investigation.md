# Close Failure Investigation — Backtest 9c9973c9

## Problem

29 close-fail SETTLED events across 28 unique trades in backtest 9c9973c9.
5 trades permanently stuck OPEN, 23 trades closed despite per-signal SETTLED FAIL.

## Root Causes

### RC1: SETTLED fires FAIL before deferred fill (timing race) — 23 trades

The per-signal SETTLED event at `execute-resolved.ts:473` checks `result.executed`
synchronously after `placeOrder()` returns. When the order status is `OPEN` (limit
order placed but not yet filled), `executed` is `false`, so outcome = FAIL.

But the order is still working. On the next `orderManager.tick()`, it fills via the
`onFill` callback in `build-order-callbacks.ts:27-46`, which records the trade as
CLOSED. By then, the per-signal SETTLED has already been written as FAIL.

The runner-level SETTLED (at `runner.ts:568-575`) correctly handles this by
recognizing `pendingResults` (results with `!r.executed && !r.reason`).

Fix: Treat OPEN orders as PENDING in per-signal SETTLED, not FAIL.

### RC2: Direction mismatch between SimBroker and OrderManager — ALL 28 orders

`execute-resolved.ts:398` computes `closeDirection` via double-inversion:
1. `deriveDirection(signal.legs)` — returns direction from close leg side
   (SELL→SHORT, BUY→LONG)
2. `closeDirection = direction === 'LONG' ? 'SHORT' : 'LONG'` — inverts it

This means `params.direction` represents "the original position's direction"
(not the order's buy/sell intent), but SimBroker interprets it as buy/sell:

- `isBuyOrder(params)` at `sim-broker.ts:55-56`: `params.direction === 'LONG'`
- `shouldFillLimit(isBuy, limit, bid, ask)` at `sim-broker.ts:64-66`

Result: SimBroker applies BUY fill logic to SELL orders and vice versa.

| Close Type | Leg Side | deriveDirection | closeDirection | SimBroker thinks |
|---|---|---|---|---|
| Close LONG | SELL | SHORT | LONG | BUY (WRONG) |
| Close SHORT | BUY | LONG | SHORT | SELL (WRONG) |

Meanwhile, OrderManager correctly uses `firstLeg.action` (`order-manager.ts:151`)
for price chase direction. So chase and fill check DIVERGE:

- SELL chase DOWN + BUY fill check (limit >= ask) → NEVER fills
- BUY chase UP + SELL fill check (limit <= bid) → NEVER fills (unless initial limit ≤ bid)

### RC3: Lookback asymmetry on option close — 1 trade (DG PUT 109)

DG PUT 109 exp 2025-09-19 close at 2025-09-12T19:38:26Z failed because of a
lookback window mismatch between two code paths:

1. `getSpreadMidpoint()` calls `broker.getQuote()` with default 300-min lookback
   → finds a tick from 7.6 minutes ago → SUCCEEDS, returns a mid price
2. `sim-broker.placeOrder()` immediate fill check uses `EXECUTION_LOOKBACK_MINS=5`
   → 7.6-min-old tick is outside 5-min window → REJECTED outright

The option IS real (6,236 cached ticks) and the cache covers this time range.
There was simply a natural 7.6-minute quote gap (19:30:47 → 19:38:44) that fell
between the two lookback thresholds. The order never even becomes a working order
— it's rejected before it can be queued.

Fix: Either widen `EXECUTION_LOOKBACK_MINS` for close orders, or fall back to
queuing the order as OPEN when immediate fill data is stale (let tick() handle it).

## Impact

| Category | Count | Outcome |
|---|---|---|
| Timing race only (order filled) | 23 | Cosmetic — trade closed, just wrong SETTLED event |
| Direction mismatch + cancelled | 4 | Real damage — trade stuck OPEN forever |
| Lookback asymmetry (DG option) | 1 | Real damage — order REJECTED, never queued |

The 23 "lucky" fills happened because the inverted fill condition was still
accidentally satisfied (tight spreads where limit was between bid and ask, so
both BUY and SELL conditions were met simultaneously).

## Fix

Remove the direction reversal on close orders. `deriveDirection(legs)` already
returns the ORDER direction (SELL legs → SHORT = selling), which is what
`isBuyOrder` needs in SimBroker.

```diff
- const closeDirection: Direction = direction === 'LONG' ? 'SHORT' : 'LONG';
+ const closeDirection: Direction = direction;
```

This aligns `params.direction` with both SimBroker's `isBuyOrder()` AND
OrderManager's `firstLeg.action`, making chase and fill check convergent.

## Key Files

- `src/pipeline/execute-resolved.ts:398` — double-inversion of close direction
- `src/pipeline/execute-resolved.ts:473` — per-signal SETTLED emitted before fill
- `src/backtest/sim-broker.ts:55-66` — isBuyOrder + shouldFillLimit
- `src/orders/order-manager.ts:147-155` — price chase uses firstLeg.action (correct)
- `src/orders/build-order-callbacks.ts:27-46` — deferred onFill callback
- `src/backtest/sim-broker.ts:96` — `EXECUTION_LOOKBACK_MINS = 5` (RC3)
- `src/backtest/sim-broker.ts:313-319` — immediate fill check rejects on stale data (RC3)

## Watch Out

- Fixing RC2 will change fill behavior for ALL close orders in backtest, not just
  the 5 stuck ones. The 23 "lucky" fills may get slightly different fill prices.
- The `direction` field on close orders is used by `recordTrade()` too
  (`execute-resolved.ts:421`). Changing it may affect PnL computation if
  `computeTradePnl` uses direction. Verify.
- Live runner (`src/live/runner.ts`) builds the same `ResolvedPipelineDeps` —
  the fix applies to both backtest and live.

## Verification

Run: `npx tsx scratchpad/verify-close-fail-root-causes.ts`
