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
    private static final Set<Integer> INFORMATIONAL_CODES = Set.of(2104, 2106, 2158);
    // Connection codes — trigger reconnect + WS event
    private static final Set<Integer> CONNECTION_CODES = Set.of(1100, 1101, 1102, 504);
    // Order error codes — push WS event
    private static final Set<Integer> ORDER_ERROR_CODES = Set.of(110, 201, 202, 460);

    private final EClientSocket client;
    private final EJavaSignal signal;
    private final AtomicInteger nextReqId = new AtomicInteger(1);
    private final ConcurrentHashMap<Integer, CompletableFuture<Object>> pendingRequests = new ConcurrentHashMap<>();
    private final WsHandler wsHandler;

    // Temporary accumulators for multi-callback responses
    private final ConcurrentHashMap<Integer, Map<String, Object>> tickAccumulators = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Integer, Map<String, Object>> accountAccumulators = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Integer, CopyOnWriteArrayList<Map<String, Object>>> positionAccumulators = new ConcurrentHashMap<>();

    // Persistent order status tracking (for GET /api/orders/:orderId)
    private final ConcurrentHashMap<Integer, Map<String, Object>> orderStatuses = new ConcurrentHashMap<>();

    private final String host;
    private final int port;
    private final int clientId;

    private volatile boolean connected = false;
    private volatile String accountId;
    private volatile int serverVersion;
    private volatile boolean shuttingDown = false;

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

    public void disconnect() {
        shuttingDown = true;
        if (client.isConnected()) {
            client.eDisconnect();
        }
    }

    private void scheduleReconnect() {
        if (shuttingDown) return;
        new Thread(() -> {
            while (!shuttingDown && !connected) {
                if (isInMaintenanceWindow()) {
                    log.info("In maintenance window (00:15-01:45 ET), deferring reconnect");
                    try { Thread.sleep(60_000); } catch (InterruptedException e) { return; }
                    continue;
                }
                try {
                    Thread.sleep(RECONNECT_DELAY_MS);
                } catch (InterruptedException e) {
                    return;
                }
                if (!connected && !shuttingDown) {
                    log.info("Attempting reconnect to IB Gateway...");
                    try {
                        connect();
                    } catch (Exception e) {
                        log.warn("Reconnect attempt failed: {}", e.getMessage());
                    }
                }
            }
        }, "reconnect-scheduler").start();
    }

    // --- Public accessors ---

    public boolean isConnected() { return connected; }
    public String getAccountId() { return accountId; }
    public int getServerVersion() { return serverVersion; }
    public EClientSocket getClient() { return client; }

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
        return future.get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS);
    }

    /** Get last known order status (for GET polling). */
    public Map<String, Object> getOrderStatus(int orderId) {
        return orderStatuses.get(orderId);
    }

    /** Initialize tick data accumulator for a market data snapshot request. */
    public void initTickAccumulator(int reqId) {
        tickAccumulators.put(reqId, new ConcurrentHashMap<>());
    }

    /** Initialize account summary accumulator. */
    public void initAccountAccumulator(int reqId) {
        accountAccumulators.put(reqId, new ConcurrentHashMap<>());
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
        log.info("Connected to IB Gateway (serverVersion={}, nextValidId={})", serverVersion, orderId);
        wsHandler.broadcastConnected();
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
            if (errorCode == 1100 || errorCode == 504) {
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

        // Fail pending request if there is one
        failRequest(id, new RuntimeException("TWS error " + errorCode + ": " + errorMsg));
    }

    // --- Contract details ---

    @Override
    public void contractDetails(int reqId, ContractDetails contractDetails) {
        Contract c = contractDetails.contract();
        Map<String, Object> result = Map.of(
                "conId", c.conid(),
                "localSymbol", c.localSymbol() != null ? c.localSymbol() : "",
                "multiplier", c.multiplier() != null ? c.multiplier() : "100",
                "exchange", c.exchange() != null && !c.exchange().isEmpty() ? c.exchange() : "SMART"
        );
        completeRequest(reqId, result);
    }

    @Override
    public void contractDetailsEnd(int reqId) {
        CompletableFuture<Object> future = pendingRequests.get(reqId);
        if (future != null && !future.isDone()) {
            failRequest(reqId, new RuntimeException("No contract found"));
        }
    }

    // --- Market data (snapshot) ---

    @Override
    public void tickPrice(int tickerId, int field, double price, TickAttrib attribs) {
        Map<String, Object> acc = tickAccumulators.get(tickerId);
        if (acc == null) return;
        // field: 1=bid, 2=ask, 4=last, 9=close
        switch (field) {
            case 1 -> acc.put("bid", price);
            case 2 -> acc.put("ask", price);
            case 4 -> acc.put("last", price);
            case 9 -> acc.put("close", price);
        }
    }

    @Override
    public void tickSize(int tickerId, int field, Decimal size) {
        Map<String, Object> acc = tickAccumulators.get(tickerId);
        if (acc == null) return;
        // field: 8=volume
        if (field == 8) acc.put("volume", size.longValue());
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

        wsHandler.broadcastOrderStatus(orderId, status, filled.value().doubleValue(),
                remaining.value().doubleValue(), avgFillPrice);

        // Complete any pending future for this order placement
        completeRequest(orderId, statusMap);
    }

    @Override
    public void openOrder(int orderId, Contract contract, Order order, OrderState orderState) {
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

    // --- Account summary ---

    @Override
    public void accountSummary(int reqId, String account, String tag, String value, String currency) {
        Map<String, Object> acc = accountAccumulators.get(reqId);
        if (acc == null) return;
        try {
            acc.put(tag, Double.parseDouble(value));
        } catch (NumberFormatException e) {
            acc.put(tag, value);
        }
        this.accountId = account;
    }

    @Override
    public void accountSummaryEnd(int reqId) {
        Map<String, Object> data = accountAccumulators.remove(reqId);
        completeRequest(reqId, data != null ? data : Map.of());
        client.cancelAccountSummary(reqId);
    }

    @Override
    public void managedAccounts(String accounts) {
        if (accounts != null && !accounts.isEmpty()) {
            this.accountId = accounts.split(",")[0].trim();
            log.info("Managed account: {}", this.accountId);
        }
    }

    // --- Execution details (for commission tracking) ---

    @Override
    public void execDetails(int reqId, Contract contract, Execution execution) {}

    @Override
    public void execDetailsEnd(int reqId) {}

    @Override
    public void commissionAndFeesReport(CommissionAndFeesReport report) {
        log.debug("Commission report: execId={} commission={}", report.execId(), report.commissionAndFees());
    }

    // All remaining EWrapper methods have no-op defaults via DefaultEWrapper
}
