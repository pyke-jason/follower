# IBKR Sidecar API Contract

> Source of truth for the Java sidecar REST + WebSocket API.
> Base URL: `http://localhost:8090`
> WebSocket: `ws://localhost:8090/events`

---

## Environment Variables

| Var | Default | Purpose |
|---|---|---|
| `IBKR_GATEWAY_HOST` | `127.0.0.1` | IB Gateway host |
| `IBKR_GATEWAY_PORT` | `4001` | Gateway port (4001=live, 4002=paper) |
| `IBKR_CLIENT_ID` | `1` | TWS client ID |
| `SIDECAR_PORT` | `8090` | HTTP server port |

---

## REST Endpoints

### GET /api/status

Health/connection check. No guards — always returns 200.

**Response 200:**
```jsonc
{
  "connected":     boolean,  // bridge.isConnected()
  "accountId":     string,   // e.g. "U14368257", "" before first connect
  "serverVersion": number,   // e.g. 215, 0 before first connect
  "wsClients":     number,   // active WebSocket sessions
  "maintenance":   boolean   // true if 00:15–01:45 ET
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
  "expiry":   string,          // YYYYMMDD — options only
  "strike":   number,          // options only
  "right":    string           // "C" or "P" — options only
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

**Request (mode 1 — by conId):**
```jsonc
{
  "conId": number   // resolved contract ID
}
```

**Request (mode 2 — by symbol):**
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

**Response 200:** All fields optional — depends on what TWS returns.
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
- `symbol` is NOT included in the response — the caller must track it.
- No maintenance window check.

---

### POST /api/orders/single

Place a single-contract order. **Guards: connected + not maintenance.**

**Request:**
```jsonc
{
  "conId":      number,   // REQUIRED — resolved contract ID
  "action":     string,   // REQUIRED — "BUY" or "SELL"
  "quantity":   number,   // REQUIRED — integer
  "orderType":  string,   // default "LMT"
  "tif":        string,   // default "GTC"
  "limitPrice": number    // optional — rounded by tick rules (see below)
}
```

**Tick rounding:** `limitPrice < $3.00` → $0.01 increments. `>= $3.00` → $0.05 increments.
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

**Response 200 (timeout — order may still be accepted):**
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
| 503 | `{ "error": "Maintenance window", "retryAfter": number }` | 00:15–01:45 ET. `retryAfter` = seconds until 01:45 |
| 400 | `{ "error": string, "orderId": number }` | TWS rejected the order |

---

### POST /api/orders/combo

Place a BAG (spread/combo) order. **Guards: connected + not maintenance.**

**Request:**
```jsonc
{
  "symbol":     string,   // REQUIRED — underlying, e.g. "SPY"
  "action":     string,   // REQUIRED — "BUY" or "SELL"
  "quantity":   number,   // REQUIRED — integer
  "legs": [               // REQUIRED — array of legs
    {
      "conId":    number,   // REQUIRED
      "action":   string,   // REQUIRED — "BUY" or "SELL"
      "ratio":    number,   // default 1
      "exchange": string    // default "SMART"
    }
  ],
  "orderType":  string,   // default "LMT"
  "tif":        string,   // default "GTC"
  "limitPrice": number    // optional — net debit/credit for the spread
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
  "commission":     number      // OPTIONAL — only if openOrder reported it
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
TWS requires the FULL contract + order for modification — not just the changed fields.

**Request (single):**
```jsonc
{
  "conId":      number,   // REQUIRED for TWS to identify the contract
  "action":     string,   // REQUIRED
  "orderType":  string,   // REQUIRED
  "quantity":   number,   // REQUIRED
  "tif":        string,   // REQUIRED
  "limitPrice": number    // the field being modified
}
```

**Request (combo — when `legs` is present):**
Same as single, plus `symbol` and `legs` array (same shape as combo placement).

**Responses:** Identical shapes to `POST /api/orders/single`.

**WARNING:** Sending only `{ limitPrice }` will result in TWS rejection — conId=0 default.

---

### DELETE /api/orders/{orderId}

Cancel an order. **Guards: connected.** Fire-and-forget — returns immediately.

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

Account balance snapshot. **Guards: connected.**

**Response 200:**
```jsonc
{
  "netLiquidation":    number,   // defaults to 0.0 if tag missing
  "availableFunds":    number,
  "maintenanceMargin": number,
  "unrealizedPnl":     number
}
```

**Error responses:**

| Status | Shape | When |
|---|---|---|
| 503 | `{ "error": "Not connected to IB Gateway" }` | Disconnected |
| 504 | `{ "error": "Account summary timed out" }` | 5s timeout |
| 500 | `{ "error": string }` | Other |

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
    "marketValue":    number,   // OPTIONAL — enriched from reqAccountUpdates subscription
    "unrealizedPnl":  number    // OPTIONAL — enriched from reqAccountUpdates subscription
  }
]
```

**NOTE:** `marketValue` and `unrealizedPnl` come from the `reqAccountUpdates()` portfolio
subscription, NOT from `reqPositions()` itself. The sidecar enriches positions by joining
on `conId`. These fields are absent during cold start (before `accountDownloadEnd` fires).

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
Fires on EVERY order status change: submission, partial fill, full fill, cancellation.

### error
```jsonc
{
  "type":    "error",
  "code":    number,      // TWS error code
  "message": string,
  "orderId": number       // OPTIONAL — only when orderId > 0
}
```
Fires ONLY for codes: **110** (tick size), **201** (rejected), **202** (cancelled), **460** (unknown order).
All other TWS errors are logged server-side but NOT broadcast to WebSocket clients.

---

## TWS Error Code Handling

### Informational (debug log only, silent)
| Code | Meaning |
|---|---|
| 2104 | Market data farm connection OK |
| 2106 | HMDS data farm connection OK |
| 2158 | Sec-def data farm connection OK |

### Connection (warn log, triggers reconnect/WS event)
| Code | Meaning | Action |
|---|---|---|
| 1100 | Connectivity lost | `connected=false`, WS `disconnected`, reconnect |
| 504 | Not connected | `connected=false`, WS `disconnected`, reconnect |
| 1101 | Restored (data lost) | `connected=true`, WS `reconnected` |
| 1102 | Restored (data maintained) | `connected=true`, WS `reconnected` |

### Order errors (error log, WS `error` event, fails pending request)
| Code | Meaning |
|---|---|
| 110 | Price does not conform to minimum tick |
| 201 | Order rejected |
| 202 | Order cancelled |
| 460 | Unknown order |

### All other error codes
- Logged at ERROR level
- `failRequest()` called (completes the REST future exceptionally → 400/500)
- **NOT** broadcast via WebSocket
- `advancedOrderRejectJson` (5th error param) is **completely ignored**

---

## Internal Architecture

### Request/Response Flow
```
REST handler → getNextReqId() → createRequest(reqId) → client.reqXxx()
                                                           ↓
                                            TWS async callback fires
                                                           ↓
                                         completeRequest(reqId, result)
                                            or failRequest(reqId, error)
                                                           ↓
                                     awaitRequest() returns (5s timeout)
```

### Timeout: 5 seconds (`REQUEST_TIMEOUT_SECONDS`)
- On timeout: `CompletableFuture` stays in `pendingRequests` map (potential memory leak)
- Late callbacks are silently consumed (future already timed out)

### Persistent data (survives across requests, lost on restart)
- `orderStatuses` — `ConcurrentHashMap<orderId, statusMap>` — written by `orderStatus` + `openOrder` callbacks
- `accountId`, `connected`, `serverVersion` — volatile fields

### Maintenance window
- 00:15–01:45 ET daily
- **Blocks:** POST orders/single, POST orders/combo, PUT orders/{id}
- **Does NOT block:** DELETE orders/{id}, GET orders/{id}, contracts/resolve, market-data, account/summary, positions
- Returns `{ "error": "Maintenance window", "retryAfter": seconds }` with 503

### Auto-reconnect
- Thread `"reconnect-scheduler"` spawns on disconnect
- 5s fixed delay between attempts (no backoff)
- Defers during maintenance window (sleeps 60s, rechecks)
- Stops when `connected=true` or `shuttingDown=true`
