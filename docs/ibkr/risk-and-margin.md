# IBKR Risk & Margin Monitoring

> How IBKR handles margin, liquidation, and account risk.
> No margin calls — IBKR auto-liquidates in real time.

---

## Margin System

IBKR does **not** make traditional margin calls. Instead, they perform **real-time auto-liquidation** when your account falls below maintenance margin requirements. There is no grace period, no phone call, no email warning.

### Margin Cushion Formula

```
Cushion = (Equity with Loan Value - Maintenance Margin) / Net Liquidation Value
```

### Warning Levels (TWS Color-Coded)

| Level | Cushion | What Happens |
|---|---|---|
| **Green** | > 10% | Normal |
| **Yellow** | < 10% | First warning. You should reduce positions |
| **Orange** | ~ 0% | Margin depleted. New trades blocked. Short time to act |
| **Red** | < 0% | **Positions WILL be liquidated** |

If account equity drops rapidly, positions may be liquidated **without you ever seeing yellow**.

---

## Key Account Values to Monitor

Subscribe via `reqAccountSummary()` or `reqAccountUpdates()`. Updates every ~3 minutes or immediately on position change.

### Must-Have

| Tag | What It Means | Alert Threshold |
|---|---|---|
| **Cushion** | Margin cushion % | < 10% warn, < 5% critical |
| **ExcessLiquidity** | $ above maintenance margin | <= 0 → liquidation imminent |
| **SMA** | Special Memorandum Account | < 0 at end of day → Reg T violation → liquidation |
| **DayTradesRemaining** | PDT rule counter | 0 = no day trades, -1 = unlimited |

### High Priority

| Tag | What It Means |
|---|---|
| **LookAheadNextChange** | Unix timestamp of next margin change (intraday→overnight) |
| **LookAheadMaintMarginReq** | What maintenance margin WILL BE at that time |
| **LookAheadExcessLiquidity** | What excess liquidity WILL BE |
| **FullMaintMarginReq** | Full maintenance margin requirement |
| **FullInitMarginReq** | Full initial margin requirement |
| **BuyingPower** | How much you can buy |
| **accountReady** | If `false`, IB server is resetting — all values may be stale |

### Intraday → Overnight Margin Shift

Intraday margin for securities is typically **25%**. Overnight margin reverts to **Reg T 50%**. For futures, the shift is even more dramatic. `LookAheadNextChange` tells you when this happens. If you hold positions through the transition and overnight margin exceeds your equity, liquidation begins.

---

## Detecting Forced Liquidation

There is **no explicit liquidation callback**. Detection methods:

### 1. `Execution.liquidation` Field (PRIMARY)

```java
void execDetails(int reqId, Contract contract, Execution execution) {
    if (execution.liquidation() != 0) {
        // THIS IS A FORCED LIQUIDATION BY IB
    }
}
```

- `liquidation == 0` → normal fill (your order)
- `liquidation != 0` → IB-initiated forced liquidation
- The `orderId` and `clientId` will NOT match your orders
- The `permId` may be 0

**CURRENT GAP:** Our sidecar's `execDetails()` is a no-op. Liquidation fills are silently dropped.

### 2. Cushion Monitoring

- `Cushion < 10%` → warning
- `Cushion < 5%` → critical
- `ExcessLiquidity <= 0` → liquidation in progress

### 3. Error 460

Margin-related critical violation on an order. Already handled by sidecar WS broadcast.

### 4. Error 201 with margin text

Order rejected with "margin" or "buying power" in message text.

---

## Pre-Trade Margin Check (WhatIf Orders)

```java
Order order = new Order();
order.whatIf(true);  // Don't actually place, just check margin impact
client.placeOrder(orderId, contract, order);
```

Response comes through `openOrder()` with `OrderState` containing:

| Field | Type | Meaning |
|---|---|---|
| `initMarginBefore` | String | Account initial margin BEFORE |
| `maintMarginBefore` | String | Account maintenance margin BEFORE |
| `initMarginChange` | String | Change in initial margin from this order |
| `maintMarginChange` | String | Change in maintenance margin |
| `initMarginAfter` | String | Initial margin AFTER order |
| `maintMarginAfter` | String | Maintenance margin AFTER |
| `commission` | double | Estimated commission |
| `warningText` | String | Warning messages |

Not yet exposed by the sidecar.

---

## Options-Specific Risks

### Assignment

- Assignments are processed overnight by the OCC
- Short option position disappears, stock position appears at strike
- **No dedicated "you were assigned" callback** — infer from position changes
- Appears in `execDetails()` the next morning

### Auto-Exercise (OCC Rules)

- Any option $0.01+ in-the-money at expiration → automatically exercised
- To prevent: submit "contrary intention" (lapse) before deadline
- IBKR may lapse your long ITM options if post-settlement margin would be insufficient
- IBKR may exercise long calls in a spread if it expects short-call assignment

### Option Expiry (Worthless)

- Position simply disappears — no explicit event
- `position()` callback will show 0 or absent the next business day

---

## Pattern Day Trader (PDT) Rules

- `DayTradesRemaining` tag in account summary
- Value 0 → no day trades allowed (account < $25K, used up day trades)
- Value -1 → unlimited (account > $25K)
- Violation → **ALL trades blocked** (not just day trades) for remainder of 5-day window
- Error 201 with PDT text on order rejection

---

## Account Summary Tags — Current vs Needed

### What the sidecar requests now

```
"NetLiquidation,AvailableFunds,MaintMarginReq,UnrealizedPnL"
```

### What should be added

```
"Cushion,ExcessLiquidity,FullMaintMarginReq,SMA,DayTradesRemaining,BuyingPower,LookAheadNextChange,LookAheadMaintMarginReq,LookAheadExcessLiquidity"
```

---

## Market-Wide Events

### Trading Halts (LULD / Circuit Breakers)

Tick Type 49 (HALTED) via `tickGeneric()`:

| Value | Meaning |
|---|---|
| -1 | Halt status unavailable |
| 0 | Not halted |
| 1 | General halt (regulatory + volatility) |
| 2 | Volatility halt (LULD) |

**Impact on orders:**
- Error **154**: "Orders cannot be transmitted for halted security"
- Existing limit orders usually stay on book
- Market orders may be rejected

**Current gap:** Sidecar does not subscribe to tick type 49.

---

## Implementation Priorities

### Phase 1 — Before Live Trading

1. **Implement `execDetails()` handler** in sidecar → detect `Execution.liquidation`, forward fills via WS
2. **Expand account summary tags** → add Cushion, ExcessLiquidity, SMA, DayTradesRemaining
3. **Forward commission reports** via WS
4. **Expand `ORDER_ERROR_CODES`** → add 200, 203, 392, 399, 404, 412

### Phase 2 — After Live Trading Stabilizes

5. Add `reqAccountUpdates()` subscription for real-time position tracking
6. Implement Cushion-based margin alerts (< 10% warn, < 5% critical)
7. Add WhatIf order support for pre-trade margin checks
8. Subscribe to tick type 49 for halt detection
