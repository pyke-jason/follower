# Investigation: Bogus ADD Events in Backtest Trades

**Date**: 2026-02-28
**Trade ID**: e7ef822a-b15d-4a0a-b7a0-5cb1b9f0972c
**Backtest run**: 0857735f-b293-474d-a54b-4f9a11722b43

## Summary

A CLOSED AAPL LONG STOCK backtest trade shows a bogus ADD event with $0.00 price and
a wall-clock timestamp (Feb 28 / Mar 1 2026) instead of the September 2025 backtest
timestamp. This corrupts the trade's entry_price and inflates PnL by ~$234.82 per trade.
The bug affects 8 trades across 8 different backtest runs, all triggered by the same
"Added" message for AAPL.

## Evidence

### The three events for this trade (ordered by created_at):

```sql
SELECT action, price, quantity, message_id, timestamp, created_at
FROM trade_events
WHERE trade_id = 'e7ef822a-b15d-4a0a-b7a0-5cb1b9f0972c'
ORDER BY created_at;
```

| action | price  | qty | message_id | timestamp                | created_at               |
|--------|--------|-----|------------|--------------------------|--------------------------|
| OPEN   | 234.82 | 1   | 463548     | 2025-09-03T13:44:19.000Z | 2026-03-01T02:15:41.170Z |
| ADD    | 0      | 1   | (null)     | 2026-03-01T02:15:41.176Z | 2026-03-01T02:15:41.176Z |
| CLOSE  | 235.76 | 2   | 463555     | 2025-09-03T13:55:00.000Z | 2026-03-01T02:15:41.182Z |

The ADD event has:
- **price = 0** (should be ~$234.83, the SimBroker fill price)
- **message_id = NULL** (should be '463550')
- **timestamp = wall-clock time** (should be 2025-09-03T13:45:31.000Z from the message)

### Corrupted trade state:

```sql
SELECT entry_price, avg_entry_price, quantity, pnl, exit_price
FROM trades WHERE id = 'e7ef822a-b15d-4a0a-b7a0-5cb1b9f0972c';
```

| entry_price | avg_entry_price | quantity | pnl   | exit_price |
|-------------|-----------------|----------|-------|------------|
| 117.41      | 117.41          | 2        | 236.7 | 235.76     |

- **Correct avg entry**: ~$234.82 (midpoint of 234.82 and fill price near 234.83)
- **Correct PnL**: ~$1.88 (2 shares x ~$0.94 gain)
- **Actual PnL**: $236.70 -- **inflated by ~$234.82** (the stock price itself)

### Scope: 8 backtest runs affected

```sql
SELECT te.trade_id, t.backtest_run_id, te.price, te.timestamp
FROM trade_events te
JOIN trades t ON te.trade_id = t.id
WHERE te.action = 'ADD' AND t.is_backtest = 1 AND te.price = '0' AND te.message_id IS NULL;
```

All 8 are AAPL trades triggered by message 463550:
"Added - $234.83 avg now, 1,500 Shares (AAPL)"

All 8 have identical corruption: entry_price=117.41, pnl=236.70.

### Legitimate ADD events exist (for comparison)

The WBD ADD events (message_id=467864, price=0.61) and other ADD events have correct
prices, message IDs, and backtest-era timestamps. These go through the OPEN path
correctly because the orchestrator resolved them without setting tradeId, or the
executor handles them as new OPENs that recordTrade then derives as ADDs.

## Root Cause

**Three cascading bugs in `execute-resolved.ts` + `record-trade.ts`:**

### Bug 1: `execute-resolved.ts` treats ADD signals as position-reducing (line 292)

```typescript
// src/pipeline/execute-resolved.ts:292
const isPositionReducing = !!signal.tradeId;
```

The `resolveAddPath()` in `open-path.ts` (line 619) stamps `signal.tradeId` on ADD signals
so `recordTrade` knows which trade to target. But `executeResolvedSignal` interprets
ANY signal with `tradeId` as position-reducing (CLOSE/TRIM), routing it through the
position-reducing code path.

The position-reducing `recordFill` callback (lines 400-423) passes:
- `exitPrice: fp` instead of `entryPrice: fp`
- `closedAt: fa?.toISOString()` instead of `openedAt: fa?.toISOString()`
- `closeMessageId: messageId` instead of `sourceMessageId: messageId`
- `action: 'CLOSE'` instead of the needed `action: 'ADD'`

### Bug 2: `record-trade.ts` ADD path reads wrong fields (lines 349-357)

When `deriveActionFromLegs` correctly overrides the caller's action to `'ADD'`, the ADD
code path reads:
- `entryPrice ?? 0` -- but caller only set `exitPrice` -> **price = 0**
- `openedAt ?? now` -- but caller only set `closedAt` -> **timestamp = wall-clock**
- `sourceMessageId` -- but caller only set `closeMessageId` -> **message_id = null**

```typescript
// src/trades/record-trade.ts:349-357
if (effectiveAction === 'ADD') {
    const addQty = quantity ?? 1;
    const addPrice = entryPrice ?? 0;        // <-- BUG: exitPrice was passed, not entryPrice
    // ...
    const ts = openedAt ?? now;               // <-- BUG: closedAt was passed, not openedAt
    await emitEvent({
      // ...
      messageId: sourceMessageId,             // <-- BUG: closeMessageId was passed
      timestamp: ts,
    });
}
```

### Bug 3: Backtest timestamp guard is blind to ADD (lines 166-173)

```typescript
// src/trades/record-trade.ts:166-173
if (isBacktest || backtestRunId) {
    if (isOpen_ && !openedAt) {
      throw new Error(`backtest OPEN missing openedAt`);
    }
    if (!isOpen_ && !closedAt) {      // <-- Checks closedAt, but ADD needs openedAt!
      throw new Error(`backtest position-modify missing closedAt`);
    }
}
```

The guard assumes all non-OPEN actions use `closedAt`. Since the caller passed `closedAt`
(from the position-reducing path), the guard passes. But ADD actually needs `openedAt`,
which is absent -- so it silently falls back to `now`.

### Math of the corruption

```
existing_qty = 1, existing_price = 234.82
add_qty = 1, add_price = 0  (entryPrice ?? 0, since entryPrice was not passed)
total_qty = 2
avg_price = (234.82 * 1 + 0 * 1) / 2 = 117.41  <-- WRONG

CLOSE PnL = (235.76 - 117.41) * 2 = 236.70  <-- MASSIVELY INFLATED
Correct PnL = (235.76 - 234.82) * 2 = ~1.88
```

## Trigger Path

1. Hariseldon posts "Added - $234.83 avg now, 1,500 Shares (AAPL)" (message 463550)
2. Orchestrator's parser detects `action = 'ADD'`
3. `resolveAddPath()` finds the existing AAPL position, stamps `signal.tradeId`
4. Delegates to `resolveOpenPath()` which produces `EXECUTE` with BUY legs
5. `executeResolvedSignal` sees `signal.tradeId` is set -> `isPositionReducing = true`
6. Routes through position-reducing path (designed for CLOSE/TRIM)
7. SimBroker fills at market price, calls `recordFill(filledPrice, filledAt)`
8. `recordFill` calls `recordTrade({ action: 'CLOSE', exitPrice: fp, closedAt: ... })`
9. `recordTrade` derives `effectiveAction = 'ADD'` from same-direction legs
10. ADD branch reads `entryPrice` (undefined -> 0) and `openedAt` (undefined -> wall-clock)
11. Entry price corrupted to 117.41, PnL inflated to 236.70

## Fix Required

### Primary fix in `execute-resolved.ts`

The `isPositionReducing` check must not treat ADD as position-reducing. Options:

**Option A**: Check signal action explicitly rather than using tradeId as the heuristic.
The signal needs an `action` field (ADD vs CLOSE/TRIM/LEG_OFF) that the orchestrator sets.

**Option B**: Add a dedicated ADD path in the executor alongside the OPEN and
position-reducing paths. When `signal.tradeId` is set AND the legs are same-direction
as the existing position, route through the ADD path that passes `entryPrice`, `openedAt`,
and `sourceMessageId`.

### Secondary fix in `record-trade.ts`

The ADD branch should defensively read from BOTH `entryPrice` and `exitPrice`:
```typescript
const addPrice = entryPrice ?? exitPrice ?? 0;
const ts = openedAt ?? closedAt ?? now;
const msgId = sourceMessageId ?? closeMessageId;
```

This is a defense-in-depth measure so that even if the caller passes the wrong field names,
the data is still available.

### Tertiary fix: timestamp guard

```typescript
if (isBacktest || backtestRunId) {
    if (isOpen_ && !openedAt) { ... }
    // ADD needs openedAt too
    if (!isOpen_ && action === 'ADD' && !openedAt) {
      throw new Error(`backtest ADD missing openedAt timestamp`);
    }
    if (!isOpen_ && action !== 'ADD' && !closedAt) { ... }
}
```

Or more robustly, after deriving the effective action, validate the timestamp
that the specific action actually uses.

## Key Files

- `/Users/jason/trade-follower-3/src/pipeline/execute-resolved.ts` -- executor, lines 292 and 378-430
- `/Users/jason/trade-follower-3/src/trades/record-trade.ts` -- recordTrade, lines 149-173 (guard) and 348-381 (ADD branch)
- `/Users/jason/trade-follower-3/src/intents/orchestrator/open-path.ts` -- resolveAddPath, lines 575-624
- `/Users/jason/trade-follower-3/src/trades/rebuild.ts` -- event replay logic (would reproduce the corruption)

## Fix Applied (2026-02-28)

**Root cause**: `ResolvedSignal` had no `action` field. The orchestrator decided the action
but didn't carry it into the signal. The executor used `!!signal.tradeId` as its sole
heuristic for "position-reducing", so ADDs (which have a tradeId) entered the CLOSE/TRIM
code path.

**Changes**:

1. **`types.ts`**: Added `action?: TradeAction` to `ResolvedSignal`
2. **`open-path.ts`**: `resolveAddPath` now stamps `signal.action = 'ADD'`
3. **`position-path.ts`**: `resolvePositionPath` now stamps `signal.action` (CLOSE/TRIM/LEG_OFF)
4. **`execute-resolved.ts`**: Routes by `signal.action` instead of `!!signal.tradeId`.
   ADD signals now go through the OPEN path (correct fields: `entryPrice`, `openedAt`,
   `sourceMessageId`) with `tradeId` passed through for `recordTrade` to target.
5. **`record-trade.ts`**: Timestamp guard now checks `openedAt` for ADD (not `closedAt`).

## Data Cleanup

After fixing the code, the 8 affected trades need their ADD events deleted and
entry_price/pnl recalculated:

```sql
-- Delete the 8 bogus ADD events
DELETE FROM trade_events
WHERE action = 'ADD' AND price = '0' AND message_id IS NULL
AND trade_id IN (SELECT id FROM trades WHERE is_backtest = 1);

-- Then re-run rebuild for each affected trade, or just re-run the backtests
```
