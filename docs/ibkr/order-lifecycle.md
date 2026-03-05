# IBKR Order Lifecycle

> Verified against [TWS API Order Submission](https://interactivebrokers.github.io/tws-api/order_submission.html), [Executions & Commissions](https://interactivebrokers.github.io/tws-api/executions_commissions.html), and [Spread Contracts](https://interactivebrokers.github.io/tws-api/spread_contracts.html).

---

## Order Status Values

Nine distinct values from the `orderStatus` callback.

| Status | Terminal? | Description |
|---|---|---|
| **ApiPending** | No | Not yet sent to IB server. Security definition delay. Rare. |
| **PendingSubmit** | No | Sent from TWS/Gateway, awaiting destination ack. |
| **PreSubmitted** | No | Simulated order (stop, stop-limit, trailing stop) held by IB until trigger. Also: child orders in brackets before parent fills. |
| **Submitted** | No | Working at exchange. Steady state for limit orders. |
| **PendingCancel** | No | Cancel request sent, awaiting confirmation. |
| **Filled** | **Yes** | Completely filled (`remaining == 0`). |
| **Cancelled** | **Yes** | Confirmed cancelled. Includes system cancellations. |
| **ApiCancelled** | **Yes** | Cancel was sent before IB acknowledged the order. |
| **Inactive** | **No** | Not working -- held, rejected, or blocked. See triggers below. |

### Inactive Triggers

An `Inactive` status means the order exists but is NOT working. An `error()` callback with a specific code is always expected alongside Inactive.

1. **Regulatory reject** -- order violates exchange rules
2. **Short sale locate pending** -- shares being located (`whyHeld = "locate"`)
3. **Exchange closed** -- order placed outside hours without valid TIF
4. **TWS precautionary block** -- price/size exceeds user safety limits (inferred, not explicitly documented)
5. **Account restriction** -- insufficient permissions or margin (inferred)
6. **IB internal hold** -- compliance or risk holds (inferred)

### Inactive Can Recover

Unlike `Cancelled`/`Filled`, Inactive is NOT always terminal:
- Short sell locate completes -> transitions to `Submitted`
- Exchange reopens -> transitions to `Submitted`
- TWS precautionary block manually accepted -> transitions to `Submitted`

---

## State Machine

```
                    placeOrder()
                        |
                        v
                   [ApiPending] -----> (rare, security def delay)
                        |
                        v
                  [PendingSubmit]
                        |
              +---------+---------+
              |                   |
              v                   v
        [PreSubmitted]       [Submitted]
         (simulated           (native
          order held)          exchange)
              |                   |
              +----> [Submitted] -+
                        |
              +---------+---------+----------+
              |                   |          |
              v                   v          v
          [Filled]         [PendingCancel]  [Inactive]
         (TERMINAL)              |          (error/hold)
                                 |               |
                                 v               v
                           [Cancelled]      may recover to
                           (TERMINAL)       [Submitted] or
                                            stay [Cancelled]
```

### Transition Rules

```
ApiPending     -> PendingSubmit
PendingSubmit  -> PreSubmitted | Submitted | Inactive | Cancelled
PreSubmitted   -> Submitted | Cancelled | Inactive
Submitted      -> Filled | PendingCancel | Inactive | Cancelled
                  (also re-fires on each partial fill with updated counts)
PendingCancel  -> Cancelled | Filled (race: fill beats cancel)
Inactive       -> Submitted (hold released) | Cancelled (permanent reject)
Filled         -> TERMINAL (exception: execution corrections, see below)
Cancelled      -> TERMINAL
ApiCancelled   -> TERMINAL
```

---

## Critical Edge Cases

### 1. PendingCancel -> Filled

If cancel request races with a fill at the exchange, **the fill wins**. You MUST handle `Filled` even after requesting cancel.

### 2. Duplicate orderStatus Messages

TWS explicitly warns these are common. Order handling must be **idempotent**.

### 3. No Guaranteed Intermediate States

Market orders may go directly to `Filled` without `PendingSubmit` or `Submitted`. Community experience suggests `orderStatus` callbacks may be entirely absent for instant-fill market orders (not officially documented, but widely observed).

### 4. Simulated Order Survival

With TWS 10.28+, the "Maintain and resubmit orders when connection is restored" setting (Global Config > API > Settings) may preserve PreSubmitted orders across TWS/Gateway restarts. Previously, PreSubmitted orders survived API disconnects but NOT TWS restarts.

---

## Partial Fills

There is **no `PartiallyFilled` status**. Status remains `Submitted` throughout.

Detect partial fills from `filled` and `remaining` parameters:

```
orderStatus(status="Submitted", filled=0,   remaining=100, avgFillPrice=0)
orderStatus(status="Submitted", filled=30,  remaining=70,  avgFillPrice=149.98)
orderStatus(status="Submitted", filled=30,  remaining=70,  avgFillPrice=149.98)  <- DUPLICATE
orderStatus(status="Submitted", filled=80,  remaining=20,  avgFillPrice=149.99)
orderStatus(status="Filled",    filled=100, remaining=0,   avgFillPrice=150.00)
```

### Partial Fill + Cancellation

```
orderStatus(status="Submitted",     filled=30, remaining=70)
// cancelOrder() called
orderStatus(status="PendingCancel", filled=30, remaining=70)
orderStatus(status="Cancelled",     filled=30, remaining=70)
```

The final `Cancelled` status still carries `filled=30` -- those shares were executed.

---

## orderStatus Callback Parameters

```java
void orderStatus(
    int orderId,          // Our order ID (matches placeOrder call)
    String status,        // One of the 9 status values above
    Decimal filled,       // Cumulative filled quantity
    Decimal remaining,    // Remaining unfilled quantity
    double avgFillPrice,  // Volume-weighted average fill price
    long permId,          // Permanent IB-wide order ID (10.40+: long, was int)
    int parentId,         // Parent order ID (for bracket orders), 0 if none
    double lastFillPrice, // Price of most recent partial fill
    int clientId,         // Client ID that placed this order
    String whyHeld,       // Why order is held (e.g., "locate" for short sales)
    double mktCapPrice    // If order was price-capped by IB. 0.0 if not. Added API v973.04
)
```

### whyHeld Values

| Value | Meaning |
|---|---|
| `"locate"` | Short sell order held while shares being located |
| `""` (empty) | Not held. Normal operation |

Official docs do not comprehensively enumerate all possible values. `"locate"` is the only confirmed named value.

---

## Callback Sequence Per Fill

Typical observed order (NOT guaranteed by official docs):

```
1. execDetails()                   -- fill details (per execution)
2. orderStatus()                   -- updated filled/remaining counts
3. openOrder()                     -- updated order state
4. commissionAndFeesReport()       -- commission for this fill (10.40+ name)
5. updatePortfolio()               -- position change (if subscribed)
```

### execDetails vs orderStatus

| Callback | Fires on market order instant fill? | Per-fill details? | Cumulative counts? |
|---|---|---|---|
| `execDetails` | **Always** | Yes (`shares`, `price` per fill) | Yes (`cumQty`, `avgPrice`) |
| `orderStatus` | **Usually, but may be absent** | No | Yes (`filled`, `remaining`) |

**For correctness: always monitor both.**

---

## Execution Details

### Callback Signature

```java
void execDetails(int reqId, Contract contract, Execution execution)
```

### Key Execution Fields

| Field | Type | Description |
|---|---|---|
| `orderId` | int | API client order ID |
| `execId` | String | Unique execution ID per fill |
| `time` | String | Server-side execution timestamp |
| `side` | String | `"BOT"` (bought) or `"SLD"` (sold) |
| `shares` | Decimal | Shares/contracts in THIS fill |
| `price` | double | Fill price (excludes commissions) |
| `permId` | int | Permanent account-wide order ID. 0 for external trades |
| `clientId` | int | Client ID that placed the order |
| `liquidation` | int | **Non-zero if IB-initiated forced liquidation** |
| `cumQty` | Decimal | Cumulative filled quantity across all fills |
| `avgPrice` | double | Volume-weighted average price across all fills |
| `lastLiquidity` | Liquidity | Added, Removed, or Resting |
| `pendingPriceRevision` | boolean | Whether this execution has a pending price revision |

### Execution Corrections

If an exchange corrects a fill:
- A NEW `execDetails` fires with identical parameters except `execId`
- The corrected `execId` differs only in digits after the final period
- **You MUST detect this** or you will double-count fills

### When Does execDetails Fire?

- Every partial fill produces a separate callback
- Fires BEFORE the corresponding orderStatus (typically)
- After reconnection, request missed executions via `reqExecutions(filter)` (today only by default, up to 7 days via TWS Trade Log settings)

---

## Commission Reports

### CommissionAndFeesReport (TWS API 10.40+)

Previously named `CommissionReport` with `commission()` method. Renamed in 10.40.

| Field | Type | Description |
|---|---|---|
| `execId` | String | Links to `Execution.execId` -- the join key |
| `commissionAndFees` | double | Total. `Double.MAX_VALUE` = not yet available |
| `currency` | String | e.g., "USD" |
| `realizedPNL` | double | `Double.MAX_VALUE` if not applicable |
| `yield` | double | Income return. `Double.MAX_VALUE` if not applicable |
| `yieldRedemptionDate` | int | YYYYMMDD format. 0 if not applicable |

- One report per `execDetails` (1:1 via `execId`)
- Fires AFTER `execDetails`
- May be delayed -- do not assume synchronous delivery
- On reconnection, today's commission reports are replayed

---

## Combo/Spread (BAG) Orders

### Basics

- `secType = "BAG"` with `comboLegs` list
- Up to 6 legs supported (some exchanges limit further)
- Symbol is the underlying (or comma-separated for inter-commodity)

### Guaranteed vs Non-Guaranteed

| Type | Behavior | Risk |
|---|---|---|
| **Guaranteed** | Exchange executes all legs simultaneously | Fills or doesn't. No partial leg risk |
| **Non-Guaranteed** | SMART-routed, legs execute independently | **One leg can fill without the other** (legging risk) |

For SMART-routed combos, `NonGuaranteed=1` in `smartComboRoutingParams` is REQUIRED.

### Leg Priority (2-leg combos only)

| LeginPrio | Meaning |
|---|---|
| -1 | No priority (default) |
| 0 | Execute first leg first |
| 1 | Execute second leg first |

### Status Tracking

- Single `orderStatus` stream for the combo as a whole
- Individual legs do NOT get separate `orderStatus` callbacks
- Each leg fill generates its own `execDetails` and `commissionAndFeesReport`
- The `orderId` is the same across all legs (combo order ID)
- `Execution.side` may differ across legs (BUY/SELL for spread legs)

### Non-Guaranteed Combo Risk (SMART-routed)

With `NonGuaranteed=1`:
1. Each leg is routed independently for best execution
2. If leg A fills but leg B cannot -> naked partial position
3. IB does NOT auto-unwind the filled leg
4. Combo status stays `Submitted` until all legs fill
5. Remaining unfilled legs stay open (GTC) until filled or cancelled

---

## Connection Loss & Recovery

### What Happens to Open Orders

| Order State | Survives API Disconnect? | Survives TWS Restart? |
|---|---|---|
| At exchange (Submitted) | Yes | Yes (exchange holds it) |
| Simulated (PreSubmitted) | Yes | **Depends** -- see "Maintain and resubmit" setting (10.28+) |
| PendingSubmit | Unknown state | Unknown |
| Untransmitted (Transmit=false) | No | No |

### Recovery After Reconnect

1. Call `reqOpenOrders()` -- get all active orders with current status
2. Call `reqExecutions(filter)` -- get fills that occurred while disconnected (today only by default)
3. Call `reqCompletedOrders(apiOnly)` -- get filled and cancelled orders
4. Compare against local state to detect missed fills
5. Commission reports for today's executions are also replayed

### Order ID Management

- `nextValidId` fires on connect with the next safe order ID
- Order IDs must be monotonically increasing within a session
- **`permId`** is permanent and account-wide -- use it to correlate across reconnects
- `orderBound(long permId, int apiClientId, int apiOrderId)` -- maps permId to API-side identifiers. Fires when manual TWS orders are "bound" via `reqOpenOrders()` from client 0

---

## Sources

- [TWS API: Order Submission](https://interactivebrokers.github.io/tws-api/order_submission.html)
- [TWS API: Executions and Commissions](https://interactivebrokers.github.io/tws-api/executions_commissions.html)
- [TWS API: Message Codes](https://interactivebrokers.github.io/tws-api/message_codes.html)
- [TWS API: Retrieving Open Orders](https://interactivebrokers.github.io/tws-api/open_orders.html)
- [TWS API: Spread Contracts](https://interactivebrokers.github.io/tws-api/spread_contracts.html)
- [TWS API: Execution Class](https://interactivebrokers.github.io/tws-api/classIBApi_1_1Execution.html)
- [TWS API: OrderState Class](https://interactivebrokers.github.io/tws-api/classIBApi_1_1OrderState.html)
