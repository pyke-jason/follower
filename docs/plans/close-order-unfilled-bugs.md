# Fix: Close Orders Getting Zero Tick Evaluations + Silent Timeline Failures

## Problem

A stock close order (SELL limit $333.28 on MSTR, SIM-115) never filled despite being pennies from the bid. Two compounding bugs:

1. **Structural backtest gap**: The backtest is event-driven — time only advances on tradable messages. Close orders placed during `processMessage()` get zero tick evaluations AND zero price-chase steps if no tradable message follows on the same day. The order sits inert until day boundary kills it.

2. **Silent failure in timeline**: When a close order is cancelled at day boundary, no event is emitted. The premature `SETTLED FAIL` is hidden by timeline filtering. The user sees ORDER_PLACED (green) with no indication it never filled.

## Root Cause (Confirmed via Data)

SIM-115 was placed at Sep 16 3:23 PM ET. The next **tradable** message was Sep 17 1:55 PM (Pete, CAT). There were non-tradable messages (commentary) in between, but the runner's `tradableMessages` filter excludes those.

- **Zero ticks replayed** against SIM-115 (confirmed: no ORDER_ADJUSTED events)
- **Zero price-chase steps** fired (chase runs in `orderManager.tick()`, which only fires per tradable message)
- Day boundary cancelled the order before `advanceTo()` ran for the new day
- Trade stayed open 13 extra days, turning ~$0.52/share profit into $15.21/share loss
 
## Sequence of Events (Current)

```
Message N (Sep 16 3:23 PM) — CLOSE signal:
  1. advanceTo(3:23 PM)        → ticks replayed BEFORE order exists
  2. orderManager.tick(3:23 PM) → no working orders yet
  3. processMessage()           → close order SIM-115 placed (status: OPEN)
  4. SETTLED emitted immediately with outcome: FAIL (premature — order is still working)

Message N+1 (Sep 17 1:55 PM) — next tradable message (18h gap):
  1. Day boundary detected (Sep 16 → Sep 17)
  2. broker.cancelOrder(SIM-115) — cancelled directly
  3. orderManager.tick()         → detects CANCELLED, calls onCancel (just deletes pendingIntent)
  4. advanceTo(Sep 17)           → order already gone, Sep 16 afternoon ticks never checked
```

**Result**: Order had exactly one chance — immediate fill at placement — and missed because limit ($333.28) was pennies above bid. The price chase would have easily closed the gap, but it never fired.

---

## Fix A: Advance to Market Close Before Day Boundary Cancellation

**File**: `src/backtest/runner.ts` (lines 291–319)

Before cancelling stale close orders, advance the broker to market close of the *previous* day. This gives working orders a final tick evaluation + price-chase window. This isn't an edge case — it affects any close order placed after the last same-day tradable message.

```typescript
// ── Day boundary: advance to market close FIRST, then cancel stale orders ──
if (lastMsgDay && msgDay !== lastMsgDay) {
  log.info(`Day ${lastMsgDay} → ${msgDay}`);

  // Give working orders a final chance to fill against remaining intraday ticks.
  // The backtest is event-driven (time only moves on tradable messages), so orders
  // placed during the last message of the day get zero tick evaluations without this.
  const prevDayClose = marketCloseUTC(parseDateKey(lastMsgDay));
  await broker.advanceTo(prevDayClose);
  await orderManager.tick(prevDayClose);

  // NOW cancel unfilled close orders (they persisted through EOD without filling)
  const workingOrders = orderManager.getWorkingOrders();
  // ... existing cancellation logic ...
}
```

**Import needed**: `marketCloseUTC` from `src/lib/et-date.ts`.

**Side fix**: Line 345 hardcodes `T20:00:00Z` for MTM snapshots. Replace with `marketCloseUTC()` for EDT correctness:
```typescript
// Before:
const eodTime = new Date(lastMsgDay + 'T20:00:00Z');
// After:
const eodTime = marketCloseUTC(parseDateKey(lastMsgDay));
```

**Safety**: `advanceTo()` is idempotent — replays ticks from `lastAdvanceTime` to the new time, then updates `lastAdvanceTime`. If already advanced past market close (multiple same-day messages), the tick window is empty (no-op).

**Price chase in the same pass**: `orderManager.tick(prevDayClose)` runs after `advanceTo()`. It batch-applies all pending chase steps (elapsed time / intervalSec), then the NEXT `advanceTo()` in the normal message loop checks at the updated limit. But since we're at EOD, there's no next advanceTo for the same day. However, the tick() call itself checks fill status first (line 80-103 in order-manager.ts) — if advanceTo filled the order, tick() detects it. If not, tick() chases the price, but there are no more ticks to check against.

**To handle the chase→fill gap**: We could loop `advanceTo(prevDayClose) + tick()` twice — first pass replays ticks at original limit, tick() chases, second pass replays... but `advanceTo` already consumed the ticks (lastAdvanceTime updated). A cleaner approach: make `advanceTo()` internally run the OrderManager's tick at intermediate timestamps within the replay window. But that's a bigger refactor.

**Pragmatic approach**: A single `advanceTo(prevDayClose)` + `tick(prevDayClose)` will fill orders where the original limit was already fillable against intraday ticks (the MSTR case — limit was $333.28, stock was ~$333.25, ticks almost certainly crossed $333.28 in the remaining 37 minutes). For orders that need chase to fill, the single pass won't help. This covers the common case; the chase gap is a known limitation we can revisit.

---

## Fix B: Emit ORDER_CANCELLED Event

### B1. Make `onCancel` async in OrderManager

**File**: `src/orders/order-manager.ts`

`onCancel` is currently sync (`(order: WorkingOrder) => void`). Change to async and await the calls:

```typescript
// Type change:
onCancel?: (order: WorkingOrder) => void | Promise<void>;

// Lines 104-110 and 118-122: await the calls
await this.onCancel?.(order);
```

`onFill` is already async and awaited, so the pattern exists.

### B2. Backtest runner `onCancel` callback

**File**: `src/backtest/runner.ts` (lines 218–220)

```typescript
// Before:
onCancel: (order) => {
  pendingIntents.delete(order.orderId);
},

// After:
onCancel: async (order) => {
  const pending = pendingIntents.get(order.orderId);
  if (pending) {
    const emitter = createEmitter({ messageId: pending.messageId ?? '', backtestRunId: runId });
    await emitter.emit('ORDER_CANCELLED', {
      orderId: order.orderId,
      symbol: order.params.symbol,
      strategy: order.params.strategy,
      direction: order.params.direction,
      originalLimitPrice: order.params.limitPrice,
      finalLimitPrice: order.currentLimitPrice,
      adjustmentCount: order.adjustmentCount,
      reason: order.status,  // 'CANCELLED' or 'REJECTED'
      placedAt: order.placedAt.toISOString(),
    }, { signalIndex: pending.signalIndex ?? null });
    pendingIntents.delete(order.orderId);
  }
},
```

### B3. Live runner `onCancel` callback

**File**: `src/tasks/runner.ts` — apply same pattern for live parity.

---

## Fix C: Timeline Display

### C1. Add ORDER_CANCELLED to timeline

**File**: `web/app/components/decision-timeline.tsx`

```typescript
// EVENT_LABEL (line 21-25)
ORDER_CANCELLED: 'CANCELLED',

// DOT colors (line 36-45) — use red/clay
ORDER_CANCELLED: 'bg-[oklch(0.55_0.15_25)]',  // clay/red

// eventOrder (line 238-242)
ORDER_CANCELLED: 5,  // after ORDER_ADJUSTED, before SETTLED
```

### C2. Add OrderCancelledView to snapshot detail

**File**: `web/app/components/snapshot-detail.tsx`

Add a view in `SnapshotDispatch`:
```typescript
case 'ORDER_CANCELLED': return <OrderCancelledView data={snap} />;
```

Display: orderId, symbol, original limit → final limit (after chase), adjustment count, reason.

### C3. Fix aggressive SETTLED FAIL filtering

**File**: `web/app/components/decision-timeline.tsx` (line 250)

Current logic hides ALL `SETTLED FAIL` when the trade has an OPEN action. This hides failed close attempts too.

```typescript
// Before:
if (event === 'SETTLED' && d.outcome === 'FAIL' && tradeActionSet.has('OPEN')) continue;

// After: Hide SETTLED FAIL only when a more specific event already explains the outcome
if (event === 'SETTLED' && d.outcome === 'FAIL') {
  const sameSignal = (other: RunDecision) =>
    other.messageId === d.messageId && other.signalIndex === d.signalIndex;
  // Hide if ORDER_FILLED exists (deferred fill succeeded)
  if (filtered.some(o => o.event === 'ORDER_FILLED' && sameSignal(o))) continue;
  // Hide if ORDER_CANCELLED exists (it's more informative)
  if (filtered.some(o => o.event === 'ORDER_CANCELLED' && sameSignal(o))) continue;
}
```

---

## Fix Order

1. **Fix A** — advanceTo(EOD) before day boundary. Highest priority: fixes incorrect backtest PnL.
2. **Fix B1** — `onCancel` async in OrderManager. Required for B2.
3. **Fix B2** — Backtest runner emits ORDER_CANCELLED on cancel.
4. **Fix C1+C2** — Timeline renders the new event.
5. **Fix C3** — SETTLED FAIL filtering uses signal-level precision.
6. **Fix B3** — Live runner parity.

## Files Touched

| File | Change |
|---|---|
| `src/backtest/runner.ts` | advanceTo(EOD) before day boundary; onCancel emits event; EOD hardcode fix |
| `src/orders/order-manager.ts` | `onCancel` becomes async, await calls |
| `src/tasks/runner.ts` | onCancel emits event (live parity) |
| `web/app/components/decision-timeline.tsx` | Add ORDER_CANCELLED label/color/order; fix SETTLED filtering |
| `web/app/components/snapshot-detail.tsx` | Add OrderCancelledView |

## Watch Out

- `advanceTo(marketCloseUTC(...))` must happen BEFORE `autoCloseExpiring()` — expiring positions need to be auto-closed at their cutoff time (3:45/4:00 PM ET), which is at or before market close.
- `onCancel` becoming async: `OrderManager.tick()` already awaits `onFill`, same pattern.
- The EOD hardcode `T20:00:00Z` at line 345 is wrong during EDT (market close = 20:00 UTC only in EST). `marketCloseUTC()` handles DST.
- The single-pass advanceTo+tick covers the common case (limit already close to fillable). Orders needing multiple chase→tick→advanceTo cycles to fill won't benefit — this is a known limitation of the event-driven replay model, acceptable for now.
