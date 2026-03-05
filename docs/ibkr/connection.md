# IBKR Connection & Operations

> Verified against [TWS API Connection](https://interactivebrokers.github.io/tws-api/connection.html), [IBKR System Status](https://www.interactivebrokers.com/en/software/systemStatus.php), and [IBC User Guide](https://github.com/IbcAlpha/IBC/blob/master/userguide.md).

---

## Daily Schedule (Eastern Time)

| Time (ET) | Event |
|---|---|
| 00:15 - 01:45 | **Maintenance window** -- IB servers reset. Native orders continue, execution reports delayed, simulated orders delayed. |
| ~04:00 | Pre-market opens (equities) |
| 09:30 | Regular session opens |
| 15:00 | Overnight margin projections computed (LookAheadNextChange) |
| 16:00 | Regular session closes |
| 16:15 | MOC/LOC order deadline |
| 20:00 | Extended hours close |
| ~23:45 | TWS/Gateway auto-restart (default 11:45 PM local, configurable) |

### Maintenance Window Details

During 00:15-01:45 ET:
- Existing native orders at exchanges continue operating
- Execution reports and simulated orders may be delayed
- Login and order management may experience brief unavailability
- IB does NOT explicitly block API order placement -- but operations may fail

---

## Weekly Cycle

| Day | Event |
|---|---|
| Sunday afternoon | Authenticate (including 2FA). Markets open ~18:00 ET for futures |
| Monday - Friday | Auto-restart daily at configured time. No re-authentication needed |
| Friday 23:00 - Saturday 03:00 | Weekend maintenance window. All services unavailable in all regions |
| Sunday 01:00 | IB invalidates session credentials. Manual re-auth required |

**The weekly pattern:** Authenticate Sunday -> auto-restarts all week -> weekend shutdown Friday 23:00 -> authenticate Sunday -> repeat.

### Auto-Restart

- Default time: 11:45 PM in system timezone
- Configurable via: Configure > Lock and Exit > Auto restart (TWS/Gateway GUI) or `AutoRestartTime` in IBC config.ini
- Does NOT require re-authentication (only the first login after Sunday 01:00 ET does)
- IB Gateway does NOT connect to market data farms on startup (unlike TWS) -- connections happen on first request

---

## Connection State Machine

```
DISCONNECTED -> CONNECTING -> CONNECTED (awaiting nextValidId) -> READY
     ^              |                                              |
     |              v                                              |
     +--------  error 502/504  <-----------------------------------+
     |                                    |
     +------  error 1100/507  <----------+
```

### After eConnect()

1. Wait for `nextValidId()` callback -- **do not send any requests before this**
2. `nextValidId()` is the canonical signal that connection is complete

### After Reconnect

1. Wait for `nextValidId()` callback
2. Call `reqOpenOrders()` to reconcile open order state
3. Call `reqExecutions()` to get fills missed during disconnect (today only)
4. Re-subscribe to market data (after 1101 only; not needed after 1102)
5. Re-subscribe to account updates if using `reqAccountUpdates()`

---

## Client ID Management

- **Max 32 concurrent API clients** per TWS/Gateway session
- **Client ID 0**: Special -- merges with manual TWS trading activity. `reqOpenOrders()` from client 0 "binds" manual orders (assigns API order IDs). **Avoid in automated systems.**
- **Error 326**: Client ID already in use. TWS rejects the connection. Wait a few seconds or use different ID.
- **Zombie client ID**: After socket break, ID may not release immediately. Wait or increment.

---

## Competing Sessions

**Critical operational risk**: If you log into Client Portal web UI with the same username while TWS/Gateway is running, the API session will **not be able to auto-reconnect after the next server reset** (e.g., nightly maintenance). This is a silent failure mode.

Mitigation: Use IBC setting `ExistingSessionDetectedAction=primaryoverride`.

---

## Rate Limits

| Limit | Value | Consequence |
|---|---|---|
| Messages per second | 50 default (= MaxMarketDataLines / 2) | Error 100. 3 violations without `+PACEAPI` = disconnect |
| Active orders per contract per side | 20 | Rejection |
| Market data subscriptions | 100 default (shared between TWS + API) | Error 101 |
| Historical data: identical request | 15s cooldown | Error 162 |
| Historical data: same contract | 6 in 2s | Error 162 |
| Historical data: total | 60 in 10 min | Error 162. BID_ASK counts double |
| Concurrent historical requests | 50 | Error 162 |

**Fix:** Call `SetConnectOptions("+PACEAPI")` before `eConnect()` to auto-throttle instead of disconnect. Available since TWS 974+. May be auto-enabled in newer versions.

---

## Farm Connection Messages

These arrive via `error()` with `id = -1`. They are **not errors**.

| Code | Message | Meaning |
|---|---|---|
| 2100 | New account data requested, client unsubscribed | Another client took over account subscription |
| 2101 | Unable to subscribe to account | Client conflict |
| 2103 | Market data farm disconnected | Lost connection to market data |
| 2104 | Market data farm OK | Connected -- wait for this before requesting data |
| 2105 | Historical data farm disconnected | Historical queries will fail |
| 2106 | Historical data farm connected | Historical data available |
| 2107 | Historical data farm inactive (on demand) | Normal dormancy |
| 2108 | Market data farm inactive (on demand) | Normal dormancy |
| 2110 | TWS-server connectivity broken | Usually nightly reset signal. Auto-restore in progress |
| 2158 | Sec-def data farm OK | Security definitions available |

On initial connection, expect a burst of 2104, 2106, 2158. Filter by `id == -1` and code range 2100-2199.

---

## isConnected() Behavior

**Critical gotcha:** `isConnected()` does NOT automatically return `false` when the socket dies. `connectionClosed()` is NOT automatically called either. Both require the client to explicitly call `eDisconnect()` to update state. The only automatic signal is an exception in the EReader thread (error 507 in Java).

---

## EReader Thread Pattern

The official pattern:

```java
EReader reader = new EReader(clientSocket, readerSignal);
reader.start();
while (clientSocket.isConnected()) {
    readerSignal.waitForSignal();
    reader.processMsgs();  // throws IOException
}
```

**Issue:** `waitForSignal()` blocks until either a message arrives or an exception from socket death. The `while(isConnected())` guard is flawed because `isConnected()` can lie (see above). Use `AtomicBoolean` lifecycle flag for robust thread management.

---

## Connection Drops

**Expected daily:** 1-2 disconnects beyond the nightly reset.

### Common Causes

1. **Nightly server reset** (guaranteed daily)
2. **Competing session** -- Client Portal login prevents auto-reconnect after next disconnect
3. **Network interruptions** -- brief disconnects, TWS auto-reconnects within seconds
4. **Rate limit exceeded** -- >50 msg/sec without PACEAPI -> TWS closes the connection
5. **TWS/Gateway crash** -- memory issues, "initializing managers" hang

### What Happens to Orders on Disconnect

| Order State | Survives Disconnect? | Survives TWS Restart? |
|---|---|---|
| At exchange (Submitted) | Yes | Yes |
| Simulated (PreSubmitted) | Yes | **Depends** (10.28+ "Maintain and resubmit" setting) |
| PendingSubmit | Unknown | Unknown |
| Untransmitted (Transmit=false) | No | No |

---

## Market Data Types

| Type | ID | Behavior |
|---|---|---|
| Live | 1 | Real-time streaming. Default when subscribed |
| Frozen | 2 | Last recorded quote at market close. Returned after close |
| Delayed | 3 | 15-20 minute delayed data. Free. Auto-fallback without subscription |
| Delayed-Frozen | 4 | Delayed data frozen at close. For unsubscribed users after hours |

### Outside Market Hours

- `reqMktData` returns frozen/delayed-frozen data (last close prices)
- Bid/Ask may return -1 (no quote available)
- Options with no after-hours activity: bid/ask = -1, last = previous close

---

## Trading Halts (Tick Type 49)

Via `tickGeneric()`:

| Value | Meaning |
|---|---|
| -1 | Halt status unavailable (common with frozen data) |
| 0 | Not halted (only returned if contract is in a TWS watchlist) |
| 1 | General halt (regulatory + volatility) |
| 2 | Volatility halt (LULD) |

Impact: Error **154** for orders on halted securities. Existing order behavior during halts is exchange-dependent.

---

## Sources

- [TWS API: Connectivity](https://interactivebrokers.github.io/tws-api/connection.html)
- [TWS API: Automated Considerations](https://interactivebrokers.github.io/tws-api/automated_considerations.html)
- [TWS API: Market Data Types](https://interactivebrokers.github.io/tws-api/market_data_type.html)
- [TWS API: Tick Types](https://interactivebrokers.github.io/tws-api/tick_types.html)
- [IBKR System Status](https://www.interactivebrokers.com/en/software/systemStatus.php)
- [IBKR Auto Restart Considerations](https://www.ibkrguides.com/traderworkstation/auto-restart-considerations.htm)
- [IBC User Guide](https://github.com/IbcAlpha/IBC/blob/master/userguide.md)
