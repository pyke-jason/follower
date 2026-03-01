# IBKR TWS Error Codes

> Complete error code reference for the TWS API.
> Error callback (TWS API 10.40+): `error(int id, long reqId, int errorCode, String errorMsg, String advancedOrderRejectJson)`
> `id = -1` → system-wide. `id >= 0` → tied to specific order/request.

---

## Classification for Our System

### FATAL — Stop trying, alert human

| Code | Message | Notes |
|---|---|---|
| **200** | No security definition found | Wrong symbol/conId/expiry/strike |
| **201** | Order rejected | Parse message: margin, size, regulatory, permissions |
| **203** | Security not available for this account | Trading permissions not enabled |
| **392** | Expired contract | Option/future expired |
| **404** | Shares not available for short sale | No borrow |
| **412** | Contract not available for trading | Delisted, halted, unsupported |
| **426** | Cash account cannot short | Need margin account |
| **460** | Margin violation | Insufficient margin |
| **10239** | Account risk score exceeded | Risk limits |

### RETRYABLE — Back off and retry

| Code | Message | Notes |
|---|---|---|
| **100** | Max rate of messages exceeded | Wait 1s. Use `+PACEAPI` to prevent disconnect |
| **133** | Submit new order failed | Internal IB error. Retry once |
| **134** | Modify order failed | Internal IB error. Retry once |
| **502** | Couldn't connect to TWS | TWS not running. Reconnect |
| **504** | Not connected | Socket disconnected. Reconnect |
| **507** | Bad message length | Connection corrupted. Reconnect |
| **2102** | Unable to modify (being processed) | Retry after short delay |

### CONNECTION — Triggers reconnect logic

| Code | Message | Action |
|---|---|---|
| **1100** | Connectivity lost | Set connected=false, stop trading, reconnect |
| **1101** | Restored, data lost | Re-subscribe ALL: market data, account, orders |
| **1102** | Restored, data maintained | Subscriptions intact. Verify open order states |
| **1300** | Socket port reset | Full reconnect (eDisconnect + eConnect) |
| **2110** | TWS-server connectivity broken | Auto-restore in progress. Wait |

### INFORMATIONAL — Log at debug, never treat as error

| Code | Message |
|---|---|
| **2104** | Market data farm connection OK |
| **2106** | HMDS data farm connection OK |
| **2107** | Historical data farm inactive (available on demand) |
| **2108** | Market data farm inactive (available on demand) |
| **2158** | Sec-def data farm connection OK |
| **2109** | outsideRth attribute ignored (order still accepted) |

### ALERT — Notify human, do not retry

| Code | Message | Severity |
|---|---|---|
| **1100** | Connectivity lost | warning |
| **460** | Margin violation | critical |
| `Execution.liquidation != 0` | IB forced liquidation | critical |
| `Cushion < 5%` | Margin call imminent | critical |
| **154** | Orders cannot be transmitted (halted security) | warning |

---

## Detailed Reference

### Connection & System (1100-1300)

| Code | Transient? | Message | Action |
|---|---|---|---|
| 1100 | Yes | Connectivity between IB and TWS lost | **CRITICAL.** Stop orders. Wait for 1101/1102. |
| 1101 | Yes | Connectivity restored — data lost | Re-subscribe ALL market data, accounts, orders |
| 1102 | Yes | Connectivity restored — data maintained | Existing subscriptions intact |
| 1300 | Yes | Socket port reset, connection being dropped | Full reconnect needed |

### Client-Side (500-599)

| Code | Transient? | Message | Action |
|---|---|---|---|
| 501 | No | Already connected | Ignore |
| 502 | Depends | Couldn't connect to TWS | Check config: port, API enabled, firewall |
| 503 | No | TWS out of date | Upgrade TWS/Gateway |
| 504 | Yes | Not connected | Reconnect first |
| 507 | Maybe | Bad message length | Connection corrupted. Reconnect |
| 512 | Yes | Order sending error | **Dangerous**: order may/may not have been sent |
| 517 | No | Unknown contract | Fix contract definition |

### Order Validation (100-168)

| Code | Transient? | Message | Action |
|---|---|---|---|
| 100 | Yes | Max message rate exceeded | 50 msg/sec. Back off. 3 strikes = disconnect |
| 103 | No | Duplicate order ID | Fix order ID allocation |
| 104 | No | Can't modify filled order | State is stale |
| 105 | No | Modify doesn't match original | Wrong order ID or conflicting fields |
| 107 | No | Cannot transmit incomplete order | Missing required fields |
| 109 | No | Price out of range (precautionary) | Price too far from market |
| 110 | No | Price does not conform to minimum tick | Wrong tick size for this contract |
| 111 | No | TIF incompatible with order type | e.g., GTC with MOC |
| 113 | No | MOC/LOC must be DAY | Fix TIF |
| 135 | No | Can't find order to cancel | Already cancelled/filled |
| 136 | No | Cannot cancel order | Non-cancellable state |
| 154 | Yes | Halted security — cannot transmit | Wait for halt to lift |
| 160 | No | Order size cannot be zero | Fix quantity |
| 161 | No | Cancel attempted on inactive order | Order already dead |
| 162 | Depends | Historical data service error | Parse text: "pacing violation" (retry 15s) vs "no data" (normal) |
| 163 | No | Price violates percentage constraint | Price too far from market |
| 164 | Yes | No market data to check price | Market data unavailable |
| 329 | No | Cannot change order type during modify | Must cancel and re-place |
| 382 | No | Price violates tick constraint | Round to valid tick |
| 387 | No | Unsupported order type for exchange | Use different order type |
| 388 | No | Order size below minimum | Below exchange minimum |
| 392 | No | Expired contract | Option/future expired |
| 399 | Depends | Order message/warning | **Ambiguous**: can be warning or rejection. Parse text. |

### Order Rejection (200-203)

| Code | Transient? | Message | Notes |
|---|---|---|---|
| **200** | No | No security definition found | Bad conId, wrong symbol, expired |
| **201** | Depends | Order rejected | **Parse message text** for: margin, size, regulatory, PDT |
| **202** | Depends | Order cancelled | System cancellation. Price too far, or IB risk system |
| **203** | No | Security not available for this account | Permanent. Fix in Account Management |

### Margin & Account

| Code | Transient? | Message | Notes |
|---|---|---|---|
| 201 | Depends | Order rejected (margin text) | "insufficient margin"/"buying power" in message |
| 203 | No | Security not available | Account not authorized |
| 346 | No | Not a privileged account | Lacks permissions |
| 426 | No | Cash account cannot short | Need margin account |
| 460 | No | Margin violation | Critical alert |

### Combo/Spread Specific

| Code | Message | Notes |
|---|---|---|
| 312 | Combo details invalid | BAG contract malformed |
| 313 | Combo leg details invalid | Specific leg issue |
| 314 | secType BAG requires legs | Missing comboLegs |
| 315 | Stock combos restricted to SMART | Set exchange=SMART |
| 325 | Discretionary not supported for combos | Use LMT without discretionary |
| 10002 | Invalid non-guaranteed legs | Set NonGuaranteed=1 |

### Market Data

| Code | Message | Notes |
|---|---|---|
| 354 | Not subscribed to market data | Need subscription or enable delayed |
| 10090 | Part of market data not subscribed | Partial subscription issue |
| 10197 | No market data during competing session | Paper vs live conflict |
| 2103 | Market data farm disconnected | Quotes will be stale |
| 2105 | Historical data farm disconnected | Historical queries fail |

---

## Our Sidecar's Current Error Handling

### What the sidecar broadcasts via WebSocket

Only these codes → WS `error` event: **110, 201, 202, 460**

### What's missing from `ORDER_ERROR_CODES`

Should be added to the sidecar's broadcast set:

| Code | Why |
|---|---|
| **200** | Bad contract — order will fail, client needs to know |
| **203** | Account restriction — permanent, alert needed |
| **392** | Expired contract — order dead |
| **399** | Order warning/rejection — ambiguous but important |
| **404** | No shares for short sale — actionable |
| **412** | Contract not tradeable — order dead |
| **426** | Cash account short restriction — permanent |
| **10239** | Risk score exceeded — account-level issue |

### What the sidecar silently drops

The `advancedOrderRejectJson` (5th error param) is **completely ignored**. This contains FIX Tag 8230 rejection details and Tag 8229 override codes. Not critical for our use case but good to know.

---

## Rate Limits

| Limit | Value | Error Code |
|---|---|---|
| Messages per second | 50 | 100 |
| Market data subscriptions | 100 default (expandable) | 101 |
| Active orders per contract per side | 20 | (201 text) |
| Historical data: identical request | 15s cooldown | 162 |
| Historical data: same contract | 6 in 2s | 162 |
| Historical data: total requests | 60 in 10 min | 162 |
| Concurrent historical requests | 50 | 162 |

**Prevention:** Call `SetConnectOptions("+PACEAPI")` before `eConnect()` to auto-throttle instead of disconnect on rate limit.
