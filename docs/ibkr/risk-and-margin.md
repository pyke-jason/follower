# IBKR Risk & Margin

> Verified against [TWS API Account Updates](https://interactivebrokers.github.io/tws-api/account_updates.html), [Checking Margin](https://interactivebrokers.github.io/tws-api/margin.html), and [IBKR Margin Monitoring](https://www.ibkrguides.com/traderworkstation/margin-monitoring.htm).

---

## Margin System

IBKR does **not** make traditional margin calls. Instead, they perform **real-time auto-liquidation** when your account falls below maintenance margin requirements. There is no grace period.

IBKR may send a **best-efforts warning** when approaching margin deficiency (at ~10% cushion / Equity with Loan Value <= Maintenance Margin * 110%), but this is NOT guaranteed in fast-moving markets.

### Margin Cushion Formula

```
Cushion = (Equity with Loan Value - Maintenance Margin) / Net Liquidation Value
```

### Warning Levels (TWS Color-Coded)

| Level | Cushion | What Happens |
|---|---|---|
| **Green** | > 10% | Normal |
| **Yellow** | < 10% | First warning. Reduce positions |
| **Orange** | ~ 0% | Margin depleted. New margin-increasing trades blocked. Short time to act |
| **Red** | < 0% | **Positions WILL be liquidated** |

If account equity drops rapidly, positions may be liquidated **without you ever seeing yellow**.

### Intraday vs Overnight Margin

- Intraday maintenance margin for securities: **25%** (4:1 leverage)
- Overnight Reg T initial margin: **50%** (2:1 leverage)
- Futures: intraday margin can be 5-15% of notional, reverts to full overnight margin at "Intraday End Time"
- Overnight projections computed at **3 PM ET**. Market open projections at **3 AM ET**.
- `LookAheadNextChange` tag tells you the exact transition timestamp

If you hold positions through the transition and overnight margin exceeds your equity, liquidation begins.

---

## Account Monitoring

### reqAccountSummary vs reqAccountUpdates

| Aspect | reqAccountSummary | reqAccountUpdates |
|---|---|---|
| Type | **Subscription** (not one-shot) | Subscription |
| Tag filtering | YES -- request specific tags | NO -- returns all values |
| Multi-account | Supports multiple accounts and "All" | One account at a time |
| Cancellation | `cancelAccountSummary()` | Pass `subscribe=false` |
| Update frequency | Every 3 minutes for changed values | Every 3 minutes or on position change |
| Max subscriptions | 2 active at a time | 1 account at a time |
| `accountReady` | NOT available | Available |
| Primary use | FA (Financial Adviser) accounts | Single accounts |

### Key Account Values

Subscribe via `reqAccountSummary()` or `reqAccountUpdates()`. Updates every ~3 minutes or immediately on position change.

#### Must-Have

| Tag | What It Means | Alert Threshold |
|---|---|---|
| **Cushion** | Margin cushion % | < 10% warn, < 5% critical |
| **ExcessLiquidity** | $ above maintenance margin | <= 0 -> liquidation imminent |
| **SMA** | Special Memorandum Account (Reg T line of credit) | < 0 at end of day -> Reg T violation -> liquidation |
| **DayTradesRemaining** | PDT rule counter | 0 = no day trades, -1 = unlimited (observed behavior, not officially documented sentinel) |

#### High Priority

| Tag | What It Means |
|---|---|
| **LookAheadNextChange** | Unix timestamp of next margin change (intraday->overnight) |
| **LookAheadMaintMarginReq** | What maintenance margin WILL BE at transition |
| **LookAheadExcessLiquidity** | What excess liquidity WILL BE |
| **LookAheadInitMarginReq** | What initial margin WILL BE |
| **LookAheadAvailableFunds** | What available funds WILL BE |
| **FullMaintMarginReq** | Full maintenance margin requirement |
| **FullInitMarginReq** | Full initial margin requirement |
| **FullExcessLiquidity** | Full excess liquidity |
| **FullAvailableFunds** | Full available funds |
| **BuyingPower** | How much you can buy |
| **accountReady** | If `false`, IB server is resetting -- all values may be stale. **Only via reqAccountUpdates** |

#### SMA End-of-Day Check

IBKR checks SMA balance between **15:50-17:20 ET**. Negative SMA at end of day triggers a Reg T violation and potential liquidation. SMA is a "line of credit" created when the market value of securities increases -- it only decreases on purchases and withdrawals, not on market declines (during the day).

---

## Detecting Forced Liquidation

There is **no explicit liquidation callback**. Detection methods:

### 1. Execution.liquidation Field (PRIMARY)

```java
void execDetails(int reqId, Contract contract, Execution execution) {
    if (execution.liquidation() != 0) {
        // THIS IS A FORCED LIQUIDATION BY IB
    }
}
```

- `liquidation == 0` -> normal fill (your order)
- `liquidation != 0` -> IB-initiated forced liquidation
- The `orderId` and `clientId` will NOT match your orders
- The `permId` may be 0

### 2. Cushion Monitoring

- `Cushion < 10%` -> warning
- `Cushion < 5%` -> critical
- `ExcessLiquidity <= 0` -> liquidation in progress

### 3. Error 201 with Margin Text

Order rejected with "margin" or "buying power" in message text.

### 4. "Liquidate Last" Feature

Users can designate positions to be liquidated last via TWS Account Window. Best-efforts only -- IB will try to honor the preference but may not in fast-moving markets.

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
| `equityWithLoanBefore` | String | Account equity with loan BEFORE |
| `initMarginChange` | String | Change in initial margin from this order |
| `maintMarginChange` | String | Change in maintenance margin |
| `equityWithLoanChange` | String | Change in equity with loan |
| `initMarginAfter` | String | Initial margin AFTER order |
| `maintMarginAfter` | String | Maintenance margin AFTER |
| `equityWithLoanAfter` | String | Equity with loan AFTER |
| `commission` | double | Estimated commission |
| `minCommission` | double | Minimum commission estimate |
| `maxCommission` | double | Maximum commission estimate |
| `commissionCurrency` | String | Commission currency |
| `warningText` | String | Warning messages |

---

## Options-Specific Risks

### Assignment

- Assignments are processed overnight by the OCC
- Short option position disappears, stock position appears at strike
- **No dedicated "you were assigned" callback** -- infer from position changes and executions the next morning
- Appears in `execDetails()` the next morning

### Auto-Exercise (OCC Rules)

- Any option **$0.01+ in-the-money** at expiration -> automatically exercised
- To prevent: submit "contrary intention" (lapse) before deadline
- IBKR may **lapse your long ITM options** if post-settlement margin would be insufficient
- IBKR may exercise long calls in a spread if it expects short-call assignment
- Exercises and lapses are **irrevocable**

### Option Expiry (Worthless)

- Position simply disappears -- no explicit event
- `position()` callback will show 0 or absent the next business day

---

## Pattern Day Trader (PDT) Rules

- **$25,000 Net Liquidation Value minimum** for pattern day traders (FINRA rule)
- `DayTradesRemaining` tag in account summary
- Value 0 -> no day trades allowed
- Value -1 -> unlimited (account > $25K)
- Violation -> **opening new positions blocked** (closing existing positions still allowed) for remainder of 5-day window
- Error 201 with PDT text on order rejection

---

## Sources

- [TWS API: Account Summary](https://interactivebrokers.github.io/tws-api/account_summary.html)
- [TWS API: Account Updates](https://interactivebrokers.github.io/tws-api/account_updates.html)
- [TWS API: Checking Margin](https://interactivebrokers.github.io/tws-api/margin.html)
- [TWS API: Execution Class](https://interactivebrokers.github.io/tws-api/classIBApi_1_1Execution.html)
- [TWS API: OrderState Class](https://interactivebrokers.github.io/tws-api/classIBApi_1_1OrderState.html)
- [TWS API: Tick Types](https://interactivebrokers.github.io/tws-api/tick_types.html)
- [IBKR Real Time Margin Monitoring](https://www.ibkrguides.com/traderworkstation/margin-monitoring.htm)
- [IBKR Delivery, Exercise and Corporate Actions](https://www.interactivebrokers.com/en/trading/delivery-exercise-actions.php)
- [IBKR Pattern Day Trader](https://www.interactivebrokers.com/campus/glossary-terms/pattern-day-trader/)
- [IBKR Stock Margin](https://www.interactivebrokers.com/en/trading/margin-stocks.php)
