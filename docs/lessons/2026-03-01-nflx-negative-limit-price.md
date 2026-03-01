# NFLX PUT: Negative Limit Price Chase

Trade: `5abfe554-c8aa-4270-8d47-b32b37c5b0e1`
Backtest: `58a53d12-5457-4616-b30f-cd8e6c39d5e8`

## Problem

NFLX LONG PUT trade (0DTE, $1182.5 strike, Sep 12 expiry) had its closing order limit price
chased from $1.11 to **-$1.89**. The order never filled despite active bids ($0.80–$0.92)
throughout. Trade was closed via auto-close at $1.11. PnL: -$2.00 (entry $1.13, exit $1.11).

## Timeline (UTC)

1. **18:02:01** — Open signal: "Short NFLX Lotto Puts $1182.5 - for $1.21 - 15 Contracts"
2. **18:09:07** — Trade opened: 1 contract LONG PUT @ $1.13 (position-sized down from 15)
3. **19:43:36** — Close signal: "Exit NFLX with .12 loss per contract (15)"
4. **19:43:36** — Close order SIM-104 placed: SELL limit @ $1.11 (midpoint from `getSpreadMidpoint`)
5. Day boundary → `broker.advanceTo(marketClose)` replays ticks with stale limit $1.11
6. `orderManager.tick()` batch-applies 20 chase steps → limit = **-$1.89**
7. Day boundary cancels unfilled close order
8. `autoCloseExpiring()` fires, closes trade at $1.11

## Root Cause: advanceTo / orderManager.tick() Desync (PRIMARY)

**The chase and fill evaluation are completely desynchronized in backtest.**

`runner.ts:277-278` (day boundary) and `runner.ts:347-348` (per-message):
```
await broker.advanceTo(time);      // replays ALL ticks with OLD limit
await orderManager.tick(time);     // THEN applies chase — too late
```

During `advanceTo`, the SELL order's limit is still $1.11. Fill condition: `limit <= bid`.
Bids ranged $0.80–$0.92 → $1.11 > all bids → no fill. This is correct — you can't sell at
$1.11 when best bid is $0.92.

After `advanceTo` finishes, `orderManager.tick()` batch-applies all 20 chase steps at once.
The limit drops to $-1.89. But no ticks are re-evaluated against the new limit.

**With correct interleaving**, the order would have filled at step 2–3:

```
Step 0: limit=$1.11, bid=$0.82 → no fill (correct)
Step 1: limit=$0.96, bid=$0.90 → no fill (correct)
Step 2: limit=$0.81, bid=$0.90 → FILL ($0.81 <= $0.90)
```

Verified against Databento cbbo-1s ticks from tick-cache.db. With price improvement
(SELL fills at `max(limit, bid)`), the fill price would be $0.90, giving PnL = -$23.00
instead of the recorded -$2.00.

In live mode this works because TradeStation continuously evaluates fills against the
updated limit. In backtest, `advanceTo` replays all ticks in one shot, then `tick()`
adjusts the limit with no re-evaluation.

## Bug 2: Price chase has no floor — can go negative

**File**: `src/orders/order-manager.ts:153-155`

```typescript
const newPrice = isBuy
  ? order.currentLimitPrice + totalMovement
  : order.currentLimitPrice - totalMovement;
```

SELL chase subtracts with no floor. PUT close: $1.11 - (20 × $0.15) = **-$1.89**.
Any option under $3.00 goes negative. `autoCloseExpiring` has `Math.max(0, ...)` but
the chase does not.

## Bug 3: Auto-close price is wrong

`autoCloseExpiring()` closed the trade at $1.11, but Databento ticks show the actual
mid at 19:45:00 was **$0.98** (bid=$0.80, ask=$1.16). The $1.11 comes from the
`getSpreadMidpoint` computed at close signal time (19:43:36), not at the auto-close
timestamp. Need to verify how `autoCloseExpiring` sources its price.

## Databento Tick Evidence

Real bid/ask for `NFLX  250912P01182500` around close signal time:

```
Time UTC   | Bid   | Ask   | Mid
19:43:38   | $0.82 | $1.12 | $0.97   ← order placed, limit=$1.11 > bid, no fill
19:43:52   | $0.90 | $1.12 | $1.01   ← step 2 limit=$0.81 <= bid → SHOULD FILL
19:44:04   | $0.92 | $1.29 | $1.11   ← active market, bid=$0.92
19:45:00   | $0.80 | $1.16 | $0.98   ← auto-close time, real mid=$0.98 not $1.11
19:51:45   | $0.34 | $0.70 | $0.52   ← decaying toward expiry
19:57:09   | $0.05 | $0.07 | $0.06
19:58:33   | $0.01 | $0.04 | $0.03   ← final tick
```

This was an ITM put ($1182.5 strike, NFLX at ~$1190). Bids were active the entire
session. The claim "bid was likely $0.00" in the earlier draft was wrong — intrinsic
value alone guaranteed nonzero bids until very close to expiry.

## Vulnerability Scan

8 of 89 trades (~9%) in this backtest have exit prices below the max chase amount:

```
QS       PUT   exit=$0.01  → chase to $-2.99
MSFT     PUT   exit=$0.04  → chase to $-2.96
MSFT     PUT   exit=$0.17  → chase to $-2.83
NVDA     PUT   exit=$0.26  → chase to $-2.74
CENX     CALL  exit=$0.95  → chase to $-2.05
NFLX     PUT   exit=$1.11  → chase to $-1.89
NFLX     PDS   exit=$0.57  → chase to $-1.43
META     CALL  exit=$2.74  → chase to $-0.26
```

All of these likely also suffer from the advanceTo/tick desync — close orders that
should fill via chase never get a chance because ticks are evaluated before chase runs.

## Latent Bug: Duplicate Close Race (Live Mode)

Not triggered here, but the code allows it:
- Close task A places order → OrderManager chasing on 1s timer
- Trade still OPEN in DB (not CLOSED until `onFill` fires)
- Close task B finds same trade → places SECOND close order
- `record-trade.ts:245-246` tradeId fast-path bypasses `isOpen` filter

## Key Files

| File | Role |
|---|---|
| `src/backtest/runner.ts:277-278, 347-348` | advanceTo THEN tick — desync root cause |
| `src/orders/order-manager.ts:146-165` | Chase logic — no price floor, batch-applied |
| `src/backtest/sim-broker.ts:864-958` | `advanceTo` — replays ticks with stale limit |
| `src/pipeline/execute-resolved.ts:89-95` | Close order defaults — fixed step amounts |
| `src/backtest/sim-broker.ts:585-635` | `autoCloseExpiring` — price may be stale |
| `src/broker/tradestation/client.ts:132-134` | `modifyOrder` sends raw price, no validation |

## Recommendations (not implemented)

1. **Interleave chase with tick replay** — the fundamental fix. Either:
   - Have `advanceTo` call back into OrderManager's chase logic at each simulated interval
   - Or have OrderManager re-invoke `advanceTo` after each chase adjustment
   - This is architecturally nontrivial — OrderManager and SimBroker are separate layers
2. **Add price floor to chase**: `Math.max(0.01, newPrice)` in `order-manager.ts:155`
3. **Validate limit prices > 0** in `modifyOrder`
4. **Verify auto-close price sourcing** — is it using a stale midpoint or requoting?

## Watch Out

- The desync affects ALL working orders with chase rules in backtest, not just this trade
- Cheap options are most visible (negative prices) but even moderately-priced options
  may fill at wrong times or not at all due to the stale limit during tick replay
- The 8 vulnerable trades likely all have wrong PnL due to this
- In live mode, the 1s timer + real broker fill evaluation means this specific desync
  doesn't apply, but the negative price floor issue still does
