# Backtest Accuracy: CLOSE Signal Not Executing

## Problem

When a trader posts a CLOSE message (e.g., "Exit PANW with $4.60 profit"), the backtest pipeline places a LIMIT CLOSE order at the spread midpoint. If the limit is not immediately within the spread, the order goes WORKING with a 60-second auto-cancel. In backtest, sim-time jumps discretely between messages — the next message arrives 139 seconds later, at which point the order is immediately cancelled without ever chasing. The position stays open until `sweepExpired()` closes it days later at intrinsic value.

**Concrete example** (backtest run `63945507-1de8-411a-aac2-fe1f74ec7f02`):

| Event | Timestamp | What happened |
|-------|-----------|---------------|
| OPEN msg `464943` | 2025-09-08 18:37 | "Long PANW $190 Calls 9/19 — for $8.65" → Trade opened at $8.65 x12 |
| CLOSE msg `465396` | 2025-09-10 13:46 | "Exit PANW with $4.60 profit per contract" → LIMIT CLOSE placed, not filled, auto-cancelled after 60s |
| sweepExpired | 2025-09-19 20:00 | Options expired ITM → closed at $18.19 intrinsic |

**Impact**: Backtest reports +$11,448 PnL on this trade. Real trader exited at +$4.60/contract. Backtest overstates returns by ignoring exit signals.

## Root Cause Analysis

### The complete execution path

1. **Phase 2 replay** (`runner.ts:361-449`): Message `465396` is processed at sim-time `2025-09-10T13:46:xx`.

2. **Pipeline `executeClose()`** (`execute.ts:374-438`):
   - Finds the open PANW position (entry $8.65, 12 contracts)
   - Reverses legs: BUY → SELL for the closing order
   - Calls `getSpreadMidpoint()` (line 397) → gets a limit price from current bid/ask
   - Calls `buildOrderParams()` (line 398) → creates LIMIT order with `cancelAfterSec: 60` (from `ORDER_DEFAULTS.CALL`, line 88)
   - Calls `placeOrder()` (line 425) → submits to broker

3. **`SimBroker.placeOrder()`** (`sim-broker.ts:269-306`):
   - LIMIT order: fetches current spread quote via `getOptionSpreadQuote()` (line 279)
   - Checks `shouldFillLimit(isBuy=false, limitPrice, bid, ask)` — SELL fills when `limit <= bid`
   - If midpoint > bid (very common for options spreads), the order does NOT fill
   - Returns `{ orderId, status: 'OPEN' }` — order is now working

4. **Working order lifecycle**:
   - Order registered with `OrderManager` via `onPending` (line 290-291)
   - Order has `adjustmentRules: [{ type: 'PRICE_CHASE', stepAmount: 0.10, intervalSec: 5 }]`
   - Order has `cancelAfterSec: 60`

5. **Runner proceeds to next message** (`runner.ts:395-397`):
   - `clock.advance(nextMsg.timestamp)` — sim clock jumps to 13:49:06 (+139s)
   - `broker.advanceTo(13:49:06)` — replays OCC ticks from 13:46 to 13:49. If ANY tick exists where the limit fills, order fills here. But if no tick data exists (OPRA coverage gap) or spread never crossed, order stays WORKING.
   - `orderManager.tick(13:49:06)` — runs the lifecycle check:
     - Step 1 (line 79): `getOrderStatus()` — if `advanceTo` filled it, sees FILLED, processes callback. Done.
     - Step 2 (line 111): Cancel check — elapsed = 139s > 60s → **auto-cancels immediately**
     - Step 3 (line 126): Chase adjustment — **never reached** because cancel fired first

6. **The chase never fires**: In backtest, `orderManager.tick()` is called once per message. If the message gap exceeds `cancelAfterSec` (60s), the cancel fires on the very first tick after order placement. The `PRICE_CHASE` adjustment rules at step 3 never execute because the cancel at step 2 already removed the order. **The existing chase mechanism is completely inert for any inter-message gap > 60 seconds.**

7. **No retry**: `onCancel` (runner.ts:220-222) simply deletes the pending context from the map. No retry, no fallback. The close is lost forever.

8. **sweepExpired** closes the position at expiry, days later, at intrinsic value with no `closeMessageId`.

### Why MARKET orders are NOT the fix

The previous version of this plan proposed using MARKET orders for all CLOSE/TRIM/LEG_OFF signals. This is wrong for options because:

- **Options have massive bid-ask spreads.** A $10 option might have a $9.00 bid / $11.00 ask. The fill model (ORATS 75%) would give a SELL fill at $ask - 0.75*(ask-bid) = $11.00 - $1.50 = $9.50`. A midpoint LIMIT would get $10.00 — that is $0.50/contract better on a 12-contract position = $600 of simulated PnL difference.
- **Real traders use LIMIT orders** on options. Switching to MARKET misrepresents what actually happens.
- **The fill model's "slippage" is optimized for OPEN orders**, not closes. Using it for closes overstates execution cost.

The problem is not the order type — it is the cancel timeout killing the order before it can fill.

## Proposed Fix: Aggressive Chase, No Cancel for Position-Reducing Orders

### Design

For **position-reducing orders** (CLOSE, TRIM, LEG_OFF):

1. **Remove `cancelAfterSec`** — these orders persist until filled or end-of-day
2. **Aggressive chase** — use the existing `PRICE_CHASE` mechanism with wider steps and more steps
3. **Guarantee fill via `advanceTo` integration** — `advanceTo()` already replays ticks and checks fills for working orders; it just needs the order to still be alive

### Why this works in backtest

The key insight is that `advanceTo()` (sim-broker.ts:749-843) already handles working order fills correctly:

1. For each message, `advanceTo(nextMsgTime)` replays all ticks between the last advance time and the new time
2. For option orders, it fetches `getOptionSpreadQuote()` at each tick timestamp and checks `shouldFillLimit()`
3. As the chase widens the limit, the chance of filling on the next `advanceTo()` pass increases
4. The fallback at line 826-838 re-quotes at target time — so even if no intermediate ticks exist, the order gets checked at every message time

The current problem is that the order gets cancelled before `advanceTo()` has a chance to check it on the NEXT message. By removing the cancel and keeping the chase, the order survives across messages and `advanceTo()` eventually fills it.

### Timing interaction: tick() vs advanceTo()

Per-message flow (`runner.ts:395-397`):
```
clock.advance(msg.timestamp)      // jump sim clock
broker.advanceTo(msg.timestamp)   // replay ticks → may fill working orders
orderManager.tick(msg.timestamp)  // check fills → chase adjustments
```

For a surviving CLOSE order across 3 messages:
```
T0: CLOSE LIMIT placed at mid=$10.00, not filled (mid > bid)
    → order WORKING

T1 (T0+139s): advanceTo(T1) replays ticks → no fill in ticks
              tick(T1): getOrderStatus = OPEN
                        chase: 139s / 5s = 27 steps possible, but capped by maxSteps
                        e.g., 12 steps * $0.15 = $1.80 price movement
                        new limit = $10.00 - $1.80 = $8.20 (closer to bid)

T2 (T1+45s):  advanceTo(T2) replays ticks → checks limit $8.20 vs spread at each tick
              If bid >= $8.20 at any tick → FILLS with price improvement
              tick(T2): if still OPEN, chase again → further adjustment
```

### Interaction with `shouldFillLimit` and price improvement

`shouldFillLimit` for SELL: `limitPrice <= bid` (sim-broker.ts:65)

The chase moves SELL limits DOWN (order-manager.ts:141-143). A lower sell limit is more aggressive — you are willing to sell for less. Once the limit drops to or below the bid, the order fills.

`fillWorkingOrder` (sim-broker.ts:191-211) gives price improvement: `max(limitPrice, bid)`. So even if the limit chases well below the bid, the fill price is the actual bid — the trader doesn't get a worse price than the market offers.

### End-of-day backstop

Position-reducing orders without `cancelAfterSec` need a backstop. Two options:

**Option A (recommended): Cancel at market close.** Add logic in the runner's day-boundary code to cancel any surviving CLOSE/TRIM/LEG_OFF working orders before processing the next day. This mirrors real market behavior — unfilled GTC orders would be re-evaluated daily.

**Option B: Cancel after very long timeout (e.g., end of trading day).** Set `cancelAfterSec` to the number of seconds until market close. More complex to compute.

Option A is simpler and more realistic.

## Implementation Plan

### Step 1: Add close-specific order defaults in `execute.ts` (10 min)

File: `src/pipeline/execute.ts`, lines 86-92

Add a separate configuration for position-reducing orders:

```typescript
const ORDER_DEFAULTS: Record<string, { stepAmount: number; intervalSec: number; cancelAfterSec: number }> = {
  STOCK: { stepAmount: 0.03, intervalSec: 5, cancelAfterSec: 60 },
  CALL:  { stepAmount: 0.10, intervalSec: 5, cancelAfterSec: 60 },
  PUT:   { stepAmount: 0.10, intervalSec: 5, cancelAfterSec: 60 },
  CDS:   { stepAmount: 0.05, intervalSec: 5, cancelAfterSec: 60 },
  PDS:   { stepAmount: 0.05, intervalSec: 5, cancelAfterSec: 60 },
};

/** Position-reducing orders: wider steps, no auto-cancel (cancelled at day boundary). */
const CLOSE_ORDER_DEFAULTS: Record<string, { stepAmount: number; intervalSec: number }> = {
  STOCK: { stepAmount: 0.05, intervalSec: 5 },
  CALL:  { stepAmount: 0.15, intervalSec: 5 },
  PUT:   { stepAmount: 0.15, intervalSec: 5 },
  CDS:   { stepAmount: 0.10, intervalSec: 5 },
  PDS:   { stepAmount: 0.10, intervalSec: 5 },
};
```

Rationale for wider steps:
- OPEN orders want the best possible entry → small steps, patience
- CLOSE orders want guaranteed execution → wider steps, chase quickly to fill
- CALL/PUT: $0.15/step vs $0.10 = 50% more aggressive. Over 12 steps ($1.80 price movement) this covers most option spreads.
- No `cancelAfterSec` → order persists across messages

### Step 2: Modify `buildOrderParams` for close actions (5 min)

File: `src/pipeline/execute.ts`, function `buildOrderParams` (line 246)

Change the signature to accept the action:

```typescript
function buildOrderParams(
  signal: Signal,
  legs: OrderLeg[],
  limitPrice?: number,
  isPositionReducing?: boolean,
): WorkingOrderParams {
  const isClose = isPositionReducing ?? false;
  const defaultsTable = isClose ? CLOSE_ORDER_DEFAULTS : ORDER_DEFAULTS;
  const defaults = defaultsTable[signal.strategy] ?? defaultsTable.STOCK;

  const adjustmentRules: AdjustmentRule[] = limitPrice
    ? [{ type: 'PRICE_CHASE', stepAmount: defaults.stepAmount, intervalSec: defaults.intervalSec }]
    : [];

  return {
    symbol: signal.symbol,
    strategy: signal.strategy,
    direction: signal.direction,
    legs,
    orderType: limitPrice ? 'LIMIT' : 'MARKET',
    limitPrice,
    adjustmentRules: adjustmentRules.length > 0 ? adjustmentRules : undefined,
    // Position-reducing orders: no cancel timeout (cancelled at day boundary instead)
    cancelAfterSec: limitPrice && !isClose
      ? (ORDER_DEFAULTS[signal.strategy] ?? ORDER_DEFAULTS.STOCK).cancelAfterSec
      : undefined,
  };
}
```

### Step 3: Update `executeClose`, `executeTrim`, `executeLegOff` (5 min)

In each of the three functions, pass `isPositionReducing: true` to `buildOrderParams`:

**`executeClose`** (line 398):
```typescript
const params = buildOrderParams(
  { ...signal, direction: closeDirection, strategy: existing.strategy },
  legs,
  mid,
  true, // position-reducing: no cancel timeout, wider chase
);
params.isClosing = true;
```

**`executeTrim`** (line 550):
```typescript
const params = buildOrderParams(
  { ...signal, direction: closeDirection, strategy: existing.strategy },
  legs,
  mid,
  true,
);
params.isClosing = true;
```

**`executeLegOff`** (line 625):
```typescript
const params = buildOrderParams(
  { ...signal, direction: 'LONG' as const, strategy: existing.strategy },
  closingLegs,
  mid,
  true,
);
params.isClosing = true;
```

### Step 4: Fix `OrderManager.tick()` chase step count for time gaps (10 min)

File: `src/orders/order-manager.ts`, lines 126-151

The current chase logic applies ONE step per `tick()` call if `sinceLastAdj >= intervalSec`. In backtest, where `tick()` is called once per message (potentially minutes apart), this means only one chase step per message — not proportional to elapsed time.

Fix: compute how many steps should have fired based on elapsed time, and apply them all:

```typescript
// 3. Check adjustment rules (PRICE_CHASE)
if (order.params.adjustmentRules) {
  for (const rule of order.params.adjustmentRules) {
    if (rule.type !== 'PRICE_CHASE') continue;

    const sinceLastAdj = (now.getTime() - order.lastAdjustedAt.getTime()) / 1000;
    if (sinceLastAdj < rule.intervalSec) continue;

    // Compute how many steps elapsed since last adjustment
    const stepsElapsed = Math.floor(sinceLastAdj / rule.intervalSec);
    const remainingSteps = rule.maxSteps != null
      ? Math.max(0, rule.maxSteps - order.adjustmentCount)
      : stepsElapsed;
    const stepsToApply = Math.min(stepsElapsed, remainingSteps);
    if (stepsToApply <= 0) continue;

    const firstLeg = order.params.legs[0];
    if (!firstLeg) {
      throw new Error(`Working order ${orderId} has no legs — cannot determine price chase direction`);
    }
    const isBuy = firstLeg.action === 'BUY';
    const totalMovement = stepsToApply * rule.stepAmount;
    const newPrice = isBuy
      ? order.currentLimitPrice + totalMovement
      : order.currentLimitPrice - totalMovement;

    const roundedPrice = roundCents(newPrice);
    log.debug(`Price chase: ${orderId} ${isBuy ? 'BUY' : 'SELL'} $${order.currentLimitPrice} -> $${roundedPrice} (${stepsToApply} steps, total ${order.adjustmentCount + stepsToApply}/${rule.maxSteps ?? '∞'})`);
    await this.broker.modifyOrder(orderId, roundedPrice);
    order.currentLimitPrice = roundedPrice;
    order.lastAdjustedAt = now;
    order.adjustmentCount += stepsToApply;
  }
}
```

**This is the most critical fix.** Without batch-applying elapsed steps, the chase only moves $0.15 per message regardless of time gap. With batch application, a 139-second gap produces `floor(139/5) = 27` potential steps, capped by `maxSteps` if set.

### Step 5: Add maxSteps to CLOSE_ORDER_DEFAULTS (2 min)

Without `cancelAfterSec`, we need `maxSteps` to prevent the chase from going to absurd prices:

```typescript
const CLOSE_ORDER_DEFAULTS: Record<string, { stepAmount: number; intervalSec: number; maxSteps: number }> = {
  STOCK: { stepAmount: 0.05, intervalSec: 5, maxSteps: 24 },  // max movement: $1.20
  CALL:  { stepAmount: 0.15, intervalSec: 5, maxSteps: 20 },  // max movement: $3.00
  PUT:   { stepAmount: 0.15, intervalSec: 5, maxSteps: 20 },  // max movement: $3.00
  CDS:   { stepAmount: 0.10, intervalSec: 5, maxSteps: 20 },  // max movement: $2.00
  PDS:   { stepAmount: 0.10, intervalSec: 5, maxSteps: 20 },  // max movement: $2.00
};
```

And pass `maxSteps` into the adjustment rule:

```typescript
const adjustmentRules: AdjustmentRule[] = limitPrice
  ? [{
    type: 'PRICE_CHASE',
    stepAmount: defaults.stepAmount,
    intervalSec: defaults.intervalSec,
    maxSteps: 'maxSteps' in defaults ? (defaults as any).maxSteps : undefined,
  }]
  : [];
```

After `maxSteps` is exhausted (price has moved $3.00 from mid), the order stays working but stops chasing. It can still fill via `advanceTo()` if the market moves to meet the (now very aggressive) limit. If it never fills, the day-boundary cleanup handles it.

### Step 6: Day-boundary cleanup in runner.ts (10 min)

File: `src/backtest/runner.ts`, in the day-boundary block (lines 366-392)

After sweeping expired options and before the MTM snapshot, cancel any surviving position-reducing working orders:

```typescript
if (lastMsgDay && msgDay !== lastMsgDay) {
  log.info(`Day ${lastMsgDay} → ${msgDay}`);
  const openCount = await broker.getOpenPositionCount();
  if (openCount > 0) {
    // 0. Cancel surviving close/trim working orders from previous day
    //    These orders had all day to fill; if they didn't, the position
    //    stays open (matches real market behavior for unfilled day orders).
    const workingOrders = orderManager.getWorkingOrders();
    for (const wo of workingOrders) {
      if (wo.params.isClosing && wo.status === 'OPEN') {
        log.info(`Day boundary: cancelling unfilled close order ${wo.orderId} ${wo.params.symbol}`);
        await broker.cancelOrder(wo.orderId);
        pendingIntents.delete(wo.orderId);
      }
    }
    // Tick the order manager so it processes the cancellations
    await orderManager.tick(clock.now());

    // 1. Sweep expired options (existing code)
    const expiredCount = await broker.sweepExpired(lastMsgDay);
    // ... rest of existing day-boundary code
  }
}
```

### Step 7: Pass `messageTimestamp` to pipeline opts (2 min)

File: `src/backtest/runner.ts`, lines 689-694

Add `messageTimestamp` so pipeline can use correct reference date for expiry inference:

```typescript
{
  messageId: msg.id,
  messageTimestamp: msg.timestamp.toISOString(),
  backtestRunId: btCtx.runId,
  isBacktest: true,
  allowedStrategies,
}
```

## Chase Behavior Summary

### For OPEN/ADD orders (unchanged):
| Parameter | STOCK | CALL/PUT | CDS/PDS |
|-----------|-------|----------|---------|
| stepAmount | $0.03 | $0.10 | $0.05 |
| intervalSec | 5 | 5 | 5 |
| cancelAfterSec | 60 | 60 | 60 |
| maxSteps | none | none | none |
| Max price movement | $0.36/60s | $1.20/60s | $0.60/60s |

### For CLOSE/TRIM/LEG_OFF orders (new):
| Parameter | STOCK | CALL/PUT | CDS/PDS |
|-----------|-------|----------|---------|
| stepAmount | $0.05 | $0.15 | $0.10 |
| intervalSec | 5 | 5 | 5 |
| cancelAfterSec | none | none | none |
| maxSteps | 24 | 20 | 20 |
| Max price movement | $1.20 | $3.00 | $2.00 |
| Effective timeout | EOD | EOD | EOD |

### Worked example: PANW CLOSE with new behavior

```
T0 (13:46:07): CLOSE LIMIT SELL at mid=$13.25 (bid=$12.50, ask=$14.00)
               shouldFillLimit(isBuy=false, 13.25, 12.50, 14.00) → 13.25 > 12.50 → NO FILL
               Order WORKING, no cancelAfterSec

T1 (13:49:06, +139s): advanceTo() replays ticks from 13:46 to 13:49
                       Let's say no OCC ticks or spread didn't cross
                       Fallback: re-quote at 13:49 → still bid=$12.50
                       tick(): steps = floor(139/5) = 27, capped at maxSteps=20
                       New limit = $13.25 - (20 * $0.15) = $13.25 - $3.00 = $10.25
                       modifyOrder(orderId, $10.25)

T2 (next msg): advanceTo() checks limit $10.25 vs spread
               shouldFillLimit(isBuy=false, 10.25, 12.50, 14.00) → 10.25 < 12.50 → FILLS
               fillWorkingOrder: improved price = max(10.25, 12.50) = $12.50 (the bid)
               Fill at $12.50 — realistic market price, not the absurd limit
```

Result: Position closes at $12.50 (the bid), which is far better than the current behavior of holding to expiry at $18.19 intrinsic. The fill price is realistic — it is the actual bid at the time of fill.

## Edge Cases

### 1. Chase exhausts maxSteps but order never fills
Order stays working at the chased-down limit until day boundary cleanup. At day boundary, the order is cancelled and the position stays open — same as current behavior, but with many more fill opportunities before giving up.

### 2. Multiple CLOSE signals for same position
First CLOSE places the working order. Second CLOSE (if it arrives before fill) finds position still open via `findPosition()`. Pipeline places a second working order. Both chase independently; whichever fills first closes the position. The second order becomes orphaned (position gone). `advanceTo()` may try to fill it but `recordFill` will find the trade already closed → `recordTrade` returns null (handled gracefully).

Actually, this is a potential issue. If `findPosition()` succeeds because the position is still open, two competing CLOSE orders exist. Fix: in `findPosition()` for CLOSE actions, also check if there is already a pending CLOSE working order for this symbol. This is a pre-existing issue (not introduced by this change) and can be addressed separately.

### 3. Inter-message gap shorter than intervalSec
If messages arrive faster than 5s apart, no chase steps fire — the order just gets checked via `advanceTo()` at each message. This is fine; frequent messages mean frequent `advanceTo()` calls which provide more fill opportunities.

### 4. STOCK CLOSE orders
Stock spreads are much tighter. The midpoint is usually within the spread, so the order fills immediately. The chase only matters for options where bid-ask spreads are wide. Stock CLOSE orders are unaffected by this change in practice.

### 5. Live path impact
`executeClose/executeTrim/executeLegOff` are shared between backtest and live. Changes:
- No `cancelAfterSec` for live CLOSE orders too. This is actually better for live — a 60s cancel on a CLOSE order with TradeStation is risky (same problem as backtest: order dies, position stays open).
- Live `OrderManager` uses `manualTick: false` (wall-clock timer at 1s intervals), so chase steps fire every 5 real seconds. The batch-step fix in Step 4 has no effect (each tick is ~1s apart).
- **Safe to apply to live.** Position-reducing orders with aggressive chase and no cancel timeout is standard practice in production trading systems.

### 6. advanceTo() performance with persistent working orders
If a CLOSE order survives across many messages (worst case: all day), `advanceTo()` replays ticks for its symbols on every message. This is already the case for OPEN working orders; the code handles it efficiently (early exit when no working orders, line 752-754). Persistent CLOSE orders do add some I/O, but this is rare (most closes should fill within a few messages once the chase kicks in).

## Files Changed

| File | Change |
|------|--------|
| `src/pipeline/execute.ts` | Add `CLOSE_ORDER_DEFAULTS`, modify `buildOrderParams` to accept `isPositionReducing`, pass `true` from `executeClose`/`executeTrim`/`executeLegOff` |
| `src/orders/order-manager.ts` | Batch-apply chase steps based on elapsed time (not one step per tick) |
| `src/backtest/runner.ts` | Day-boundary cleanup for surviving close working orders; pass `messageTimestamp` to pipeline opts |

## Verification

After implementing, re-run the PANW backtest and verify:

```sql
-- PANW trade should now be closed by message, not sweepExpired
SELECT id, close_message_id, closed_at, exit_price, pnl
FROM trades
WHERE backtest_run_id = '<new_run_id>'
  AND symbol = 'PANW';

-- Exit price should be near the bid at time of fill, not $18.19 intrinsic
-- closed_at should be 2025-09-10, not 2025-09-19

-- Check ALL close events: how many have closeMessageId now vs before?
SELECT
  COUNT(*) as total_closes,
  COUNT(close_message_id) as with_message,
  COUNT(*) - COUNT(close_message_id) as without_message
FROM trades
WHERE backtest_run_id = '<new_run_id>'
  AND status = 'closed';
```

## Alternatives Considered

### A. MARKET orders for all CLOSE/TRIM/LEG_OFF
**Rejected.** Options have massive bid-ask spreads. MARKET fills use the fill model (ORATS 75% of spread width), which penalizes the seller. On a $2.00 spread, MARKET vs midpoint LIMIT = ~$0.50/contract difference. For a 12-contract position, that is $600 of simulated PnL error. The whole point of the backtest is accurate fill simulation.

### B. Remove cancelAfterSec but keep single-step chase
**Partially rejected.** Removing the cancel is necessary, but without batch-stepping (Step 4), the chase only moves one step per message. If messages are 2+ minutes apart, the chase would take 20+ messages to exhaust maxSteps. Batch-stepping ensures the chase catches up to elapsed time on each tick.

### C. Re-submit as MARKET after cancel (previous Option C)
**Rejected.** Adds complexity to `OrderManager.onCancel`. The cancel callback runs asynchronously from the pipeline and doesn't have the context to resubmit. Requires passing pipeline deps through the callback chain — bad separation of concerns.

### D. Increase cancelAfterSec to a very large value (e.g., 3600)
**Rejected.** This is semantically wrong. A 1-hour timeout is arbitrary and still fails if the market is illiquid all day. "Cancel at day boundary" (Step 6) is the correct semantic equivalent of a day order.
