# Fix: Close Orders Getting Zero Tick Evaluations + Silent Timeline Failures

## Problem

A stock close order (SELL limit $333.28 on MSTR) never filled despite being pennies from the bid. Two compounding bugs:

1. **Runner ordering bug**: Close orders placed during `processMessage()` get zero tick evaluations when the next tradable message is on a different day. Day boundary cancellation runs *before* `advanceTo()`, so remaining intraday ticks are never checked against working orders.

2. **Silent failure in timeline**: When a close order is cancelled at day boundary, no event is emitted. The premature `SETTLED FAIL` is hidden by timeline filtering. The user sees ORDER_PLACED (green) with no indication it never filled.

## Sequence of Events (Current)

```
Message N (Sep 16 3:23 PM) — CLOSE signal:
  1. advanceTo(3:23 PM)        → ticks replayed BEFORE order exists
  2. orderManager.tick(3:23 PM) → no working orders yet
  3. processMessage()           → close order SIM-115 placed (OPEN, not immediately filled)
  4. SETTLED emitted with outcome: FAIL (premature — order is still working)

Message N+1 (Sep 29) — next tradable message:
  1. Day boundary detected (Sep 16 → Sep 29)
  2. Close order SIM-115 CANCELLED  ← no event emitted
  3. orderManager.tick()            ← detects CANCELLED, calls onCancel (just deletes pendingIntent)
  4. advanceTo(Sep 29)              ← order already gone, remaining Sep 16 ticks wasted
```

**Result**: Order had exactly one chance to fill (immediate at placement) and missed by pennies. The 3:23 PM → 4:00 PM ET ticks were never evaluated.

---

## Fix A: Advance to Market Close Before Day Boundary Cancellation

**File**: `src/backtest/runner.ts` (lines 291–319)

Before cancelling stale close orders, advance the broker to market close of the *previous* day. This gives working orders a final tick evaluation window.

```typescript
// ── Day boundary: advance to market close FIRST, then cancel stale orders ──
if (lastMsgDay && msgDay !== lastMsgDay) {
  log.info(`Day ${lastMsgDay} → ${msgDay}`);

  // Give working orders a final chance to fill against remaining intraday ticks
  const eodTime = marketCloseUTC(parseDateKey(lastMsgDay));
  await broker.advanceTo(eodTime);
  await orderManager.tick(eodTime);

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

**Safety**: `advanceTo()` is safe to call multiple times — it replays ticks from `lastAdvanceTime` to the new time, then updates `lastAdvanceTime`. If already advanced past EOD (same-day messages), the tick window will be empty (no-op).

---

## Fix B: Emit ORDER_CANCELLED Event

### B1. Backtest runner `onCancel` callback

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

**Note**: `onCancel` type in `OrderManager` is currently sync (`(order: WorkingOrder) => void`). Needs to become async: `(order: WorkingOrder) => void | Promise<void>`. Check `order-manager.ts` lines 104–110 and 118–122 — the calls to `this.onCancel?.(order)` need to be awaited.

### B2. Live runner `onCancel` callback

**File**: `src/tasks/runner.ts` — apply same pattern (emit ORDER_CANCELLED event) for live order cancellations.

### B3. Day boundary explicit cancellation

**File**: `src/backtest/runner.ts` (lines 300–307)

The day boundary code calls `broker.cancelOrder()` directly, then `orderManager.tick()` detects the CANCELLED status and fires `onCancel`. However, add a log for traceability:

```typescript
if (wo.params.isClosing) {
  log.info(`Day boundary: cancelling unfilled close order ${wo.orderId} ${wo.params.symbol}`);
  await broker.cancelOrder(wo.orderId);
  // onCancel fires during next orderManager.tick() — emits ORDER_CANCELLED event
}
```

No additional changes here since `onCancel` now handles the event emission.

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

Display: orderId, symbol, original limit, final limit (after chase), adjustment count, reason.

### C3. Fix aggressive SETTLED FAIL filtering

**File**: `web/app/components/decision-timeline.tsx` (line 250)

Current logic hides ALL `SETTLED FAIL` when the trade has an OPEN action. This is too aggressive — it hides failed close attempts.

```typescript
// Before:
if (event === 'SETTLED' && d.outcome === 'FAIL' && tradeActionSet.has('OPEN')) continue;

// After: Only hide SETTLED FAIL for open signals (signalIndex-based), not close attempts
// A SETTLED FAIL for a close signal should remain visible (or be replaced by ORDER_CANCELLED)
if (event === 'SETTLED' && d.outcome === 'FAIL') {
  // Hide if this signal's order eventually filled (ORDER_FILLED exists for same message+signalIndex)
  const hasLaterFill = filtered.some(
    other => other.event === 'ORDER_FILLED'
      && other.messageId === d.messageId
      && other.signalIndex === d.signalIndex
  );
  if (hasLaterFill) continue;
  // Hide if ORDER_CANCELLED exists for the same signal (it's more informative)
  const hasCancelEvent = filtered.some(
    other => other.event === 'ORDER_CANCELLED'
      && other.messageId === d.messageId
      && other.signalIndex === d.signalIndex
  );
  if (hasCancelEvent) continue;
}
```

---

## Fix Order

1. **Fix A** (runner ordering) — highest priority, fixes incorrect backtest results
2. **Fix B1** (ORDER_CANCELLED in backtest runner) — observability
3. **Fix B3** (`onCancel` async signature) — required for B1
4. **Fix C1+C2** (timeline rendering) — display the new event
5. **Fix C3** (SETTLED filtering) — stop hiding legitimate failures
6. **Fix B2** (live runner) — parity

## Files Touched

| File | Change |
|---|---|
| `src/backtest/runner.ts` | advanceTo(EOD) before day boundary; onCancel emits event; EOD hardcode fix |
| `src/orders/order-manager.ts` | `onCancel` becomes async, await calls |
| `src/tasks/runner.ts` | onCancel emits event (live parity) |
| `web/app/components/decision-timeline.tsx` | Add ORDER_CANCELLED label/color/order; fix SETTLED filtering |
| `web/app/components/snapshot-detail.tsx` | Add OrderCancelledView |

## Watch Out

- `advanceTo(marketCloseUTC(...))` must happen BEFORE `autoCloseExpiring()` — expiring positions need to be auto-closed at their cutoff time (3:45 PM / 4:00 PM ET), which is before or at market close. The advance gives working orders a fill window, THEN expiry logic runs.
- `onCancel` becoming async: verify no callers assume sync. `OrderManager.tick()` already awaits `onFill`, so the pattern exists.
- The EOD hardcode `T20:00:00Z` at line 345 is only correct for EST. During EDT (Mar-Nov), market close is 20:00 UTC but the conversion is wrong. Use `marketCloseUTC()` which handles DST.
