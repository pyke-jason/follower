# TWS API Execution Lifecycle Reference

Comprehensive reference for every signal, callback, error, and edge case
the TWS API can produce during order execution. Primary source: official
IBKR documentation at `interactivebrokers.github.io/tws-api/`.

---

## 1. Order Status Values

Nine distinct values returned by the `orderStatus` callback.

| Status | Meaning | When It Occurs |
|---|---|---|
| **ApiPending** | Order not yet sent to IB servers. | Rare. Delay in security definition lookup. |
| **PendingSubmit** | Sent from TWS/Gateway, awaiting destination ack. | Exchange closed, or network delay to destination. |
| **PreSubmitted** | Simulated order accepted by IB, awaiting election. | Stop orders, stop-limit orders, trailing stops. Order held by IB until trigger condition met, then transmitted to exchange. |
| **Submitted** | Order accepted at destination exchange, working. | Normal active state for limit orders. |
| **Filled** | Order completely filled. `remaining == 0`. | Full execution. Terminal state. |
| **Cancelled** | Balance of order confirmed cancelled by IB. | User cancellation, exchange rejection, or IB risk system. |
| **ApiCancelled** | Client requested cancel before order was acknowledged. | Cancel sent immediately after `placeOrder`, before IB processed it. |
| **PendingCancel** | Cancel request sent, awaiting confirmation. | Transient state between cancel request and final `Cancelled`. |
| **Inactive** | Order not working. Invalid, held, or blocked. | See detailed triggers below. |

### Inactive Triggers (Critical)

An `Inactive` status means the order exists but is NOT working. Causes:

1. **Regulatory reject** -- order violates exchange rules (size, price, etc.)
2. **Short sale locate pending** -- shares being located for short sell (see `whyHeld`)
3. **Exchange closed** -- order placed outside trading hours without valid TIF
4. **TWS precautionary block** -- price/size exceeds user-configured safety limits
5. **Account restriction** -- insufficient permissions or margin (accompanying error code)
6. **IB internal hold** -- various compliance or risk holds

**An error() callback with a specific code is ALWAYS expected alongside Inactive.**

### Partial Fills

During partial fills, the order status remains `Submitted`. Each partial fill
produces separate callbacks. The order transitions to `Filled` only when
`remaining == 0`.

---

## 2. Order Lifecycle State Machine

```
                    placeOrder()
                        |
                        v
                   [ApiPending] -----> (rare, security definition delay)
                        |
                        v
                  [PendingSubmit]
                        |
              +---------+---------+
              |                   |
              v                   v
        [PreSubmitted]       [Submitted]
         (simulated           (native
          order held)          exchange
              |                order)
              |                   |
              +----> [Submitted] -+
                        |
              +---------+---------+----------+
              |                   |          |
              v                   v          v
          [Filled]         [PendingCancel]  [Inactive]
         (terminal)              |          (error or hold)
                                 |               |
                                 v               v
                           [Cancelled]      may recover to
                           (terminal)       [Submitted] or
                                            stay [Cancelled]
```

### Possible Transitions

```
ApiPending     -> PendingSubmit
PendingSubmit  -> PreSubmitted | Submitted | Inactive | Cancelled
PreSubmitted   -> Submitted | Cancelled | Inactive
Submitted      -> Filled | PendingCancel | Inactive | Cancelled
                  (Submitted also fires on each partial fill with updated
                   filled/remaining counts)
PendingCancel  -> Cancelled | Filled (race condition: fill beats cancel)
Inactive       -> Submitted (if hold is released, e.g., locate found)
               -> Cancelled (if permanently rejected)
Filled         -> TERMINAL. Cannot transition to anything else.
                  (Exception: execution corrections -- see Section 5)
Cancelled      -> TERMINAL. Cannot come back.
ApiCancelled   -> TERMINAL.
```

### Critical Edge Cases

1. **PendingCancel -> Filled**: If a cancel request races with a fill at the
   exchange, the fill wins. You MUST handle Filled even after requesting cancel.
2. **Inactive -> Submitted**: An order held for short-locate can become active
   once shares are found. Monitor `whyHeld` field.
3. **Duplicate orderStatus messages**: TWS explicitly warns these are common.
   Order manager must be idempotent.
4. **No guaranteed callback for every transition**: Market orders may go
   directly to Filled without intermediate Submitted.

---

## 3. orderStatus Callback Parameters

```java
void orderStatus(
    int orderId,        // Our order ID (matches placeOrder call)
    String status,      // One of the 9 status values above
    Decimal filled,     // Cumulative filled quantity
    Decimal remaining,  // Remaining unfilled quantity
    double avgFillPrice,// Volume-weighted average fill price
    long permId,        // Permanent IB-wide order ID (unique across account)
    int parentId,       // Parent order ID (for bracket orders), 0 if none
    double lastFillPrice, // Price of most recent partial fill
    int clientId,       // Client ID that placed this order
    String whyHeld,     // Why order is held (e.g., "locate" for short sales)
    double mktCapPrice  // If order was price-capped by IB, the cap price.
                        // 0.0 if not capped. Added in API v973.04.
)
```

### whyHeld Values

| Value | Meaning |
|---|---|
| `"locate"` | Short sell order held while shares being located. |
| `""` (empty) | Not held. Normal operation. |

### mktCapPrice

When IB caps an order price due to regulatory distance rules, `mktCapPrice`
contains the actual capped price. If `mktCapPrice > 0`, the order may fill
at a worse price than your limit, or may not fill at all.

---

## 4. Error Codes -- Comprehensive Reference

### Error Callback Signature (TWS API 10.40)

```java
void error(int id, long reqId, int errorCode, String errorMsg, String advancedOrderRejectJson)
```

- `id`: Order ID or request ID (-1 for system-wide errors)
- `reqId`: Extended request ID (added in 10.40)
- `errorCode`: Numeric code from the table below
- `errorMsg`: Human-readable description
- `advancedOrderRejectJson`: JSON with FIX tag 8230 rejection details. Can be
  used to populate `Order.advancedErrorOverride` to retry with override.

### 4a. CONNECTION ERRORS

| Code | Message | Action |
|---|---|---|
| **502** | Couldn't connect to TWS. | TWS not running, wrong port, firewall. Fatal until resolved. |
| **504** | Not connected. | Socket disconnected. All pending requests fail. |
| **507** | Bad message (socket EOF). | Connection corrupted. Reconnect needed. |
| **509** | Socket exception. | Network failure. Reconnect. |
| **1100** | Connectivity between IB and TWS lost. | **CRITICAL.** All open orders may be affected. Set connected=false. |
| **1101** | Connectivity restored, data lost. | Reconnected but market data subscriptions need re-establishing. Open orders survived. |
| **1102** | Connectivity restored, data maintained. | Best case reconnect. Market data subscriptions intact. |
| **1300** | Socket port reset during active connection. | Reconnect needed. |
| **2110** | Connectivity between TWS and server broken. Will restore automatically. | Wait for 1101/1102. |

### 4b. ORDER REJECTION & CANCELLATION

| Code | Message | Action |
|---|---|---|
| **104** | Can't modify a filled order. | Order already fully filled. Ignore modify attempt. |
| **105** | Order modification doesn't match original. | Resend with correct parameters. |
| **107** | Cannot transmit incomplete order. | Missing required field (price, quantity, etc.). |
| **133** | Submit new order failed. | Internal IB error. Retry. |
| **134** | Modify order failed. | Internal IB error on modification. |
| **135** | Can't find order to cancel. | Order already cancelled/filled, or wrong ID. |
| **136** | Cannot cancel order. | Order in non-cancellable state. |
| **161** | Cancel attempted on inactive order. | Order already dead. |
| **201** | **Order rejected.** | **CRITICAL.** Generic rejection -- read `errorMsg` for reason. Covers margin, compliance, size, etc. Order goes Inactive/Cancelled. |
| **202** | **Order cancelled.** | IB cancelled the order. Read `errorMsg` for reason (price validation, risk, etc.). |
| **329** | Cannot change to new order type during modification. | Must cancel and place new order. |
| **399** | **Order message/warning.** | "Order will not be placed until..." -- precautionary warning. Order may be held. |

### 4c. INVALID CONTRACT / SECURITY

| Code | Message | Action |
|---|---|---|
| **200** | No security definition found for the request. | Contract spec wrong (bad conId, wrong symbol, expired). |
| **203** | Security not available for this account. | Permission issue or trading restriction. |
| **392** | Cannot place order for expired contract. | Option/future has expired. |
| **404** | Shares not available for short sale. | No borrow available. |
| **407** | Invalid symbol in string. | Malformed OCC or contract string. |
| **412** | Contract not available for trading. | Delisted, halted at exchange level, or not supported. |
| **517** | Unknown contract. | conId not recognized. |

### 4d. PRICE VALIDATION

| Code | Message | Action |
|---|---|---|
| **109** | Price out of range (precautionary). | Price outside user-configured safety limits. |
| **110** | Price does not conform to minimum tick variation. | Wrong tick size (e.g., $0.03 ticks for an option). |
| **163** | Violates percentage constraint. | Price too far from reference. |
| **164** | No market data to check price violation. | Cannot validate -- no reference data available. |
| **382** | Price violates tick constraint. | Exchange-specific tick size violation. |
| **403** | Invalid stop price. | Stop price on wrong side of market. |

### 4e. SIZE / QUANTITY

| Code | Message | Action |
|---|---|---|
| **100** | Max rate of messages/sec exceeded. | Rate limit: 50 messages/sec. Back off. |
| **160** | Order size must be positive. | Zero or negative quantity. |
| **388** | Order size below minimum requirement. | Exchange has minimum lot size. |
| **434** | Order size cannot be zero. | Explicit zero-size check. |

### 4f. MARGIN / RISK / ACCOUNT

| Code | Message | Action |
|---|---|---|
| **201** | Order rejected (with margin text). | **Insufficient margin is delivered as error 201** with "margin" or "buying power" in errorMsg. Parse the text. |
| **203** | Security not available for this account. | Account not authorized for this product. |
| **426** | Cannot enter short position with Cash account. | Need margin account for shorting. |
| **460** | **CRITICAL.** | Margin-related critical violation. Trigger immediate alert. |
| **10239** | Order affects account below required risk score. | Risk limits exceeded. |

### 4g. ORDER TYPE / TIF INCOMPATIBILITY

| Code | Message | Action |
|---|---|---|
| **111** | TIF and order type are incompatible. | e.g., GTC with MOC. |
| **113** | TIF for MOC/LOC must be DAY. | Market-on-close needs DAY TIF. |
| **387** | Unsupported order type for this exchange. | Exchange doesn't support the order type. |

### 4h. MARKET DATA WARNINGS (affect quote-dependent orders)

| Code | Message | Action |
|---|---|---|
| **354** | Not subscribed to market data. | Missing data subscription. Need subscription or use delayed. |
| **10090** | Some requested market data not subscribed. | Partial subscription issue. |
| **10197** | No market data during competing live session. | Another session consuming the same data subscription. Paper vs. live conflict. |

### 4i. INFORMATIONAL / CONNECTION STATUS (NOT errors)

| Code | Message | Handle |
|---|---|---|
| **2104** | Market data farm connection OK. | Log at debug. Do not treat as error. |
| **2106** | HMDS data farm connection OK. | Log at debug. |
| **2158** | Sec-def data farm connection OK. | Log at debug. |
| **2103** | Market data farm disconnected. | Warning. May affect live quotes. |
| **2105** | Historical data farm disconnected. | Warning. Affects historical queries only. |

### 4j. COMBO/SPREAD SPECIFIC

| Code | Message | Action |
|---|---|---|
| **312** | Combo details invalid. | BAG contract malformed. |
| **313** | Combo leg details invalid. | Individual leg spec wrong. |
| **314** | Security type requires combo leg details. | secType=BAG but no legs provided. |
| **315** | Combo legs routing restricted. | Exchange doesn't support this combo routing. |
| **325** | Discretionary orders not supported for combos. | Use LMT without discretionary for combos. |

---

## 5. Execution Details (execDetails)

### Callback Signature

```java
void execDetails(int reqId, Contract contract, Execution execution)
```

### Execution Class Fields

| Field | Type | Description |
|---|---|---|
| `orderId` | int | API client order ID. |
| `execId` | String | Unique execution ID. Each partial fill has a distinct execId. |
| `time` | String | Server-side execution timestamp. |
| `acctNumber` | String | Account the order was allocated to. |
| `exchange` | String | Exchange where execution occurred. |
| `side` | String | `"BOT"` (bought) or `"SLD"` (sold). |
| `shares` | Decimal | Number of shares/contracts in THIS fill. |
| `price` | double | Fill price (excludes commissions). |
| `permId` | int | Permanent account-wide order ID. 0 for external trades. |
| `clientId` | int | Client ID that placed the order. |
| `liquidation` | int | **Non-zero if IB-initiated liquidation.** This is how to detect forced liquidations. |
| `cumQty` | Decimal | Cumulative filled quantity across all fills. |
| `avgPrice` | double | Volume-weighted average price across all fills. |
| `orderRef` | String | User-set reference string. |
| `evRule` | String | Economic value rule name. |
| `evMultiplier` | double | Economic value multiplier. |
| `modelCode` | String | Model code identifier. |
| `lastLiquidity` | Liquidity | Liquidity type of this execution (Added, Removed, Resting). |
| `pendingPriceRevision` | boolean | Whether this execution has a pending price revision. |

### When Does execDetails Fire?

- **Every partial fill** produces a separate execDetails callback.
- Fires BEFORE the corresponding orderStatus callback (typically).
- After reconnection, can request missed executions via `reqExecutions()`.
- Only returns executions since midnight (current trading day).

### Execution Corrections

If an exchange publishes a correction to an execution:
- A NEW execDetails callback fires with **all parameters identical EXCEPT execId**.
- The corrected execId differs only in the digits after the final period.
- Example: original `0001e0d1.654321.01.01`, correction `0001e0d1.654321.01.02`.
- **You MUST detect this** or you will double-count fills.

### Callback Sequence (Per Fill)

```
1. execDetails()           -- fill details
2. orderStatus()           -- updated filled/remaining counts
3. openOrder()             -- updated order state
4. commissionAndFeesReport() -- commission for this fill
5. updatePortfolio()       -- position change (if subscribed)
```

---

## 6. Commission Reports

### Callback Signature (TWS API 10.40)

```java
void commissionAndFeesReport(CommissionAndFeesReport report)
```

Note: In TWS API 10.40, the old `commissionReport(CommissionReport)` was renamed.

### CommissionAndFeesReport Fields

| Field | Type | Description |
|---|---|---|
| `execId` | String | Links to the `Execution.execId`. One report per execution. |
| `commissionAndFees` | double | Total commission + fees for this execution. |
| `currency` | String | Currency of the commission (e.g., "USD"). |
| `realizedPNL` | double | Realized P&L from this execution. `Double.MAX_VALUE` if not applicable. |
| `yield` | double | Income return. `Double.MAX_VALUE` if not applicable. |
| `yieldRedemptionDate` | int | Date in YYYYMMDD format. 0 if not applicable. |

### Timing

- Fires AFTER the corresponding execDetails callback.
- One commissionAndFeesReport per execDetails (1:1 mapping via execId).
- May be delayed -- do not assume synchronous delivery.
- On reconnection, commission reports for today's executions are replayed.

### Correlating Commissions to Fills

```
execDetails(execId="001.002.003") -> commissionAndFeesReport(execId="001.002.003")
```

The `execId` is the join key. Store commissions keyed by execId.

---

## 7. Account / Margin Events

### reqAccountUpdates Subscription

Subscribe via `reqAccountUpdates(true, accountId)`. Delivers:

- `updateAccountValue(key, value, currency, account)` -- every 3 minutes or on position change
- `updatePortfolio(contract, position, marketPrice, marketValue, avgCost, unrealizedPNL, realizedPNL, account)` -- per-position updates

### Key Account Values

| Key | Meaning |
|---|---|
| `NetLiquidation` | Total account value (securities + cash). |
| `AvailableFunds` | Cash available for new trades. |
| `BuyingPower` | Leverage-adjusted buying power. |
| `MaintMarginReq` | Current maintenance margin requirement. |
| `InitMarginReq` | Current initial margin requirement. |
| `Cushion` | Margin cushion percentage (excess liquidity / net liq). **Below ~5% = danger.** |
| `ExcessLiquidity` | How much above maintenance margin. **0 or negative = liquidation imminent.** |
| `SMA` | Special Memorandum Account value (Reg T). |
| `GrossPositionValue` | Sum of absolute position values. |
| `accountReady` | Boolean. If `false`, account data is stale/unreliable. |

### WhatIf Orders (Pre-Trade Margin Check)

Set `Order.whatIf = true` before calling `placeOrder()`. Instead of routing to exchange, IB returns margin impact via `openOrder()` with `OrderState` fields:

| Field | Type | Meaning |
|---|---|---|
| `initMarginBefore` | String | Account initial margin BEFORE this order. |
| `maintMarginBefore` | String | Account maintenance margin BEFORE. |
| `equityWithLoanBefore` | String | Account equity BEFORE. |
| `initMarginChange` | String | Change in initial margin from this order. |
| `maintMarginChange` | String | Change in maintenance margin. |
| `equityWithLoanChange` | String | Change in equity. |
| `initMarginAfter` | String | Initial margin AFTER order. |
| `maintMarginAfter` | String | Maintenance margin AFTER. |
| `equityWithLoanAfter` | String | Equity AFTER. |
| `commission` | double | Estimated commission. |
| `warningText` | String | Warning messages (e.g., price cap risk). |

### Liquidation Detection

There is **no explicit liquidation callback**. Detection methods:

1. **`Execution.liquidation != 0`** in execDetails: The fill was IB-initiated liquidation.
2. **`Cushion` dropping toward 0** in account updates: Margin call imminent.
3. **`ExcessLiquidity <= 0`**: Account in margin violation, liquidation may begin.
4. **Error 460**: Margin-related critical violation on an order.
5. **Error 201**: Order rejected with "margin" or "buying power" in message text.

**Recommendation**: Subscribe to account updates. Alert on `Cushion < 10%`.
Alert CRITICAL on `Cushion < 5%`. Monitor `Execution.liquidation` on every fill.

---

## 8. Market Data Edge Cases

### Market Data Types

| Type | ID | Behavior |
|---|---|---|
| Live | 1 | Real-time streaming. Default when subscribed. |
| Frozen | 2 | Last recorded quote at market close. Returned after close. |
| Delayed | 3 | 15-20 minute delayed data. Free. Auto-fallback without subscription. |
| Delayed-Frozen | 4 | Delayed data frozen at close. For unsubscribed users after hours. |

### Halted Securities (Tick Type 49)

| Value | Meaning |
|---|---|
| -1 | Halt status unavailable (common with frozen data). |
| 0 | Not halted (only returned if contract is in a watchlist). |
| 1 | General halt (regulatory or volatility, combined indicator). |
| 2 | Volatility halt specifically. |

### Outside Market Hours

- `reqMktData` returns frozen/delayed-frozen data (last close prices).
- Bid/Ask may return -1 (no quote available).
- `tickSnapshotEnd` still fires, but data may be sparse/incomplete.
- Options with no after-hours activity: bid/ask = -1, last = previous close.

### Error Scenarios

| Scenario | Error Code | Behavior |
|---|---|---|
| No subscription | 354 | "Not subscribed to market data" |
| Competing session | 10197 | Paper + live sharing subscription, different devices |
| Expired contract | 200 | No security definition found |
| Delisted/invalid | 200 | Same as above |
| Exchange down | 2103/2105 | Market data farm disconnected |

---

## 9. Combo/Spread Order Specifics

### BAG Order Basics

- `secType = "BAG"` with `comboLegs` list.
- Up to 6 legs supported (some exchanges limit to 4).
- Symbol is the underlying (or comma-separated for inter-commodity).

### Guaranteed vs. Non-Guaranteed

| Type | Behavior | Risk |
|---|---|---|
| **Guaranteed** | Exchange executes all legs simultaneously in ratio. | Fills or doesn't. No partial leg risk. |
| **Non-Guaranteed** | SMART-routed, legs may fill independently. | **One leg can fill without the other.** This is legging risk. |

For SMART-routed combos, `NonGuaranteed=1` in `smartComboRoutingParams` is REQUIRED.

### Leg Priority Control

For two-legged combos only:

| LeginPrio Value | Meaning |
|---|---|
| -1 | No priority (default) |
| 0 | Execute first leg first |
| 1 | Execute second leg first |

### What Happens When One Leg Fills (Non-Guaranteed)

With non-guaranteed combos routed via SMART:
1. Each leg is routed independently for best execution.
2. If leg A fills but leg B cannot, you hold a naked partial position.
3. IB does NOT automatically unwind the filled leg.
4. You receive separate execDetails per leg fill.
5. The orderStatus shows the combo order as "Submitted" until all legs fill.
6. If the remaining leg(s) cannot fill, the combo stays open indefinitely (GTC)
   or until the unfilled portion is cancelled.

### Combo Execution Reports

- Each leg fill generates its own `execDetails` and `commissionAndFeesReport`.
- The `orderId` is the same for all legs (it is the combo order ID).
- `Execution.shares` reflects the individual leg quantity.
- `Execution.side` shows BOT/SLD per leg (may differ across legs for spreads).

---

## 10. Connection Loss & Recovery

### What Happens to Open Orders When Connection Drops

1. **Orders already at exchange**: Continue working. They exist independently of
   API connection.
2. **Simulated orders (PreSubmitted)**: Held by IB servers. Survive API disconnect
   but NOT a TWS/Gateway shutdown.
3. **PendingSubmit orders**: May or may not have reached the exchange. Unknown state
   until reconnection.

### Recovery After Reconnect

1. Call `reqOpenOrders()` to get all active orders with current status.
2. Call `reqExecutions(filter)` to get fills that occurred while disconnected
   (today's executions only).
3. Compare against local state to detect missed fills.
4. Commission reports for today's executions are also replayed.

### Order ID Management

- `nextValidId` callback fires on connect with the next safe order ID.
- Order IDs must be monotonically increasing within a session.
- **permId** is permanent and account-wide -- use it to correlate orders across reconnects.
- `orderBound()` callback maps API orderId to permId.

### Auto-Reconnect Pattern

```
1. connectionClosed() fires
2. Set connected = false
3. Fail all pending CompletableFutures
4. Check maintenance window (00:15-01:45 ET daily)
5. Wait RECONNECT_DELAY_MS
6. Call connect()
7. Wait for nextValidId() callback -> connected = true
8. Re-establish account subscriptions
9. Call reqOpenOrders() and reqExecutions() to sync state
```

---

## 11. Rate Limits and Throttling

| Limit | Value | Error Code |
|---|---|---|
| Messages per second | 50 | 100 |
| Concurrent market data subscriptions | Varies by plan (100 default) | 101 |
| Market depth requests | 3 simultaneous | 309 |
| Historical data pacing | 60 requests in 10 minutes | 162 |

---

## 12. completedOrders (Historical Order Retrieval)

`reqCompletedOrders(apiOnly)` returns filled AND cancelled orders.
- Active (open) orders: use `reqOpenOrders()` / `reqAllOpenOrders()`.
- Completed orders: use `reqCompletedOrders()`.
- Callbacks: `completedOrder()` and `completedOrdersEnd()`.
- Cannot retrieve open orders from `reqCompletedOrders` and vice versa.

---

## 13. Gaps In Current Sidecar Implementation

Based on review of `TwsBridge.java` and `OrderRoutes.java`:

### Missing Handlers (HIGH PRIORITY)

1. **execDetails is a no-op.** We receive fill details but discard them. Need to:
   - Capture `Execution.liquidation` to detect IB-initiated liquidations.
   - Forward fill events via WebSocket for TS client to record.
   - Track `execId` for execution correction detection.

2. **No execution correction detection.** If an exchange corrects a fill, we
   would double-count it.

3. **commissionAndFeesReport only logs at debug.** Commission data should be
   forwarded to TS client for trade recording.

4. **ORDER_ERROR_CODES is incomplete.** Currently: `{110, 201, 202, 460}`.
   Missing critical codes: 200, 203, 392, 399, 404, 412, 426, 10239.

5. **No handling for Inactive -> Submitted recovery.** If an order goes Inactive
   due to short-locate then recovers, the TS client is not informed.

6. **No WhatIf order support.** Pre-trade margin check not exposed.

### Missing Handlers (MEDIUM PRIORITY)

7. **No account update subscription.** Cannot detect margin deterioration.
8. **No halted stock detection.** Tick type 49 not monitored.
9. **`whyHeld` and `mktCapPrice` not forwarded** in order status events.
10. **No completedOrders support.** Cannot retrieve historical filled/cancelled orders.

### Potential Issues

11. **orderStatus completes the pending future immediately.** If the first status
    is PendingSubmit, the REST endpoint returns that -- but the order may later go
    Inactive or be rejected. The TS client must poll or use WebSocket to track.

12. **5-second timeout** on order placement is aggressive. Orders can take longer
    to get initial status during high-volume periods.

---

## 14. Recommended Error Handling Classification

For the TS client (`ws-listener.ts` and `OrderManager`), classify errors:

### FATAL (Stop trying, alert human)

- 200: Contract not found
- 201: Order rejected (parse message for specifics)
- 203: Security not available
- 392: Expired contract
- 404: Shares not available
- 412: Contract not available
- 426: Cash account cannot short
- 460: Margin violation

### RETRYABLE (Back off and retry)

- 100: Rate limit exceeded (wait 1 second)
- 133: Submit failed (retry once)
- 134: Modify failed (retry once)
- 502: Connection failed (reconnect)
- 504: Not connected (reconnect)

### INFORMATIONAL (Log only)

- 2104, 2106, 2158: Data farm connections OK
- 399: Order warning (log the warning text)
- 202: Order cancelled (if we requested the cancel)

### ALERT (Notify human, do not retry)

- 1100: Connectivity lost
- 460: Margin violation
- `Execution.liquidation != 0`: IB forced liquidation
- `Cushion < 5%`: Margin call imminent

---

## Sources

- [TWS API: Placing Orders](https://interactivebrokers.github.io/tws-api/order_submission.html)
- [TWS API: Message Codes](https://interactivebrokers.github.io/tws-api/message_codes.html)
- [TWS API: Error Handling](https://interactivebrokers.github.io/tws-api/error_handling.html)
- [TWS API: Executions and Commissions](https://interactivebrokers.github.io/tws-api/executions_commissions.html)
- [TWS API: Retrieving Open Orders](https://interactivebrokers.github.io/tws-api/open_orders.html)
- [TWS API: EWrapper Interface](https://interactivebrokers.github.io/tws-api/interfaceIBApi_1_1EWrapper.html)
- [TWS API: Execution Class](https://interactivebrokers.github.io/tws-api/classIBApi_1_1Execution.html)
- [TWS API: CommissionReport Class](https://interactivebrokers.github.io/tws-api/classIBApi_1_1CommissionReport.html)
- [TWS API: OrderState Class](https://interactivebrokers.github.io/tws-api/classIBApi_1_1OrderState.html)
- [TWS API: Account Updates](https://interactivebrokers.github.io/tws-api/account_updates.html)
- [TWS API: Margin Checking](https://interactivebrokers.github.io/tws-api/margin.html)
- [TWS API: Market Data Types](https://interactivebrokers.github.io/tws-api/market_data_type.html)
- [TWS API: Tick Types](https://interactivebrokers.github.io/tws-api/tick_types.html)
- [TWS API: Spread Contracts](https://interactivebrokers.github.io/tws-api/spread_contracts.html)
- [TWS API: Connectivity](https://interactivebrokers.github.io/tws-api/connection.html)
- [TWS API: Automated Considerations](https://interactivebrokers.github.io/tws-api/automated_considerations.html)
- [TWS API: ComboLeg Class](https://interactivebrokers.github.io/tws-api/classIBApi_1_1ComboLeg.html)
- [IBKR Campus: Placing Orders](https://www.interactivebrokers.com/campus/trading-lessons/python-placing-orders/)
- [IBKR Campus: Complex Orders](https://www.interactivebrokers.com/campus/trading-lessons/python-complex-orders/)
