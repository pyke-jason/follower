# Sidecar Hardening Plan

7 fixes to eliminate money-losing failure modes in the IBKR sidecar. Ordered by dependency — each phase can be deployed independently.

## Phase 1: Structural Guards (no behavior change, just consolidation)

### 1A. Extract `Guards.java` — Javalin `before()` filter

**Problem**: 5 endpoints missing maintenance window protection. Guards are inline, inconsistent, and forgettable.

**Fix**: Single `before("/api/*")` filter. New routes are guarded automatically — opt-out instead of opt-in.

**New file**: `Guards.java`

```java
package com.tradefollower.sidecar;

import io.javalin.http.Context;
import io.javalin.http.HandlerType;

import java.time.Duration;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Map;
import java.util.Set;

public class Guards {
    private static final ZoneId ET = ZoneId.of("America/New_York");

    /** Paths that serve local-only state (no TWS call). */
    private static final Set<String> LOCAL_READ_PATHS = Set.of("/api/status");

    /** GET on these prefixes reads from in-memory maps only. */
    private static final Set<String> LOCAL_READ_GET_PREFIXES = Set.of("/api/orders/");

    private Guards() {}

    /** Javalin before-filter. Blocks requests when sidecar is not ready. */
    public static void requireReady(Context ctx, TwsBridge bridge) {
        if (isLocalRead(ctx)) return;

        if (!bridge.isConnected()) {
            ctx.status(503).json(Map.of("error", "Not connected to IB Gateway"));
            ctx.skipRemainingHandlers();
            return;
        }

        if (bridge.isInMaintenanceWindow()) {
            ctx.status(503).json(Map.of(
                "error", "Maintenance window",
                "retryAfter", maintenanceRetrySeconds()
            ));
            ctx.skipRemainingHandlers();
        }
    }

    private static boolean isLocalRead(Context ctx) {
        if (LOCAL_READ_PATHS.contains(ctx.path())) return true;
        if (ctx.method() == HandlerType.GET) {
            for (String prefix : LOCAL_READ_GET_PREFIXES) {
                if (ctx.path().startsWith(prefix)) return true;
            }
        }
        return false;
    }

    private static int maintenanceRetrySeconds() {
        ZonedDateTime now = ZonedDateTime.now(ET);
        ZonedDateTime endMaint = now.withHour(1).withMinute(45).withSecond(0);
        if (now.isAfter(endMaint)) endMaint = endMaint.plusDays(1);
        return (int) Duration.between(now, endMaint).getSeconds();
    }
}
```

**Changes to existing files**:

| File | Line(s) | Change |
|---|---|---|
| `App.java` | after L47 | Add `app.before("/api/*", ctx -> Guards.requireReady(ctx, bridge));` |
| `OrderRoutes.java` | L42-52 | Delete `guardNotReady()` method |
| `OrderRoutes.java` | L215-223 | Delete `maintenanceRetrySeconds()` method |
| `OrderRoutes.java` | L68, L99, L161 | Delete `if (guardNotReady(ctx)) return;` |
| `OrderRoutes.java` | L186-189 | Delete inline `isConnected()` check in `cancel()` |
| `ContractRoutes.java` | L33-36 | Delete inline `isConnected()` check |
| `MarketDataRoutes.java` | L33-36 | Delete inline `isConnected()` check |
| `AccountRoutes.java` | L39-42 | Delete inline `isConnected()` check in `summary()` |
| `AccountRoutes.java` | L89-92 | Delete inline `isConnected()` check in `positions()` |

**Result**: 9 scattered guard blocks replaced by 1 structural filter. 5 endpoints gain maintenance protection.

---

## Phase 2: Order Safety (prevents doubled/wrong fills)

### 2A. Atomic order modify via `ConcurrentHashMap.compute()`

**Problem**: `modify()` mutates a shared mutable `Order` object. Two concurrent modifies on the same orderId race on the `lmtPrice` field.

**Fix**: New `modifyOrderPrice()` method on TwsBridge uses `orderStore.compute()` for per-key exclusion. Mutation + `placeOrder()` happen inside the critical section.

**Add to `TwsBridge.java`**:

```java
/**
 * Atomically mutate an order's limit price and re-submit to TWS.
 * ConcurrentHashMap.compute() provides per-key exclusion.
 * Returns the StoredOrder, or null if orderId not found.
 */
public StoredOrder modifyOrderPrice(int orderId, double newLimitPrice) {
    StoredOrder[] result = new StoredOrder[1];
    orderStore.compute(orderId, (key, existing) -> {
        if (existing == null) return null;
        existing.order().lmtPrice(newLimitPrice);
        client.placeOrder(orderId, existing.contract(), existing.order());
        result[0] = existing;
        return existing;
    });
    return result[0];
}
```

**Replace `OrderRoutes.modify()`**:

```java
@SuppressWarnings("unchecked")
private void modify(Context ctx) {
    int orderId = Integer.parseInt(ctx.pathParam("orderId"));
    Map<String, Object> body = ctx.bodyAsClass(Map.class);

    if (!body.containsKey("limitPrice")) {
        ctx.status(400).json(Map.of("error", "limitPrice is required", "orderId", orderId));
        return;
    }

    double newPrice = roundToOptionTick(((Number) body.get("limitPrice")).doubleValue());
    CompletableFuture<Map<String, Object>> future = bridge.createRequest(orderId);

    TwsBridge.StoredOrder stored = bridge.modifyOrderPrice(orderId, newPrice);
    if (stored == null) {
        bridge.failRequest(orderId, new RuntimeException("Order not in store"));
        ctx.status(404).json(Map.of("error", "Order not in store", "orderId", orderId));
        return;
    }

    log.info("AUDIT modifyOrder orderId={} conId={} newLimitPrice={}",
            orderId, stored.contract().conid(), newPrice);
    awaitAndRespond(ctx, future, orderId);
}
```

### 2B. Idempotency protection via `clientOrderRef`

**Problem**: If the TS client retries after timeout, the sidecar places a second identical order. Doubled position.

**Fix**: Client sends a `clientOrderRef` field. Sidecar deduplicates within a 60s window. Ref is also set on `Order.orderRef()` for end-to-end traceability through IB statements.

**Add to `OrderRoutes.java`**:

```java
private static final long IDEMPOTENCY_TTL_MS = 60_000;

private record IdempotencyEntry(int orderId, long createdAt) {}
private final ConcurrentHashMap<String, IdempotencyEntry> recentOrders = new ConcurrentHashMap<>();

private void evictStaleRefs() {
    long cutoff = System.currentTimeMillis() - IDEMPOTENCY_TTL_MS;
    recentOrders.entrySet().removeIf(e -> e.getValue().createdAt() < cutoff);
}
```

**Dedup check at top of `placeSingle()` and `placeCombo()` (after guard removal)**:

```java
String clientOrderRef = (String) body.get("clientOrderRef");
if (clientOrderRef != null) {
    evictStaleRefs();
    IdempotencyEntry existing = recentOrders.get(clientOrderRef);
    if (existing != null) {
        log.info("AUDIT idempotent-hit clientOrderRef={} existingOrderId={}", clientOrderRef, existing.orderId());
        Map<String, Object> status = bridge.getOrderStatus(existing.orderId());
        ctx.json(status != null ? status : Map.of("orderId", existing.orderId(), "status", "PendingSubmit"));
        return;
    }
}
```

**After `getNextReqId()`, before `placeOrder()`**:

```java
if (clientOrderRef != null) {
    recentOrders.put(clientOrderRef, new IdempotencyEntry(orderId, System.currentTimeMillis()));
    order.orderRef(clientOrderRef);
}
```

**TS client changes** (future phase, when `maxRetries` is enabled): pass `clientOrderRef` in request body, derived deterministically from `messageId + tradeAction` so the same logical trade always deduplicates.

---

## Phase 3: Audit Logging (visibility into what was sent to TWS)

**Problem**: If the sidecar crashes between sending an order and receiving a callback, there's zero record of what was submitted.

**Fix**: Structured `AUDIT` log lines before every TWS call. Uses SLF4J `{}` placeholders. Replaces existing ad-hoc log lines at those sites.

| Site | Log line |
|---|---|
| `placeSingle()` | `AUDIT placeOrder orderId={} conId={} action={} qty={} orderType={} limitPrice={} tif={} clientOrderRef={}` |
| `placeCombo()` | `AUDIT placeOrder orderId={} symbol={} action={} qty={} orderType={} limitPrice={} tif={} legs={} clientOrderRef={}` |
| `modify()` | `AUDIT modifyOrder orderId={} conId={} newLimitPrice={}` |
| `cancel()` | `AUDIT cancelOrder orderId={}` |
| idempotent hit | `AUDIT idempotent-hit clientOrderRef={} existingOrderId={}` |

**Key rule**: Log BEFORE the TWS call, not after. If the JVM crashes mid-call, we still have the intent recorded.

---

## Phase 4: Memory Safety (prevents OOM over days)

### 4A. `pendingRequests` cleanup in `finally` block

**Problem**: Timed-out futures stay in `pendingRequests` forever.

**Change `TwsBridge.awaitRequest()`**:

```java
public <T> T awaitRequest(CompletableFuture<T> future) throws Exception {
    try {
        return future.get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS);
    } finally {
        pendingRequests.values().remove(future);
    }
}
```

On success, `completeRequest` already removed it (no-op). On timeout, this catches the straggler. `values().remove()` is O(n) but the map has <10 concurrent entries.

### 4B. Scheduled reaper for persistent maps

**Problem**: `executionStore`, `orderStatuses`, `orderStore` grow unbounded. OOM after days of trading.

**Add timestamp tracking and a reaper to `TwsBridge.java`**:

```java
private static final long EVICTION_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// Companion timestamp maps
private final ConcurrentHashMap<String, Long>  executionTimestamps = new ConcurrentHashMap<>();
private final ConcurrentHashMap<Integer, Long> orderTimestamps     = new ConcurrentHashMap<>();

private final ScheduledExecutorService reaper = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread t = new Thread(r, "map-reaper");
    t.setDaemon(true);
    return t;
});
```

**Stamp on insert** — update `execDetails()`, `orderStatus()`, `storeOrder()`:

```java
// In execDetails():
executionTimestamps.put(execution.execId(), System.currentTimeMillis());

// In orderStatus():
orderTimestamps.put(orderId, System.currentTimeMillis());

// In storeOrder():
orderTimestamps.put(orderId, System.currentTimeMillis());
```

**Reaper task** (start in constructor or `connect()`):

```java
reaper.scheduleAtFixedRate(this::evictStaleEntries, 30, 30, TimeUnit.MINUTES);

private void evictStaleEntries() {
    long cutoff = System.currentTimeMillis() - EVICTION_AGE_MS;
    int execCount = 0, orderCount = 0;

    var execIter = executionTimestamps.entrySet().iterator();
    while (execIter.hasNext()) {
        var e = execIter.next();
        if (e.getValue() < cutoff) {
            executionStore.remove(e.getKey());
            execIter.remove();
            execCount++;
        }
    }

    var orderIter = orderTimestamps.entrySet().iterator();
    while (orderIter.hasNext()) {
        var e = orderIter.next();
        if (e.getValue() < cutoff) {
            orderStatuses.remove(e.getKey());
            orderStore.remove(e.getKey());
            orderIter.remove();
            orderCount++;
        }
    }

    // Safety net: sweep orphaned accumulators (entries with no matching pendingRequest)
    tickAccumulators.keySet().removeIf(k -> !pendingRequests.containsKey(k));
    accountAccumulators.keySet().removeIf(k -> !pendingRequests.containsKey(k));
    positionAccumulators.keySet().removeIf(k -> !pendingRequests.containsKey(k));

    if (execCount > 0 || orderCount > 0) {
        log.info("Evicted {} execution entries, {} order entries (>24h old)", execCount, orderCount);
    }
}
```

**Shutdown**: Add `reaper.shutdownNow()` to `disconnect()`.

---

## Phase 5: Heartbeat Watchdog (detects silent socket death)

**Problem**: If TCP socket dies without FIN/RST, the EReader thread zombies, `connected` stays true, all requests silently timeout. Brain-dead state.

**Fix**: `reqCurrentTime()` heartbeat every 30s. If no `currentTime()` callback response within 40s (one interval + timeout margin), declare connection dead and force reconnect.

### 5A. New fields on `TwsBridge`

```java
private static final long HEARTBEAT_INTERVAL_MS = 30_000;
private static final long HEARTBEAT_DEAD_MS     = 40_000; // interval + margin

private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread t = new Thread(r, "heartbeat-watchdog");
    t.setDaemon(true);
    return t;
});
private volatile long lastHeartbeatResponse = System.currentTimeMillis();
private volatile ScheduledFuture<?> heartbeatTask;
private volatile ScheduledFuture<?> reconnectTask;
```

### 5B. `currentTime()` callback

```java
@Override
public void currentTime(long time) {
    lastHeartbeatResponse = System.currentTimeMillis();
    log.debug("Heartbeat response: server time={}", time);
}
```

### 5C. Start heartbeat from `nextValidId()`

```java
@Override
public void nextValidId(int orderId) {
    nextReqId.set(orderId);
    connected = true;
    serverVersion = client.serverVersion();
    lastHeartbeatResponse = System.currentTimeMillis();
    log.info("Connected to IB Gateway (serverVersion={}, nextValidId={})", serverVersion, orderId);
    wsHandler.broadcastConnected();
    startHeartbeat();
}
```

### 5D. Heartbeat check logic

```java
private void startHeartbeat() {
    if (heartbeatTask != null) heartbeatTask.cancel(false);
    heartbeatTask = watchdog.scheduleAtFixedRate(this::heartbeatCheck,
            HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS);
    log.info("Heartbeat watchdog started (interval={}s)", HEARTBEAT_INTERVAL_MS / 1000);
}

private void heartbeatCheck() {
    if (shuttingDown || !connected) return;

    if (isInMaintenanceWindow()) {
        lastHeartbeatResponse = System.currentTimeMillis();
        return;
    }

    long elapsed = System.currentTimeMillis() - lastHeartbeatResponse;
    if (elapsed > HEARTBEAT_DEAD_MS) {
        log.warn("Heartbeat timeout ({}ms since last response) — declaring connection dead", elapsed);
        declareConnectionDead();
        return;
    }

    try {
        client.reqCurrentTime();
    } catch (Exception e) {
        log.warn("Failed to send heartbeat: {}", e.getMessage());
        declareConnectionDead();
    }
}

private void declareConnectionDead() {
    if (!connected) return;
    connected = false;
    log.warn("Connection declared dead by heartbeat watchdog");
    wsHandler.broadcastDisconnected();

    for (var entry : pendingRequests.entrySet()) {
        entry.getValue().completeExceptionally(new RuntimeException("Heartbeat timeout"));
    }
    pendingRequests.clear();

    try { client.eDisconnect(); } catch (Exception e) { /* unblock EReader */ }

    scheduleReconnect();
}
```

### 5E. Replace raw reconnect thread with scheduled task

Replace the current `scheduleReconnect()` (raw `new Thread()` with sleep loop):

```java
private void scheduleReconnect() {
    if (shuttingDown) return;
    if (reconnectTask != null && !reconnectTask.isDone()) return;

    reconnectTask = watchdog.schedule(this::attemptReconnect, RECONNECT_DELAY_MS, TimeUnit.MILLISECONDS);
}

private void attemptReconnect() {
    if (shuttingDown || connected) return;

    if (isInMaintenanceWindow()) {
        log.info("In maintenance window, deferring reconnect");
        reconnectTask = watchdog.schedule(this::attemptReconnect, 60_000, TimeUnit.MILLISECONDS);
        return;
    }

    log.info("Attempting reconnect to IB Gateway...");
    try {
        connect();
    } catch (Exception e) {
        log.warn("Reconnect failed: {}", e.getMessage());
        if (!shuttingDown && !connected) {
            reconnectTask = watchdog.schedule(this::attemptReconnect, RECONNECT_DELAY_MS, TimeUnit.MILLISECONDS);
        }
    }
}
```

### 5F. Updated `disconnect()`

```java
public void disconnect() {
    shuttingDown = true;
    if (heartbeatTask != null) heartbeatTask.cancel(false);
    if (reconnectTask != null) reconnectTask.cancel(false);
    watchdog.shutdownNow();
    reaper.shutdownNow(); // from Phase 4
    if (client.isConnected()) client.eDisconnect();
}
```

### 5G. Expose heartbeat in `/api/status`

```java
// App.java — add to status response
"lastHeartbeat", bridge.getLastHeartbeatResponse()

// TwsBridge.java — add accessor
public long getLastHeartbeatResponse() { return lastHeartbeatResponse; }
```

---

## Implementation Order

```
Phase 1 (Guards)         ← no dependencies, do first for safety net
  ↓
Phase 2 (Order Safety)   ← depends on Phase 1 (guards removed from OrderRoutes)
  ↓
Phase 3 (Audit Logging)  ← depends on Phase 2 (modify() rewritten)
  ↓
Phase 4 (Memory Safety)  ← independent, but touch TwsBridge so sequence after Phase 2
  ↓
Phase 5 (Heartbeat)      ← depends on Phase 4 (shares disconnect() cleanup)
```

Each phase compiles and runs independently. Roll forward, never roll back.

## Files Changed

| File | Phases | Nature |
|---|---|---|
| `Guards.java` | 1 | **NEW** |
| `App.java` | 1, 5 | Add before-filter, add lastHeartbeat to status |
| `OrderRoutes.java` | 1, 2, 3 | Remove guards, add idempotency, rewrite modify(), upgrade logs |
| `ContractRoutes.java` | 1 | Remove inline guard |
| `MarketDataRoutes.java` | 1 | Remove inline guard |
| `AccountRoutes.java` | 1 | Remove inline guard |
| `TwsBridge.java` | 2, 4, 5 | Add modifyOrderPrice(), reaper, heartbeat, replace reconnect thread |

**~200 lines added, ~60 lines deleted. 1 new file. 0 new dependencies.**

## Testing Strategy

1. **Unit**: `roundToOptionTick()` already has known values. Add unit tests for `Guards.isLocalRead()` and `maintenanceRetrySeconds()`.
2. **Integration**: Start sidecar against paper trading (port 4002). Verify:
   - All endpoints return 503 when disconnected (kill Gateway, hit endpoints)
   - Place order, modify, cancel — check AUDIT log lines appear
   - Place same order with same `clientOrderRef` twice within 60s — verify dedup
   - Let sidecar run for 30+ minutes — verify heartbeat log lines and no OOM growth
3. **Chaos**: Kill IB Gateway with `kill -9` (no clean TCP close). Verify heartbeat detects within ~40s and reconnects.
4. **Memory**: Run sidecar for 24+ hours with synthetic load. Verify reaper evicts stale entries.

## Risk Assessment

| Fix | Worst case if buggy | Mitigation |
|---|---|---|
| Guards filter | Blocks a valid request (false 503) | `LOCAL_READ_PATHS` allowlist is explicit and testable |
| Atomic modify | `compute()` holds bin lock during `placeOrder()` — blocks concurrent ops on same orderId | Intentional. Different orderIds never contend. |
| Idempotency | False dedup rejects a legitimate re-order | 60s TTL is short. `clientOrderRef` is opt-in. |
| Audit logging | Noise in logs | `AUDIT` prefix makes filtering trivial |
| Pending cleanup | `values().remove()` is O(n) | Map has <10 concurrent entries |
| Map reaper | Evicts an entry still needed for polling | 24h retention. No order is polled after 24h. |
| Heartbeat | False positive triggers reconnect | 40s threshold is conservative. Maintenance window skipped. |
