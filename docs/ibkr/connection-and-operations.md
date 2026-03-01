# IBKR Connection & Operations

> Daily lifecycle, maintenance windows, reconnection, and operational edge cases.

---

## Daily Schedule (Eastern Time)

| Time (ET) | Event |
|---|---|
| 00:15 - 01:45 | **Maintenance window** — IB servers reset. Orders blocked by sidecar. |
| ~04:00 | Pre-market opens (equities) |
| 09:30 | Regular session opens |
| 16:00 | Regular session closes |
| 16:15 | MOC/LOC order deadline |
| 20:00 | Extended hours close |
| ~23:45 | TWS/Gateway auto-restart (configurable) |

### Maintenance Window Details

- **Blocks** in sidecar: POST orders/single, POST orders/combo, PUT orders/{id}
- **Does NOT block**: DELETE orders/{id}, GET orders/{id}, contracts/resolve, market-data, account/summary, positions
- Returns `{ "error": "Maintenance window", "retryAfter": seconds }` with 503

---

## Weekly Cycle

| Day | Event |
|---|---|
| Sunday afternoon | Authenticate (including 2FA). Markets open ~18:00 ET for futures. |
| Monday - Friday | Auto-restart daily at configured time. No re-authentication needed. |
| Friday 23:00 - Saturday 03:00 | Weekend maintenance window |
| Saturday | Auto-restart → results in **logout** |
| Sunday 01:00 | IB invalidates session credentials. Manual re-auth required. |

**The weekly pattern:** Authenticate Sunday → auto-restarts all week → forced logout Saturday → authenticate Sunday → repeat.

---

## Connection State Machine

```
DISCONNECTED → CONNECTING → CONNECTED (awaiting nextValidId) → READY
     ↑              |                                            |
     |              v                                            |
     +--------  error 502/504  ←---------------------------------+
     |                                    |
     +------  error 1100/507  ←----------+
```

### After Reconnect

1. Wait for `nextValidId()` callback — **do not send any requests before this**
2. Call `reqOpenOrders()` to reconcile open order state
3. Call `reqExecutions()` to get fills missed during disconnect
4. Re-subscribe to market data (after 1101 only)
5. Re-subscribe to account updates if using `reqAccountUpdates()`

---

## Auto-Reconnect (Current Sidecar Implementation)

- Thread `"reconnect-scheduler"` spawns on disconnect
- 5s fixed delay between attempts (no backoff)
- Defers during maintenance window (sleeps 60s, rechecks)
- Stops when `connected=true` or `shuttingDown=true`

### Known Issues

1. **`isConnected()` lies** — returns `true` after socket death until `eDisconnect()` called
2. **EReader thread can zombie** — `waitForSignal()` blocks forever if socket breaks
3. **No `+PACEAPI`** — not called before `eConnect()`, so rate limit violations cause disconnect instead of throttling
4. **No heartbeat watchdog** — zombie connections (half-open sockets) go undetected

---

## Connection Drops

**Expected daily:** 1-2 disconnects beyond the nightly reset.

### Common Causes

1. **Nightly server reset** (guaranteed daily)
2. **Competing session** — logging into Client Portal web UI with same username prevents auto-reconnect after next disconnect
3. **Network interruptions** — brief disconnects, TWS auto-reconnects within seconds
4. **Rate limit exceeded** — >50 msg/sec without PACEAPI → TWS **closes the connection**
5. **TWS/Gateway crash** — memory issues, "initializing managers" hang

### What Happens to Orders on Disconnect

| Order State | Survives Disconnect? | Survives TWS Restart? |
|---|---|---|
| At exchange (Submitted) | Yes | Yes |
| Simulated (PreSubmitted) | Yes | **No** |
| PendingSubmit | Unknown | Unknown |
| Untransmitted (Transmit=false) | No | No |

---

## Client ID Management

- **Error 326**: Client ID already in use. TWS rejects the new connection.
- **Max 32 concurrent API clients** per TWS/Gateway session
- **Client ID 0**: Special — merges with manual TWS trading activity
- **Zombie client ID**: After socket break, ID may not release immediately. Wait a few seconds or increment.

---

## Rate Limits

| Limit | Value | Consequence |
|---|---|---|
| Messages per second | 50 | Error 100. 3 strikes = disconnect |
| Active orders per contract per side | 20 | Rejection |
| Market data subscriptions | 100 default | Error 101 |
| Historical data: identical request | 15s cooldown | Error 162 |

**Fix:** Call `SetConnectOptions("+PACEAPI")` before `eConnect()` to auto-throttle.

---

## Farm Connection Messages

These arrive via `error()` with `id = -1`. They are **not errors**.

| Code | Message | Meaning |
|---|---|---|
| 2103 | Market data farm disconnected | Lost connection to market data |
| 2104 | Market data farm OK | Connected — wait for this before requesting data |
| 2105 | Historical data farm disconnected | Historical queries will fail |
| 2106 | Historical data farm connected | Historical data available |
| 2107 | Historical data farm inactive (on demand) | Normal dormancy |
| 2108 | Market data farm inactive (on demand) | Normal dormancy |
| 2110 | TWS-server connectivity broken | Usually nightly reset signal |
| 2158 | Sec-def data farm OK | Security definitions available |

On initial connection, expect a burst of 2104, 2106, 2158. Filter by `id == -1` and code range 2100-2199.

---

## Server Version 215 (TWS 10.40+) Specifics

- `error()` has 5 params: `(int id, long reqId, int errorCode, String msg, String json)`
- `CommissionReport` → `CommissionAndFeesReport`, `commission()` → `commissionAndFees()`
- `cancelOrder(int)` → `cancelOrder(int, OrderCancel)`
- `Decimal` has no `.doubleValue()` — use `.value().doubleValue()` or `.longValue()`
- `orderStatus` `permId` is `long` not `int`
- Protocol Buffer support required → `implementation("com.google.protobuf:protobuf-java:4.29.3")`
- Extend `DefaultEWrapper`, not `implements EWrapper`

---

## Sidecar Implementation Gaps (Connection)

### Must Fix Before Live Trading

1. **Call `SetConnectOptions("+PACEAPI")`** before `eConnect()` — prevents disconnect on message bursts
2. **Handle error 507** as disconnect trigger — currently not handled
3. **After reconnect**: call `reqOpenOrders()` and `reqExecutions()` to reconcile state — not currently done

### Should Fix

4. **Heartbeat watchdog** — subscribe to a high-volume instrument, treat absence of ticks for N seconds as zombie connection
5. **Use `AtomicBoolean` for EReader thread lifecycle** — documented `while(isConnected())` pattern is flawed
6. **Plan for Sunday re-authentication** — the one weekly event requiring human intervention (2FA)
