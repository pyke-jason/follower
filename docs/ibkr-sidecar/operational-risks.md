# IBKR Operational Risks

> Verified against codebase on 2026-03-02. Each risk independently confirmed by reading source code.
> Cross-references gap IDs from `gaps-and-todos.md` where applicable.

---

## Summary

| # | Risk | Severity | Status | Gap ID |
|---|------|----------|--------|--------|
| 1 | No state reconciliation after reconnect | **CRITICAL** | Open | S16, S12 |
| 2 | EReader thread stacking on reconnect | **CRITICAL** | Open | — |
| 3 | Inactive treated as terminal REJECTED | **CRITICAL** | Open | T5, S10 |
| 4 | No +PACEAPI | **HIGH** | Open | S4 |
| 5 | resolveConId() has no timeout | **HIGH** | Open | T4 |
| 6 | Error 2100 kills account subscription + flag never resets | **HIGH** | Open | S19 |
| 7 | fillTimestamp is fabricated | **MEDIUM** | Open | — |
| 8 | Error 1300/507/509 not handled | **MEDIUM** | Open | S15 |
| 9 | modifyOrder penny rounding mismatch | **MEDIUM** | Open | — |
| 10 | Competing session = blind reconnect loop | **MEDIUM** | Open | S21 |
| 11 | error() param `reqId` is actually `errorTime` | **LOW** | Open | — |
| 12 | Error 326 (client ID conflict) not handled | **LOW** | Open | S20 |
| 13 | Penny Pilot list incomplete | **LOW** | Open | — |

---

## CRITICAL

### 1. No state reconciliation after reconnect

**Files:** `TwsBridge.java:189-207` (attemptReconnect), `TwsBridge.java:108-125` (connect), `TwsBridge.java:346-356` (nextValidId)

**Problem:**
After any reconnect (heartbeat timeout, error 1100/504, nightly maintenance reset), the sidecar only calls `eConnect()` and starts a new EReader thread. It never requests the current state of open orders or recent executions from TWS.

The `nextValidId()` callback — which fires once the connection is live — sets `connected=true`, starts the heartbeat watchdog, and starts the map reaper. It does not call `reqOpenOrders()`, `reqExecutions()`, `reqAllOpenOrders()`, or `reqCompletedOrders()`. Zero occurrences of any of these methods exist anywhere in the sidecar codebase.

The only post-connect action is in `managedAccounts()` (line 590), which re-subscribes to account-level data (`reqAccountUpdates`). This recovers portfolio/position snapshots but NOT individual order statuses.

**Impact:**
If an order fills, partially fills, or gets cancelled during a disconnect window, the TS client's in-memory `workingOrders` map is permanently stale. The order manager will keep polling a stale status forever (or until the order times out of the sidecar's `orderStatuses` map after 24h).

Worst case: an overnight short option assignment during the 00:15-01:45 ET reset window goes completely undetected. The system has a real position at the exchange that it doesn't know about.

**Mitigating factors:**
- `managedAccounts()` re-subscribes portfolio data, so position-level snapshots do recover
- The heartbeat watchdog limits disconnect duration to ~40s (outside maintenance)
- The TS client's `orphan_fills` table would catch fills reported via `execDetails` WS events after reconnect — but only if the sidecar receives and forwards them, which requires the execDetails callback to fire for past executions (it doesn't without `reqExecutions()`)

**Remediation:**
Add to `nextValidId()` after setting `connected=true`:
```java
client.reqOpenOrders();                           // current client's open orders
client.reqExecutions(nextReqId.getAndIncrement(),
    new ExecutionFilter());                       // all recent executions
```
Broadcast the results via WS so the TS client can reconcile.

---

### 2. EReader thread stacking on reconnect

**Files:** `TwsBridge.java:108-125` (connect)

**Problem:**
Every call to `connect()` creates a new `EReader` (line 113) as a **local variable** and spawns a new anonymous `Thread` named `"ereader-dispatch"` (line 115-124). Neither is stored as an instance field. Old threads are never stopped, interrupted, or joined before creating new ones.

```java
public void connect() {
    client.eConnect(host, port, clientId);
    EReader reader = new EReader(client, signal);   // local — no instance field
    reader.start();
    new Thread(() -> {                              // anonymous — no instance field
        while (client.isConnected()) {
            signal.waitForSignal();
            try { reader.processMsgs(); }
            catch (Exception e) { log.error(...); }
        }
    }, "ereader-dispatch").start();
}
```

The old dispatch thread's `while (client.isConnected())` loop SHOULD exit when `eDisconnect()` is called (which happens in `declareConnectionDead()`). But there's a race: if `connect()` re-establishes the socket before the old thread checks `isConnected()`, the old thread stays alive. Both threads then compete on the shared `EJavaSignal`, potentially corrupting message ordering.

The old `EReader`'s internal thread (started by `reader.start()`) is also never explicitly stopped.

**Impact:**
After N reconnects, up to 2N zombie threads accumulate. All dispatch threads are named `"ereader-dispatch"` (no index), making them indistinguishable in thread dumps. Over hours/days with flaky connectivity, this is a slow-burn memory/CPU leak that could cause bizarre message processing errors.

**Remediation:**
Store reader and dispatch thread as instance fields. In `connect()`, interrupt the old dispatch thread and call `reader.close()` (or equivalent) before creating new ones:
```java
private volatile Thread dispatchThread;
private volatile EReader reader;

public void connect() {
    if (dispatchThread != null) dispatchThread.interrupt();
    // ... eConnect, create new reader + thread, store in fields
}
```

---

### 3. Inactive treated as terminal REJECTED

**Files:** `client.ts:111-127` (mapIbkrStatus), `order-manager.ts:104-117`

**Problem:**
The status mapping function treats `Inactive` as equivalent to `REJECTED`:

```typescript
case 'Inactive':
case 'ApiCancelled':
  return 'REJECTED';
```

When the order manager receives `REJECTED`, it immediately:
1. Removes the order from the `workingOrders` map
2. Fires the `onCancel` callback
3. The system gives up on the order entirely

Per `docs/ibkr/order-lifecycle.md:34-39`, Inactive is NOT always terminal. It can recover to Submitted when:
- A short-sell locate completes
- An exchange reopens
- A TWS precautionary block is accepted by the user
- Margin becomes available

The WS listener does fire `forceCheckCallback` on Inactive (ws-listener.ts:133), but this triggers `orderManager.tick()` which polls `getOrderStatus()`, which returns `REJECTED` through `mapIbkrStatus()` — reinforcing the terminal interpretation.

**Impact:**
If an order goes Inactive temporarily and the order manager abandons it, but IBKR later reactivates and fills it, the system has an untracked position at the exchange. This is a phantom position — real money at risk with no system awareness.

**Mitigating factors:**
- Most Inactive reasons for this system's option limit orders would be genuine rejections (margin, regulatory)
- `placeOrder` uses GTC TIF, so "exchange closed" Inactive shouldn't typically occur
- The risk is highest for any short-selling or margin-constrained strategies

**Remediation:**
Map `Inactive` to a new non-terminal status (e.g., `HELD`) or to `PENDING`. Add a delayed re-check: if an order is Inactive for >60s, THEN treat it as rejected. Alternatively, let the sidecar distinguish recoverable vs terminal Inactive using `whyHeld` (S11) and send a specific WS event.

---

## HIGH

### 4. No +PACEAPI

**Files:** `TwsBridge.java:108-110` (connect)

**Problem:**
The sidecar calls `client.eConnect(host, port, clientId)` without first calling `client.setConnectOptions("+PACEAPI")`. Without this flag, the TWS API enforces a hard 50 messages/second rate limit. Three violations trigger an automatic socket disconnect with no recovery — TWS just drops the connection.

With `+PACEAPI` enabled, TWS throttles responses instead of disconnecting, giving the client time to back off.

**Impact:**
During volatile markets with rapid signal processing (multiple legs resolved, quotes requested, orders placed in quick succession), hitting 50 msg/s is plausible. Three bursts = disconnect. Combined with risk #1 (no state reconciliation after reconnect), this could cascade: rate limit -> disconnect -> reconnect without state sync -> stale order state.

Error 100 (rate limit) is NOT in `CONNECTION_CODES`, so the sidecar doesn't even know to reconnect. The disconnect comes later when TWS closes the socket, detected only via heartbeat timeout (40-70s delay).

**Remediation:**
One-line fix in `connect()` before `eConnect()`:
```java
client.setConnectOptions("+PACEAPI");
client.eConnect(host, port, clientId);
```

---

### 5. resolveConId() has no timeout

**Files:** `symbology.ts:59-71` (resolveConId), `client.ts:167-182` (placeOrder call site), `client.ts:136` (getQuote call site)

**Problem:**
`resolveConId()` calls `fetch()` against the sidecar's `/contracts/resolve` endpoint with no `AbortController`, no `signal`, and no timeout:

```typescript
const res = await fetch(`${sidecarUrl}/contracts/resolve`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ symbol, secType, expiry, strike, right, exchange: 'SMART', currency: 'USD' }),
});
```

In `placeOrder()`, `resolveConId()` is called OUTSIDE the `withRetry` wrapper:
```typescript
const resolvedLegs = await Promise.all(
  params.legs.map(async (leg) => {
    const conId = await resolveConId(occSymbol, SIDECAR_URL);  // no timeout
    return { leg, conId };
  }),
);
// ... later:
return withRetry(async (signal) => { ... }, { timeoutMs: 15_000 }, 'placeOrder');
```

If the sidecar hangs on contract resolution (IB Gateway unresponsive, complex option chain), the `Promise.all` hangs indefinitely. The `withRetry` timeout never gets a chance to fire.

In `getQuote()`, `resolveConId()` is inside `withRetry` but the retry signal is NOT passed to it — only to the subsequent `sidecar()` call. Aborting the signal does not abort a running `resolveConId` fetch.

**Mitigating factors:**
- In-memory `conIdCache` (symbology.ts:44) means only the first resolution per symbol can hang
- The sidecar has its own `REQUEST_TIMEOUT_SECONDS` (5s), so it would eventually respond with an error in most cases
- Node.js `fetch` has some default TCP timeout behavior, so it won't hang truly forever — but it could be minutes

**Remediation:**
Add `AbortSignal.timeout(10_000)` to the fetch call in `resolveConId()`:
```typescript
const res = await fetch(`${sidecarUrl}/contracts/resolve`, {
  method: 'POST',
  signal: AbortSignal.timeout(10_000),
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ... }),
});
```

---

### 6. Error 2100 kills account subscription + accountSubscriptionActive never resets

**Files:** `TwsBridge.java:72` (field init), `TwsBridge.java:585-598` (managedAccounts), `TwsBridge.java:157-170` (declareConnectionDead), `TwsBridge.java:366-378` (connectionClosed)

**Problem:**
Two interrelated bugs:

**Bug A — Error 2100 not handled:**
Error 2100 ("New account data requested from TWS. API client has been unsubscribed from account data") fires when another API client calls `reqAccountUpdates()` for the same account, preempting this client's subscription. Error 2100 is not in `INFORMATIONAL_CODES`, `CONNECTION_CODES`, or `ORDER_ERROR_CODES`. It falls to the generic error handler — logged at ERROR, no WS event broadcast, no recovery action.

After 2100 fires, the sidecar's `accountValues` and `portfolioPositions` maps retain their last values but never receive updates. The `accountSubscriptionActive` flag stays `true`.

**Bug B — accountSubscriptionActive never resets (latent, affects ALL reconnects):**
The flag is initialized to `false` (line 72) and set to `true` in `managedAccounts()` (line 585). It is NEVER reset to `false` — not in `connectionClosed()`, not in `declareConnectionDead()`, not in any error handler, not anywhere.

After any disconnect/reconnect cycle, `managedAccounts()` checks `!accountSubscriptionActive` before re-subscribing:
```java
if (connected && !accountSubscriptionActive) {
    client.reqAccountUpdates(true, this.accountId);
    accountSubscriptionActive = true;
}
```

Since the flag is stuck at `true`, re-subscription never happens after reconnect. Account data (Cushion, SMA, excess liquidity, net liquidation) goes stale permanently. Only a full sidecar process restart recovers.

**Impact:**
After ANY disconnect/reconnect — not just error 2100 — the account data subscription is silently dead. Risk checks and position displays use stale data. If margin utilization changes significantly, the system won't know.

**Remediation:**
1. Reset `accountSubscriptionActive = false` in both `connectionClosed()` and `declareConnectionDead()`
2. Handle error 2100 explicitly: reset flag, re-subscribe, broadcast a WS event

---

## MEDIUM

### 7. fillTimestamp is fabricated

**Files:** `client.ts:322-327` (getOrderStatus), `ws-listener.ts:143-151` (execDetails handler), `schemas.ts:124` (ExecDetailsEventSchema)

**Problem:**
When a filled order is detected via REST polling, the fill timestamp is set to the current wall clock time:

```typescript
if (status === 'FILLED') {
  result.filledPrice = order.avgFillPrice;
  result.filledQuantity = order.filledQuantity;
  result.commission = order.commission;
  result.fillTimestamp = new Date().toISOString();  // poll time, not exchange time
}
```

The actual exchange fill time IS available in the sidecar's `execDetails` WS event. `TwsBridge.java:612` captures `execution.time()` and broadcasts it. The WS listener receives it (validated by `ExecDetailsEventSchema` which includes a `time: z.string()` field). But the WS listener only uses `execDetails` events to trigger `forceCheckCallback` — it never extracts the `time` field.

The `OrderResponseSchema` (schemas.ts:51-58) doesn't include a time/fillTime field either, so even if the sidecar returned it on the REST endpoint, the schema wouldn't parse it.

The downstream chain: `fillTimestamp` -> `order-manager.ts:94` (`order.filledAt`) -> `fill-enrichment.ts:35` (`brokerFillTime`) -> trades DB. All records get TS client poll time instead of exchange time.

For comparison, the TradeStation client does this correctly: `fillTimestamp: order.ClosedDateTime` (using the broker-provided timestamp).

**Impact:**
Fill timestamps could be off by 1-30+ seconds depending on polling interval and WS latency. Affects P&L reporting, slippage calculations, and audit trails. Does not affect order execution logic.

**Remediation (two options):**
- **Option A (sidecar-side):** Enrich the `orderStatuses` map with execution time from `execDetails` callback. Add a `fillTime` field to the REST `/orders/:id` response. Add `fillTime` to `OrderResponseSchema`.
- **Option B (TS-side):** Have the WS listener capture the `time` field from `execDetails` events and make it available (e.g., via a shared map keyed by orderId) for `getOrderStatus()` to use instead of `new Date()`.

---

### 8. Errors 1300, 507, 509 not handled as connection events

**Files:** `TwsBridge.java:31` (CONNECTION_CODES), `TwsBridge.java:391-418` (error handler)

**Problem:**
`CONNECTION_CODES` contains only `{1100, 1101, 1102, 504}`. Three additional connection-related errors fall through to the generic handler:

| Code | Meaning | What should happen | What actually happens |
|------|---------|-------------------|----------------------|
| 1300 | Socket port reset | `eDisconnect()` + reconnect | Logged as error, no reconnect |
| 507 | Bad message length / socket EOF | `eDisconnect()` + reconnect | Logged as error, no reconnect |
| 509 | Socket exception | `eDisconnect()` + reconnect | Logged as error, no reconnect |

When any of these fires, the socket is effectively dead but the sidecar doesn't:
1. Set `connected = false`
2. Call `eDisconnect()` to release socket resources
3. Broadcast a `disconnected` WS event to the TS client
4. Trigger `scheduleReconnect()`

The heartbeat watchdog will eventually detect the dead connection (40-70s later), but during that window all new requests are sent to a dead socket and hang until their 5s timeout.

**Remediation:**
Add 1300, 507, 509 to `CONNECTION_CODES` and treat them like 1100/504:
```java
private static final Set<Integer> CONNECTION_CODES = Set.of(504, 507, 509, 1100, 1101, 1102, 1300);
```

---

### 9. modifyOrder penny rounding mismatch

**Files:** `client.ts:260-265` (modifyOrder), `client.ts:39-47` (roundToOptionTick), `OrderRoutes.java:198, 224-236` (sidecar rounding)

**Problem:**
`modifyOrder()` always rounds to $0.01 (penny increments) because it doesn't have access to the underlying symbol:

```typescript
// We don't know the underlying here, but modifyOrder only changes limit price
// on existing orders. Round conservatively (penny increment is always safe).
const rounded = Math.round(newLimitPrice * 100) / 100;
```

The comment "penny increment is always safe" is incorrect for non-Penny-Pilot options >= $3.00, which require $0.05 ticks. However, the sidecar's `OrderRoutes.java:198` re-rounds using `roundToOptionTick()`:
- Below $3: $0.01
- At/above $3: $0.05

This double-rounding creates a mismatch: the TS client sends $3.03, the sidecar rounds to $3.05, TWS receives $3.05. The order succeeds but the price is different from what the TS client intended.

Additional nuance: the sidecar's `roundToOptionTick` also lacks Penny Pilot awareness. For Penny Pilot symbols above $3, both the TS client AND sidecar round to $0.05 when $0.01 is the correct tick. During price chase, this means wider jumps than necessary — up to $0.04 overshoot per chase step.

**Impact:**
No TWS rejections (sidecar provides safety net), but suboptimal price chasing. The `ibkrClassify` function treats error 110 (tick size violation) as `permanent`, so if the sidecar rounding ever failed, `withRetry` would NOT retry — the chase step would be lost.

**Remediation:**
Pass the underlying symbol through to `modifyOrder()` so it can use `roundToOptionTick()`. Or: have the sidecar look up the stored order's underlying for correct rounding (it already has access via `OrderStore`).

---

### 10. Competing session = blind reconnect loop

**Files:** `TwsBridge.java:31` (CONNECTION_CODES), `TwsBridge.java:189-207` (attemptReconnect), `ws-listener.ts:189-201` (escalation)

**Problem:**
If someone logs into Client Portal with the same IBKR username while the sidecar is running, the API session is preempted. The sidecar won't immediately disconnect — it can reconnect after the current session. But after the next nightly reset (23:45 ET), auto-reconnect silently fails because the competing session holds the auth.

Error 507 — the usual indicator of a competing session — is NOT in `CONNECTION_CODES`. The sidecar's reconnect loop retries every 5s but cannot distinguish "competing session blocks auth" from "Gateway down." There is no specific error handling or alerting for this failure mode.

**Detection layers that DO exist:**
- Heartbeat watchdog detects dead connection within 40s
- WS listener escalation fires critical alert after 5min disconnect during market hours
- Healthchecks.io external monitoring pings every 60s, sends `/fail` when disconnected
- Pushover alerts: priority 2, acknowledge-to-clear, re-alerts every 60s for 10min

**Impact:**
The connection failure IS detected and alerted. The system is NOT silently dead. But the root cause (competing session) is never identified, and the reconnect loop retries blindly forever. Manual intervention is required to identify and resolve the competing session.

**Remediation:**
1. Add 507 to `CONNECTION_CODES`
2. Track consecutive reconnect failures. After N failures (e.g., 5), broadcast a specific WS event indicating persistent reconnect failure
3. Log the error code that caused each reconnect failure for root-cause diagnosis

---

## LOW

### 11. error() param `reqId` is actually `errorTime`

**Files:** `TwsBridge.java:391, 410`

**Problem:**
The TWS API 10.40 5-parameter `error()` callback signature is:
```
error(int id, long errorTime, int errorCode, String errorMsg, String advancedOrderRejectJson)
```

The sidecar names the 2nd parameter `reqId` instead of `errorTime`:
```java
public void error(int id, long reqId, int errorCode, String errorMsg, String advancedOrderRejectJson) {
```

The log at line 410 says `reqId={}` when it's actually printing an epoch timestamp:
```java
log.error("TWS error [id={}, reqId={}]: {} - {}", id, reqId, errorCode, errorMsg);
```

**Impact:**
No functional impact. Log analysis is confusing — a timestamp like `1709337600` appears labeled as a request ID.

**Remediation:**
Rename parameter to `errorTime` and log label to `errorTime={}`.

---

### 12. Error 326 (client ID conflict) not handled

**Files:** `TwsBridge.java:31-34` (error code sets), `TwsBridge.java:182-207` (reconnect)

**Problem:**
Error 326 ("Unable to connect as the client id is already in use") is not in any error code set. During reconnect, if IB Gateway still holds the old client ID from a dead socket, error 326 fires. It falls through to the generic handler — logged and forgotten.

The reconnect loop will retry every 5s. If IB Gateway eventually releases the old client ID (typical timeout: 10-30s), the next attempt succeeds. But there's no explicit handling: no increased delay, no attempt to use a different client ID, no specific logging.

**Impact:**
Reconnect takes a few extra seconds. Not a real problem in practice since the 5s retry delay is usually sufficient for the old session to time out.

**Remediation:**
Low priority. Optionally add 326 to a set that triggers a 15s delay instead of 5s on next retry attempt.

---

### 13. Penny Pilot list incomplete

**Files:** `client.ts:26-31`

**Problem:**
The `PENNY_PILOT` set contains 34 hardcoded symbols:
```typescript
const PENNY_PILOT = new Set([
  'AAPL', 'AMZN', 'BAC', 'C', 'CSCO', 'DIA', 'EEM', 'EWZ', 'F',
  'GE', 'GLD', 'GOOG', 'GOOGL', 'HYG', 'INTC', 'IWM', 'JPM',
  'META', 'MSFT', 'MU', 'NFLX', 'NVDA', 'PFE', 'QQQ', 'SLV',
  'SPY', 'T', 'TLT', 'TSLA', 'USO', 'VXX', 'XLE', 'XLF', 'XLK',
]);
```

The real CBOE Penny Pilot program includes 363+ option classes and is updated periodically. Notable missing symbols: AMD, SOFI, PLTR, COIN, UBER, ROKU, SQ, SNAP, HOOD, etc.

For missing Penny Pilot symbols priced >= $3:
- `placeOrder` rounds to $0.05 via `roundToOptionTick()` when $0.01 is valid — suboptimal but not rejected
- `modifyOrder` penny-rounds to $0.01 (correct for these symbols, but by accident)

The sidecar's `OrderRoutes.java:roundToOptionTick()` also lacks Penny Pilot awareness and always uses $0.05 for >= $3.

**Impact:**
Suboptimal pricing — slightly wider fills than necessary on Penny Pilot symbols not in the list. No order rejections since $0.05 is always a valid tick (just wider than needed).

**Remediation:**
Low priority. Either expand the list to match current CBOE Penny Pilot, or query IBKR's contract details API for `minTick` on each symbol (most robust).
