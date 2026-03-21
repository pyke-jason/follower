package com.tradefollower.sidecar;

import com.ib.client.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * EWrapper implementation bridging TWS async callbacks to synchronous REST via CompletableFuture.
 * Manages EReader thread, connection lifecycle, and auto-reconnect with maintenance window awareness.
 *
 * This is a PURE PROTOCOL TRANSLATOR. No business logic.
 */
public class TwsBridge extends DefaultEWrapper {

    private static final Logger log = LoggerFactory.getLogger(TwsBridge.class);
    private static final ZoneId ET = ZoneId.of("America/New_York");
    private static final long RECONNECT_DELAY_MS = 5000;
    static final long REQUEST_TIMEOUT_SECONDS = 5;

    // Informational codes — log at debug, don't push to WS
    // 10089/10091: "market data requires subscription" — benign when delayed data (type=3) is active
    // 10167: "Displaying delayed market data" — confirms delayed ticks will follow
    private static final Set<Integer> INFORMATIONAL_CODES = Set.of(2104, 2106, 2107, 2158, 10089, 10091, 10167);
    // Connection codes — trigger reconnect + WS event
    private static final Set<Integer> CONNECTION_CODES = Set.of(520, 1100, 1101, 1102, 504);
    // Order error codes — push WS event
    private static final Set<Integer> ORDER_ERROR_CODES = Set.of(
            110, 200, 201, 202, 203, 392, 399, 404, 412, 426, 460, 10239);

    private final EClientSocket client;
    private final EJavaSignal signal;
    private final AtomicInteger nextReqId = new AtomicInteger(1);
    private final ConcurrentHashMap<Integer, CompletableFuture<Object>> pendingRequests = new ConcurrentHashMap<>();
    private final WsHandler wsHandler;

    // Temporary accumulators for multi-callback responses
    private final ConcurrentHashMap<Integer, Map<String, Object>> tickAccumulators = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Integer, CopyOnWriteArrayList<Map<String, Object>>> positionAccumulators = new ConcurrentHashMap<>();

    // Persistent order status tracking (for GET /api/orders/:orderId)
    private final ConcurrentHashMap<Integer, Map<String, Object>> orderStatuses = new ConcurrentHashMap<>();

    /** Original Contract+Order from placement — used by modify() and execDetails context. */
    public record StoredOrder(Contract contract, Order order) {}
    private final ConcurrentHashMap<Integer, StoredOrder> orderStore = new ConcurrentHashMap<>();

    /** Execution details keyed by execId — for commission correlation. */
    private final ConcurrentHashMap<String, Map<String, Object>> executionStore = new ConcurrentHashMap<>();

    private static final long EVICTION_AGE_MS = 24 * 60 * 60 * 1000; // 24h

    // Companion timestamp maps
    private final ConcurrentHashMap<String, Long>  executionTimestamps = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Integer, Long> orderTimestamps     = new ConcurrentHashMap<>();

    private final ScheduledExecutorService reaper = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "map-reaper");
        t.setDaemon(true);
        return t;
    });

    // Persistent reqAccountUpdates subscription data
    private final ConcurrentHashMap<String, String> accountValues = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Integer, Map<String, Object>> portfolioPositions = new ConcurrentHashMap<>();
    private volatile boolean accountSubscriptionActive = false;

    private final String host;
    private final int port;
    private final int clientId;

    private volatile boolean connected = false;
    private volatile String accountId;
    private volatile int serverVersion;
    private volatile boolean shuttingDown = false;

    private static final long HEARTBEAT_INTERVAL_MS = 30_000;
    private static final long HEARTBEAT_DEAD_MS     = 40_000;

    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "heartbeat-watchdog");
        t.setDaemon(true);
        return t;
    });
    private volatile long lastHeartbeatResponse = System.currentTimeMillis();
    private volatile ScheduledFuture<?> heartbeatTask;
    private volatile ScheduledFuture<?> reconnectTask;
    private volatile ScheduledFuture<?> reaperTask;

    public TwsBridge(WsHandler wsHandler) {
        this.wsHandler = wsHandler;
        this.signal = new EJavaSignal();
        this.client = new EClientSocket(this, signal);

        this.host = System.getenv().getOrDefault("IBKR_GATEWAY_HOST", "127.0.0.1");
        this.port = Integer.parseInt(System.getenv().getOrDefault("IBKR_GATEWAY_PORT", "4001"));
        this.clientId = Integer.parseInt(System.getenv().getOrDefault("IBKR_CLIENT_ID", "1"));
    }

    // --- Connection lifecycle ---

    public void connect() {
        log.info("Connecting to IB Gateway at {}:{} (clientId={})", host, port, clientId);
        client.eConnect(host, port, clientId);

        // CRITICAL: EReader thread pattern — without this, ZERO callbacks fire
        EReader reader = new EReader(client, signal);
        reader.start();
        new Thread(() -> {
            while (client.isConnected()) {
                signal.waitForSignal();
                try {
                    reader.processMsgs();
                } catch (Exception e) {
                    log.error("EReader processMsgs error: {}", e.getMessage());
                }
            }
        }, "ereader-dispatch").start();
    }

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

    public void disconnect() {
        shuttingDown = true;
        if (heartbeatTask != null) heartbeatTask.cancel(false);
        if (reconnectTask != null) reconnectTask.cancel(false);
        watchdog.shutdownNow();
        reaper.shutdownNow();
        if (client.isConnected()) client.eDisconnect();
    }

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

        // Safety net: sweep orphaned accumulators
        tickAccumulators.keySet().removeIf(k -> !pendingRequests.containsKey(k));
        positionAccumulators.keySet().removeIf(k -> !pendingRequests.containsKey(k));

        if (execCount > 0 || orderCount > 0) {
            log.info("Evicted {} execution entries, {} order entries (>24h old)", execCount, orderCount);
        }
    }

    // --- Public accessors ---

    public boolean isConnected() { return connected; }
    public String getAccountId() { return accountId; }
    public int getServerVersion() { return serverVersion; }
    public EClientSocket getClient() { return client; }
    public Map<String, String> getAccountValues() { return accountValues; }
    public Map<Integer, Map<String, Object>> getPortfolioPositions() { return portfolioPositions; }
    public boolean isAccountSubscriptionActive() { return accountSubscriptionActive; }
    public long getLastHeartbeatResponse() { return lastHeartbeatResponse; }

    public int getNextReqId() { return nextReqId.getAndIncrement(); }

    /**
     * Returns true if currently in IBKR daily maintenance window (00:15-01:45 ET).
     */
    public boolean isInMaintenanceWindow() {
        ZonedDateTime now = ZonedDateTime.now(ET);
        int minutes = now.getHour() * 60 + now.getMinute();
        return minutes >= 15 && minutes < 105;
    }

    // --- Request/response mapping ---

    @SuppressWarnings("unchecked")
    public <T> CompletableFuture<T> createRequest(int reqId) {
        CompletableFuture<Object> future = new CompletableFuture<>();
        pendingRequests.put(reqId, future);
        return (CompletableFuture<T>) (CompletableFuture<?>) future;
    }

    public void completeRequest(int reqId, Object result) {
        CompletableFuture<Object> future = pendingRequests.remove(reqId);
        if (future != null) {
            future.complete(result);
        }
    }

    public void failRequest(int reqId, Exception ex) {
        CompletableFuture<Object> future = pendingRequests.remove(reqId);
        if (future != null) {
            future.completeExceptionally(ex);
        }
    }

    public <T> T awaitRequest(CompletableFuture<T> future) throws Exception {
        try {
            return future.get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } finally {
            pendingRequests.values().remove(future);
        }
    }

    /** Get last known order status (for GET polling). */
    public Map<String, Object> getOrderStatus(int orderId) {
        return orderStatuses.get(orderId);
    }

    public void storeOrder(int orderId, Contract contract, Order order) {
        orderStore.put(orderId, new StoredOrder(contract, order));
        orderTimestamps.put(orderId, System.currentTimeMillis());
    }

    public StoredOrder getStoredOrder(int orderId) {
        return orderStore.get(orderId);
    }

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

    /** Initialize tick data accumulator for a market data snapshot request. */
    public void initTickAccumulator(int reqId) {
        tickAccumulators.put(reqId, new ConcurrentHashMap<>());
    }

    /** Initialize position list accumulator. */
    public void initPositionAccumulator(int reqId) {
        positionAccumulators.put(reqId, new CopyOnWriteArrayList<>());
    }

    // --- EWrapper callbacks ---

    @Override
    public void nextValidId(int orderId) {
        nextReqId.set(orderId);
        connected = true;
        serverVersion = client.serverVersion();
        lastHeartbeatResponse = System.currentTimeMillis();
        log.info("Connected to IB Gateway (serverVersion={}, nextValidId={})", serverVersion, orderId);
        wsHandler.broadcastConnected();
        startHeartbeat();

        // Enable delayed market data for paper trading (no real-time subscription needed)
        if (port == 4002) {
            log.info("Paper mode (port 4002) — requesting delayed market data (type=3)");
            client.reqMarketDataType(3);
        }
        if (reaperTask != null) reaperTask.cancel(false);
        reaperTask = reaper.scheduleAtFixedRate(this::evictStaleEntries, 30, 30, TimeUnit.MINUTES);
    }

    @Override
    public void connectAck() {
        if (client.isAsyncEConnect()) {
            client.startAPI();
        }
    }

    @Override
    public void connectionClosed() {
        connected = false;
        log.warn("Connection to IB Gateway closed");
        wsHandler.broadcastDisconnected();

        // Fail all pending requests
        for (var entry : pendingRequests.entrySet()) {
            entry.getValue().completeExceptionally(new RuntimeException("Connection closed"));
        }
        pendingRequests.clear();

        scheduleReconnect();
    }

    @Override
    public void error(Exception e) {
        log.error("TWS error: {}", e.getMessage());
    }

    @Override
    public void error(String str) {
        log.error("TWS error: {}", str);
    }

    @Override
    public void error(int id, long reqId, int errorCode, String errorMsg, String advancedOrderRejectJson) {
        if (INFORMATIONAL_CODES.contains(errorCode)) {
            log.debug("TWS info [{}]: {} - {}", id, errorCode, errorMsg);
            return;
        }

        if (CONNECTION_CODES.contains(errorCode)) {
            log.warn("TWS connection [{}]: {} - {}", id, errorCode, errorMsg);
            if (errorCode == 520 || errorCode == 1100 || errorCode == 504) {
                connected = false;
                wsHandler.broadcastDisconnected();
                scheduleReconnect();
            } else if (errorCode == 1101 || errorCode == 1102) {
                connected = true;
                wsHandler.broadcastReconnected();
            }
            return;
        }

        log.error("TWS error [id={}, reqId={}]: {} - {}", id, reqId, errorCode, errorMsg);

        if (ORDER_ERROR_CODES.contains(errorCode)) {
            wsHandler.broadcastError(errorCode, errorMsg, id);
        }

        // Fail pending request with typed exception for proper HTTP status mapping
        failRequest(id, new TwsException(errorCode, "TWS error " + errorCode + ": " + errorMsg));
    }

    @Override
    public void currentTime(long time) {
        lastHeartbeatResponse = System.currentTimeMillis();
        log.debug("Heartbeat response: server time={}", time);
    }

    // --- Contract details ---

    @Override
    public void contractDetails(int reqId, ContractDetails contractDetails) {
        Contract c = contractDetails.contract();
        Map<String, Object> result = Map.of(
                "conId", c.conid(),
                "localSymbol", c.localSymbol() != null ? c.localSymbol() : "",
                "multiplier", c.multiplier() != null ? c.multiplier() : "100",
                "exchange", c.exchange() != null && !c.exchange().isEmpty() ? c.exchange() : "SMART",
                "minTick", contractDetails.minTick()
        );
        completeRequest(reqId, result);
    }

    @Override
    public void contractDetailsEnd(int reqId) {
        CompletableFuture<Object> future = pendingRequests.get(reqId);
        if (future != null && !future.isDone()) {
            failRequest(reqId, new TwsException(200, "No contract found"));
        }
    }

    // --- Market data (snapshot) ---

    @Override
    public void tickPrice(int tickerId, int field, double price, TickAttrib attribs) {
        Map<String, Object> acc = tickAccumulators.get(tickerId);
        if (acc == null) return;
        // field: 1=bid, 2=ask, 4=last, 9=close
        // Delayed equivalents: 66=bid, 67=ask, 68=last, 72=close
        switch (field) {
            case 1, 66 -> acc.put("bid", price);
            case 2, 67 -> acc.put("ask", price);
            case 4, 68 -> acc.put("last", price);
            case 9, 72 -> acc.put("close", price);
        }
    }

    @Override
    public void tickSize(int tickerId, int field, Decimal size) {
        Map<String, Object> acc = tickAccumulators.get(tickerId);
        if (acc == null) return;
        // field: 8=volume, 74=delayed volume
        if (field == 8 || field == 74) acc.put("volume", size.longValue());
    }

    @Override
    public void tickSnapshotEnd(int reqId) {
        Map<String, Object> data = tickAccumulators.remove(reqId);
        completeRequest(reqId, data != null ? data : Map.of());
        client.cancelMktData(reqId);
    }

    // --- Order status ---

    @Override
    public void orderStatus(int orderId, String status, Decimal filled, Decimal remaining,
                            double avgFillPrice, long permId, int parentId, double lastFillPrice,
                            int clientId, String whyHeld, double mktCapPrice) {
        Map<String, Object> statusMap = new ConcurrentHashMap<>();
        statusMap.put("orderId", orderId);
        statusMap.put("status", status);
        statusMap.put("filledQuantity", filled.longValue());
        statusMap.put("remaining", remaining.longValue());
        statusMap.put("avgFillPrice", avgFillPrice);
        orderStatuses.put(orderId, statusMap);
        orderTimestamps.put(orderId, System.currentTimeMillis());

        wsHandler.broadcastOrderStatus(orderId, status, filled.value().doubleValue(),
                remaining.value().doubleValue(), avgFillPrice);

        // Complete any pending future for this order placement
        completeRequest(orderId, statusMap);
    }

    @Override
    public void openOrder(int orderId, Contract contract, Order order, OrderState orderState) {
        orderStore.putIfAbsent(orderId, new StoredOrder(contract, order));
        Map<String, Object> statusMap = orderStatuses.computeIfAbsent(orderId, k -> new ConcurrentHashMap<>());
        statusMap.put("orderId", orderId);
        statusMap.put("status", orderState.status().toString());
        if (orderState.commissionAndFees() != Double.MAX_VALUE) {
            statusMap.put("commission", orderState.commissionAndFees());
        }
    }

    // --- Positions ---

    @Override
    public void position(String account, Contract contract, Decimal pos, double avgCost) {
        // Find the active position accumulator (there should be exactly one)
        for (var entry : positionAccumulators.entrySet()) {
            Map<String, Object> posData = new ConcurrentHashMap<>();
            posData.put("conId", contract.conid());
            posData.put("symbol", contract.symbol());
            posData.put("secType", contract.getSecType());
            posData.put("localSymbol", contract.localSymbol() != null ? contract.localSymbol() : "");
            posData.put("position", pos.longValue());
            posData.put("avgCost", avgCost);
            entry.getValue().add(posData);
        }
    }

    @Override
    public void positionEnd() {
        for (var entry : positionAccumulators.entrySet()) {
            completeRequest(entry.getKey(), entry.getValue());
            positionAccumulators.remove(entry.getKey());
        }
    }

    // --- Account subscription (reqAccountUpdates) ---

    @Override
    public void updateAccountValue(String key, String value, String currency, String accountName) {
        if (currency.isEmpty() || "USD".equals(currency)) {
            accountValues.put(key, value);
        }
    }

    @Override
    public void updatePortfolio(Contract contract, Decimal position, double marketPrice,
            double marketValue, double averageCost, double unrealizedPNL,
            double realizedPNL, String accountName) {
        portfolioPositions.put(contract.conid(), Map.of(
            "conId", contract.conid(),
            "symbol", contract.symbol(),
            "secType", contract.getSecType(),
            "localSymbol", contract.localSymbol() != null ? contract.localSymbol() : "",
            "position", position.longValue(),
            "avgCost", averageCost,
            "marketValue", marketValue,
            "unrealizedPnl", unrealizedPNL,
            "marketPrice", marketPrice
        ));
    }

    @Override
    public void accountDownloadEnd(String accountName) {
        accountSubscriptionActive = true;
        log.debug("Account subscription snapshot complete for {}", accountName);
    }

    @Override
    public void managedAccounts(String accounts) {
        if (accounts != null && !accounts.isEmpty()) {
            this.accountId = accounts.split(",")[0].trim();
            log.info("Managed account: {}", this.accountId);
            if (connected && !accountSubscriptionActive) {
                client.reqAccountUpdates(true, this.accountId);
                log.info("Started reqAccountUpdates subscription for {}", this.accountId);
            }
        }
    }

    // --- Execution details (for commission tracking) ---

    @Override
    public void execDetails(int reqId, Contract contract, Execution execution) {
        Map<String, Object> exec = Map.of(
            "execId", execution.execId(),
            "orderId", execution.orderId(),
            "symbol", contract.symbol(),
            "side", execution.side(),
            "quantity", execution.shares().longValue(),
            "price", execution.price(),
            "time", execution.time(),
            "liquidation", execution.liquidation()
        );
        executionStore.put(execution.execId(), exec);
        executionTimestamps.put(execution.execId(), System.currentTimeMillis());
        wsHandler.broadcastExecDetails(exec);
    }

    @Override
    public void execDetailsEnd(int reqId) {}

    @Override
    public void commissionAndFeesReport(CommissionAndFeesReport report) {
        if (report.commissionAndFees() == Double.MAX_VALUE) return;
        Map<String, Object> exec = executionStore.get(report.execId());
        int orderId = exec != null ? (int) exec.get("orderId") : -1;
        wsHandler.broadcastCommission(report.execId(), report.commissionAndFees(), orderId);
    }

    // All remaining EWrapper methods have no-op defaults via DefaultEWrapper
}
