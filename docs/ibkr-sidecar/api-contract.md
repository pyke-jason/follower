# Sidecar API Contract

> Source of truth for the Java sidecar REST + WebSocket API.
> Base URL: `http://localhost:8090`
> WebSocket: `ws://localhost:8090/events`

---

## REST Endpoints

### GET /api/status

Health/connection check. No guards -- always returns 200.

**Response 200:**
```jsonc
{
  "connected":     boolean,  // bridge.isConnected()
  "accountId":     string,   // e.g. "U14368257", "" before first connect
  "serverVersion": number,   // e.g. 215, 0 before first connect
  "wsClients":     number,   // active WebSocket sessions
  "maintenance":   boolean   // true if 00:15-01:45 ET
}
```

---

### POST /api/contracts/resolve

Resolve a contract to get its conId. **Guards: connected.**

**Request:**
```jsonc
{
  "symbol":   string,          // required for meaningful results
  "secType":  string,          // default "STK". Options: "OPT"
  "exchange": string,          // default "SMART"
  "currency": string,          // default "USD"
  "expiry":   string,          // YYYYMMDD -- options only
  "strike":   number,          // options only
  "right":    string           // "C" or "P" -- options only
}
```

**Response 200:**
```jsonc
{
  "conId":       number,   // e.g. 265598 (AAPL), 744724202 (SPY call)
  "localSymbol": string,   // e.g. "AAPL", "SPY   260320C00580000"
  "multiplier":  string,   // e.g. "100", "100.0"
  "exchange":    string    // e.g. "SMART"
}
```

**Error responses:**

| Status | Shape | When |
|---|---|---|
| 503 | `{ "error": "Not connected to IB Gateway" }` | Disconnected |
| 504 | `{ "error": "Contract resolution timed out" }` | 5s timeout |
| 422 | `{ "error": "No contract found", "detail": string }` | No match |
| 500 | `{ "error": string }` | TWS error |

**Edge cases:**
- If multiple contracts match, only the first is returned.
- No maintenance window check.

---

### POST /api/market-data/snapshot

Get a market data snapshot. **Guards: connected.**

**Request (mode 1 -- by conId):**
```jsonc
{
  "conId": number   // resolved contract ID
}
```

**Request (mode 2 -- by symbol):**
```jsonc
{
  "symbol":   string,
  "secType":  string,   // default "STK"
  "exchange": string,   // default "SMART"
  "currency": string,   // default "USD"
  "expiry":   string,   // optional
  "strike":   number,   // optional
  "right":    string    // optional
}
```

**Response 200:** All fields optional -- depends on what TWS returns.
```jsonc
{
  "bid":    number,   // tickPrice field=1
  "ask":    number,   // tickPrice field=2
  "last":   number,   // tickPrice field=4
  "close":  number,   // tickPrice field=9
  "volume": number    // tickSize field=8
}
```

**Error responses:**

| Status | Shape | When |
|---|---|---|
| 503 | `{ "error": "Not connected to IB Gateway" }` | Disconnected |
| 504 | `{ "error": "Market data snapshot timed out" }` | 5s timeout |
| 500 | `{ "error": string }` | TWS error |

**Edge cases:**
- Response can be `{}` if no ticks arrived (illiquid, outside hours).
- `symbol` is NOT included in the response -- the caller must track it.
- No maintenance window check.

---

### POST /api/orders/single

Place a single-contract order. **Guards: connected + not maintenance.**

**Request:**
```jsonc
{
  "conId":      number,   // REQUIRED -- resolved contract ID
  "action":     string,   // REQUIRED -- "BUY" or "SELL"
  "quantity":   number,   // REQUIRED -- integer
  "orderType":  string,   // default "LMT"
  "tif":        string,   // default "GTC"
  "limitPrice": number    // optional -- rounded by tick rules (see below)
}
```

**Tick rounding:** `limitPrice < $3.00` -> $0.01 increments. `>= $3.00` -> $0.05 increments.
Exchange hardcoded to `"SMART"`.

**Response 200 (order accepted):**
```jsonc
{
  "orderId":        number,
  "status":         string,   // e.g. "Submitted", "PreSubmitted", "Filled"
  "filledQuantity": number,   // 0 on submission
  "remaining":      number,   // = quantity on submission
  "avgFillPrice":   number    // 0.0 on submission
}
```

**Response 200 (timeout -- order may still be accepted):**
```jsonc
{
  "orderId": number,
  "status":  "PendingSubmit"
}
```

**Error responses:**

| Status | Shape | When |
|---|---|---|
| 503 | `{ "error": "Not connected to IB Gateway" }` | Disconnected |
| 503 | `{ "error": "Maintenance window", "retryAfter": number }` | 00:15-01:45 ET. `retryAfter` = seconds until 01:45 |
| 400 | `{ "error": string, "orderId": number }` | TWS rejected the order |

---

### POST /api/orders/combo

Place a BAG (spread/combo) order. **Guards: connected + not maintenance.**

**Request:**
```jsonc
{
  "symbol":     string,   // REQUIRED -- underlying, e.g. "SPY"
  "action":     string,   // REQUIRED -- "BUY" or "SELL"
  "quantity":   number,   // REQUIRED -- integer
  "legs": [               // REQUIRED -- array of legs
    {
      "conId":    number,   // REQUIRED
      "action":   string,   // REQUIRED -- "BUY" or "SELL"
      "ratio":    number,   // default 1
      "exchange": string    // default "SMART"
    }
  ],
  "orderType":  string,   // default "LMT"
  "tif":        string,   // default "GTC"
  "limitPrice": number    // optional -- net debit/credit for the spread
}
```

**Note:** `NonGuaranteed=1` is hardcoded by the sidecar. Do NOT send `nonGuaranteed` in the body.

**Responses:** Identical shapes to `POST /api/orders/single`.

---

### GET /api/orders/{orderId}

Poll order status. **Guards: none** (reads from in-memory map).

**Response 200:**
```jsonc
{
  "orderId":        number,
  "status":         string,     // TWS status string
  "filledQuantity": number,
  "remaining":      number,
  "avgFillPrice":   number,
  "commission":     number      // OPTIONAL -- only if openOrder reported it
}
```

**Response 404:**
```jsonc
{ "error": "Order not found", "orderId": number }
```

**Edge cases:**
- Works even when disconnected (reads from memory).
- Data is lost on sidecar restart.
- `commission` only present when `orderState.commissionAndFees() != Double.MAX_VALUE`.

---

### PUT /api/orders/{orderId}

Modify an existing order. **Guards: connected + not maintenance.**
The sidecar looks up the original Contract + Order from its in-memory `orderStore`
and merges the new `limitPrice` before re-submitting to TWS.

**Request:**
```jsonc
{
  "limitPrice": number    // the field being modified
}
```

**Response 404 (order not in store):**
```jsonc
{ "error": "Order not in store -- cannot modify", "orderId": number }
```
This happens if the sidecar restarted since the order was placed (store is in-memory only).

**Responses (success/timeout/error):** Identical shapes to `POST /api/orders/single`.

---

### DELETE /api/orders/{orderId}

Cancel an order. **Guards: connected.** Fire-and-forget -- returns immediately.

**Response 200:**
```jsonc
{
  "orderId": number,
  "status":  "PendingCancel"
}
```

**Error responses:**

| Status | Shape | When |
|---|---|---|
| 503 | `{ "error": "Not connected to IB Gateway" }` | Disconnected |

**Edge cases:**
- No 404 check. Cancelling a non-existent order returns 200; TWS error arrives via WebSocket.
- No maintenance window check (you should always be able to cancel).

---

### GET /api/account/summary

Account balance snapshot. **Guards: connected.** Two code paths -- warm (subscription active) and cold (fallback).

**Response 200 (warm -- `reqAccountUpdates` subscription active):**
```jsonc
{
  "netLiquidation":     number,
  "availableFunds":     number,
  "maintenanceMargin":  number,
  "unrealizedPnl":      number,
  "cushion":            number,   // margin cushion percentage
  "sma":                number,   // Special Memorandum Account
  "dayTradesRemaining": number,   // PDT day-trades remaining
  "excessLiquidity":    number    // excess liquidity
}
```
Warm path: normal steady-state after `managedAccounts()` fires `reqAccountUpdates()`.

**Response 200 (cold-start -- subscription not yet active):**
```jsonc
{
  "netLiquidation":    number,
  "availableFunds":    number,
  "maintenanceMargin": number,
  "unrealizedPnl":     number
}
```
Cold path: one-shot `reqAccountSummary()` with only 4 tags. Only in the brief window between connect and the first `accountDownloadEnd` callback.

**Error responses:**

| Status | Shape | When |
|---|---|---|
| 503 | `{ "error": "Not connected to IB Gateway" }` | Disconnected |
| 504 | `{ "error": "Account summary timed out" }` | 5s timeout (cold path only) |
| 500 | `{ "error": string }` | Other (cold path only) |

---

### GET /api/positions

Current positions. **Guards: connected.**

**Response 200:** Array of positions.
```jsonc
[
  {
    "conId":          number,
    "symbol":         string,   // underlying symbol
    "secType":        string,   // "STK", "OPT", etc.
    "localSymbol":    string,   // OCC-format for options, "" if null
    "position":       number,   // signed: positive=long, negative=short
    "avgCost":        number,   // per-share/contract average cost
    "marketValue":    number,   // OPTIONAL -- enriched from reqAccountUpdates
    "unrealizedPnl":  number    // OPTIONAL -- enriched from reqAccountUpdates
  }
]
```

**NOTE:** `marketValue` and `unrealizedPnl` come from the `reqAccountUpdates()` portfolio
subscription, NOT from `reqPositions()` itself. Absent during cold start.

**Error responses:**

| Status | Shape | When |
|---|---|---|
| 503 | `{ "error": "Not connected to IB Gateway" }` | Disconnected |
| 504 | `{ "error": "Positions request timed out" }` | 5s timeout |
| 500 | `{ "error": string }` | Other |

---

## WebSocket Events

Connect to `ws://localhost:8090/events`. All events are JSON with a `type` discriminator.

### connected
```jsonc
{ "type": "connected" }
```
Fires when TWS connection handshake completes (`nextValidId` callback).

### disconnected
```jsonc
{ "type": "disconnected" }
```
Fires on TCP drop (`connectionClosed`) or TWS error codes 1100/504.

### reconnected
```jsonc
{ "type": "reconnected" }
```
Fires on TWS error codes 1101 (data lost) or 1102 (data maintained).

### orderStatus
```jsonc
{
  "type":         "orderStatus",
  "orderId":      number,
  "status":       string,      // TWS status string
  "filled":       number,      // as double (NOT long like REST)
  "remaining":    number,      // as double
  "avgFillPrice": number
}
```
Fires on EVERY order status change.

### execDetails
```jsonc
{
  "type":        "execDetails",
  "execId":      string,
  "orderId":     number,
  "symbol":      string,   // underlying symbol
  "side":        string,   // "BOT" or "SLD"
  "quantity":    number,
  "price":       number,
  "time":        string,   // execution timestamp (TWS format)
  "liquidation": number    // 0 = normal, non-zero = IB forced liquidation
}
```

### commission
```jsonc
{
  "type":       "commission",
  "execId":     string,   // correlates with execDetails.execId
  "commission": number,
  "orderId":    number    // -1 if execution not found in store
}
```
Suppressed when `commissionAndFees == Double.MAX_VALUE` (not yet calculated).

### error
```jsonc
{
  "type":    "error",
  "code":    number,      // TWS error code
  "message": string,
  "orderId": number       // OPTIONAL -- only when orderId > 0
}
```
Fires for order error codes: **110**, **200**, **201**, **202**, **203**, **392**, **399**, **404**, **412**, **426**, **460**, **10239** (12 codes total).
All other TWS errors are logged server-side but NOT broadcast to WebSocket clients.

---

## Internal Architecture

### Request/Response Flow
```
REST handler -> getNextReqId() -> createRequest(reqId) -> client.reqXxx()
                                                           |
                                            TWS async callback fires
                                                           |
                                         completeRequest(reqId, result)
                                            or failRequest(reqId, error)
                                                           |
                                     awaitRequest() returns (5s timeout)
```

### Timeout: 5 seconds (`REQUEST_TIMEOUT_SECONDS`)
- On timeout: `CompletableFuture` stays in `pendingRequests` map (potential memory leak)
- Late callbacks are silently consumed (future already timed out)
- **Fix needed:** Add `pendingRequests.remove(reqId)` in timeout handler

### Persistent data (survives across requests, lost on restart)
- `orderStatuses` -- `ConcurrentHashMap<orderId, statusMap>` -- written by `orderStatus` + `openOrder` callbacks
- `orderStore` -- `ConcurrentHashMap<orderId, StoredOrder>` -- stores original Contract+Order from placement. Used by `PUT /orders/{id}` for modification.
- `executionStore` -- `ConcurrentHashMap<execId, Map>` -- stores execution details from `execDetails`. Used by `commissionAndFeesReport` to correlate commission with orderId.
- `accountValues` -- `ConcurrentHashMap<String, String>` -- continuously updated by `reqAccountUpdates` subscription. Only stores USD-currency or empty-currency values.
- `portfolioPositions` -- `ConcurrentHashMap<conId, Map>` -- continuously updated by `reqAccountUpdates`. Used to enrich positions with `marketValue` and `unrealizedPnl`.
- `accountId`, `connected`, `serverVersion` -- volatile fields

### Maintenance window
- 00:15-01:45 ET daily (sidecar-imposed guard, not an IB enforcement)
- **Blocks:** POST orders/single, POST orders/combo, PUT orders/{id}
- **Does NOT block:** DELETE orders/{id}, GET orders/{id}, contracts/resolve, market-data, account/summary, positions
- Returns `{ "error": "Maintenance window", "retryAfter": seconds }` with 503

### reqAccountUpdates subscription
- Triggered automatically by `managedAccounts()` callback (fires on connect after `nextValidId`)
- Calls `client.reqAccountUpdates(true, accountId)` -- a persistent subscription (no reqId)
- Streams `updateAccountValue()` and `updatePortfolio()` callbacks continuously
- `accountDownloadEnd()` fires once on initial snapshot completion -> sets `accountSubscriptionActive=true`
- **Risk:** Error 2100 from TWS means another client took over the subscription. Not currently handled.

### Auto-reconnect
- Thread `"reconnect-scheduler"` spawns on disconnect
- 5s fixed delay between attempts (no backoff)
- Defers during maintenance window (sleeps 60s, rechecks)
- Stops when `connected=true` or `shuttingDown=true`

### Healthcheck ping
- Pings `HEALTHCHECK_PING_URL` every 60 seconds from daemon thread
- Appends `/fail` when `bridge.isConnected() == false`
- Disabled when `HEALTHCHECK_PING_URL` not set, `HEALTHCHECK_ENABLED=0`, or paper trading (port 4002)
