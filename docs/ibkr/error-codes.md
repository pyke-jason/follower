# IBKR TWS Error Codes

> Verified against [TWS API Message Codes](https://interactivebrokers.github.io/tws-api/message_codes.html) and [EClientErrors](https://interactivebrokers.github.io/tws-api/classIBApi_1_1EClientErrors.html).

## Error Callback Signature

**Pre-10.33 (4 params):**
```java
void error(int id, int errorCode, String errorMsg, String advancedOrderRejectJson)
```

**10.33+ (5 params, added December 2024):**
```java
void error(int id, long errorTime, int errorCode, String errorMsg, String advancedOrderRejectJson)
```

- `id = -1` -- system-wide (farm connections, connectivity)
- `id >= 0` -- tied to specific order or request
- `errorTime` -- epoch timestamp of when the error occurred (NOT a request ID)
- `advancedOrderRejectJson` -- FIX Tag 8230 rejection details + Tag 8229 override codes. Can populate `Order.advancedErrorOverride` to retry with override. Introduced in TWS 10.14.

---

## Error Classification

### CONNECTION -- Triggers reconnect logic

| Code | Message | Action |
|---|---|---|
| **502** | Couldn't connect to TWS | TWS not running, wrong port, firewall. Fatal until resolved |
| **504** | Not connected | Socket disconnected. All pending requests fail |
| **507** | Bad message length | Connection corrupted (Java: socket EOF). Reconnect |
| **509** | Socket exception | Network failure. Client-side only. Reconnect |
| **1100** | Connectivity between IB and TWS lost | **CRITICAL.** Stop trading. Wait for 1101/1102 |
| **1101** | Connectivity restored -- data lost | Re-subscribe ALL: market data, accounts, orders |
| **1102** | Connectivity restored -- data maintained | Subscriptions intact. Verify open order states |
| **1300** | Socket port reset | Full reconnect (eDisconnect + eConnect) |
| **2110** | TWS-server connectivity broken | Auto-restore in progress. Wait for 1101/1102 |

### FATAL -- Stop trying, alert human

| Code | Message | Notes |
|---|---|---|
| **200** | No security definition found | Wrong symbol/conId/expiry/strike |
| **201** | Order rejected -- Reason: [text] | Parse message: margin, size, regulatory, PDT, permissions |
| **203** | Security not available for this account | Trading permissions not enabled. Fix in Account Management |
| **392** | Expired contract | Option/future expired |
| **404** | Shares not available for short sale | No borrow. Order held while locate attempted (`whyHeld = "locate"`) |
| **412** | Contract not available for trading | Delisted, halted, or unsupported |
| **426** | None of the accounts have enough shares | FA allocation context -- insufficient shares across allocation accounts |

### RETRYABLE -- Back off and retry

| Code | Message | Notes |
|---|---|---|
| **100** | Max rate of messages per second exceeded | 50 msg/sec default (= MaxMarketDataLines/2). Back off. 3 violations without `+PACEAPI` = disconnect |
| **133** | Submit new order failed | Internal IB error. Retry once |
| **134** | Modify order failed | Internal IB error. Retry once |
| **2102** | Unable to modify (being processed) | Retry after short delay |

### ORDER VALIDATION

| Code | Message | Notes |
|---|---|---|
| **103** | Duplicate order ID | Fix order ID allocation |
| **104** | Can't modify filled order | State is stale |
| **105** | Order modification doesn't match original | Wrong order ID or conflicting fields |
| **107** | Cannot transmit incomplete order | Missing required fields |
| **109** | Price out of range (precautionary) | Price too far from market per user safety limits |
| **110** | Price does not conform to minimum tick | Wrong tick size for this contract |
| **111** | TIF incompatible with order type | e.g., GTC with MOC |
| **113** | MOC/LOC must be DAY | Fix TIF |
| **135** | Can't find order to cancel | Already cancelled/filled |
| **136** | Cannot cancel order | Non-cancellable state |
| **154** | Orders cannot be transmitted (halted security) | Wait for halt to lift |
| **160** | Order size cannot be zero | Fix quantity |
| **161** | Cancel attempted on inactive order | Order already dead |
| **163** | Price violates percentage constraint | Price too far from reference |
| **164** | No market data to check price violation | Market data unavailable |
| **329** | Cannot change order type during modify | Must cancel and re-place |
| **382** | Price violates tick constraint | Round to valid tick |
| **387** | Unsupported order type for exchange | Use different order type |
| **388** | Order size below minimum | Below exchange minimum lot size |
| **399** | Order message/warning | **Ambiguous**: can be warning or rejection. Parse text. "Order will not be placed until..." = precautionary hold |
| **434** | Order size cannot be zero | Explicit zero-size check |

### MARGIN / RISK / ACCOUNT

| Code | Message | Notes |
|---|---|---|
| **201** | Order rejected (with margin text) | "Insufficient margin" / "buying power" in errorMsg. Parse the text |
| **203** | Security not available for this account | Account not authorized for product |
| **346** | Not a privileged account | Lacks permissions |

### COMBO/SPREAD SPECIFIC

| Code | Message | Notes |
|---|---|---|
| **312** | Combo details invalid | BAG contract malformed |
| **313** | Combo leg details invalid | Specific leg issue |
| **314** | secType BAG requires combo leg details | Missing comboLegs |
| **315** | Combo legs routing restricted | Exchange doesn't support combo routing |
| **325** | Discretionary not supported for combos | Use LMT without discretionary |
| **10002** | Invalid non-guaranteed legs | Set NonGuaranteed=1 in smartComboRoutingParams |

### MARKET DATA

| Code | Message | Notes |
|---|---|---|
| **354** | Not subscribed to market data | Need subscription or enable delayed data |
| **10090** | Part of market data not subscribed | Partial subscription issue |
| **10186** | Not subscribed, delayed not enabled | More specific than 354 |
| **10197** | No market data during competing session | Paper vs live subscription conflict |

### HISTORICAL DATA

| Code | Message | Notes |
|---|---|---|
| **162** | Historical data service error | Parse text: "pacing violation" (retry 15s) vs "no data" (normal) |
| **166** | HMDS expired contract violation | Historical data for expired contracts |

### CLIENT-SIDE (generated by API library, not TWS)

| Code | Constant | Message |
|---|---|---|
| **501** | ALREADY_CONNECTED | Already connected. Ignore |
| **503** | UPDATE_TWS | TWS out of date. Upgrade |
| **505** | UNKNOWN_ID | Unknown message id. Protocol mismatch |
| **507** | BAD_LENGTH | Bad message length. Socket EOF |
| **508** | BAD_MESSAGE | Bad message. Connection corrupted |
| **509** | SOCKET_EXCEPTION | Exception caught while reading socket |
| **512** | FAIL_SEND_ORDER | Order sending error. **Dangerous**: order may or may not have been sent |
| **520** | FAIL_CREATE_SOCK | Failed to create socket |
| **530** | SSL_FAIL | SSL specific error |

### CONNECTION STATUS (id = -1, NOT errors)

| Code | Message | Action |
|---|---|---|
| **326** | Client ID already in use | Wait a few seconds or use different client ID. TWS-side error |
| **2100** | New account data requested, client unsubscribed | Another client called reqAccountUpdates. Re-subscribe |
| **2101** | Unable to subscribe to account | Client conflict |
| **2103** | Market data farm disconnected | Quotes will be stale |
| **2104** | Market data farm connection OK | Ready for market data |
| **2105** | Historical data farm disconnected | Historical queries will fail |
| **2106** | HMDS data farm connection OK | Historical data available |
| **2107** | Historical data farm inactive (on demand) | Normal dormancy |
| **2108** | Market data farm inactive (on demand) | Normal dormancy |
| **2109** | outsideRth attribute ignored | Order still accepted |
| **2158** | Sec-def data farm connection OK | Security definitions available |

On initial connection, expect a burst of 2104, 2106, 2158. Filter by `id == -1` and code range 2100-2199.

---

## Rate Limits

| Limit | Value | Error Code | Notes |
|---|---|---|---|
| Messages per second | 50 default | 100 | Formula: MaxMarketDataLines / 2. 200 lines = 100 msg/sec |
| Market data subscriptions | 100 default (expandable) | 101 | Shared between TWS display and all API connections |
| Active orders per contract per side | 20 | (201 text) | |
| Historical data: identical request | 15s cooldown | 162 | |
| Historical data: same contract | 6 in 2s | 162 | |
| Historical data: total requests | 60 in 10 min | 162 | BID_ASK requests count **double** |
| Concurrent historical requests | 50 | 162 | |
| Market depth requests | 3 simultaneous | 309 | |

**Prevention:** Call `SetConnectOptions("+PACEAPI")` before `eConnect()` to auto-throttle instead of disconnect on rate limit. Available since TWS 974+. May be auto-enabled in newer versions.

---

## Sources

- [TWS API Message Codes](https://interactivebrokers.github.io/tws-api/message_codes.html)
- [TWS API Error Handling](https://interactivebrokers.github.io/tws-api/error_handling.html)
- [TWS API EClientErrors Class](https://interactivebrokers.github.io/tws-api/classIBApi_1_1EClientErrors.html)
- [TWS API Order Limitations](https://interactivebrokers.github.io/tws-api/order_limitations.html)
- [TWS API Historical Data Limitations](https://interactivebrokers.github.io/tws-api/historical_limitations.html)
