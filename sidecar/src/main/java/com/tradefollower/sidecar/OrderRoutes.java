package com.tradefollower.sidecar;

import com.ib.client.*;
import io.javalin.Javalin;
import io.javalin.http.Context;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeoutException;

/**
 * Order management endpoints:
 *   POST   /api/orders/single   — place single-contract order
 *   POST   /api/orders/combo    — place BAG (combo/spread) order
 *   GET    /api/orders/:orderId — get order status
 *   PUT    /api/orders/:orderId — modify order (limit price via OrderStore lookup)
 *   DELETE /api/orders/:orderId — cancel order
 */
public class OrderRoutes {

    private static final Logger log = LoggerFactory.getLogger(OrderRoutes.class);

    private static final Set<String> PENNY_PILOT = Set.of(
        "AAPL", "AMD", "AMZN", "BAC", "C", "COIN", "CSCO", "DIA", "EEM", "EWZ",
        "F", "GE", "GLD", "GOOG", "GOOGL", "HOOD", "HYG", "INTC", "IWM", "JPM",
        "META", "MSFT", "MU", "NFLX", "NVDA", "PFE", "PLTR", "QQQ", "ROKU",
        "SLV", "SNAP", "SOFI", "SPY", "SQ", "T", "TLT", "TSLA", "UBER",
        "USO", "VXX", "XLE", "XLF", "XLK"
    );

    private final TwsBridge bridge;

    private static final long IDEMPOTENCY_TTL_MS = 60_000;

    private record IdempotencyEntry(int orderId, long createdAt) {}
    private final ConcurrentHashMap<String, IdempotencyEntry> recentOrders = new ConcurrentHashMap<>();

    private void evictStaleRefs() {
        long cutoff = System.currentTimeMillis() - IDEMPOTENCY_TTL_MS;
        recentOrders.entrySet().removeIf(e -> e.getValue().createdAt() < cutoff);
    }

    public OrderRoutes(TwsBridge bridge) {
        this.bridge = bridge;
    }

    public void register(Javalin app) {
        app.post("/api/orders/single", this::placeSingle);
        app.post("/api/orders/combo", this::placeCombo);
        app.get("/api/orders/{orderId}", this::getStatus);
        app.put("/api/orders/{orderId}", this::modify);
        app.delete("/api/orders/{orderId}", this::cancel);
    }

    /** Await order future with standard timeout/error handling. */
    private void awaitAndRespond(Context ctx, CompletableFuture<Map<String, Object>> future, int orderId) {
        try {
            ctx.json(bridge.awaitRequest(future));
        } catch (TimeoutException e) {
            ctx.json(Map.of("orderId", orderId, "status", "PendingSubmit"));
        } catch (Exception e) {
            String msg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            ctx.status(400).json(Map.of("error", msg, "orderId", orderId));
        }
    }

    @SuppressWarnings("unchecked")
    private void placeSingle(Context ctx) {
        Map<String, Object> body = ctx.bodyAsClass(Map.class);

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

        Contract contract = new Contract();
        contract.conid(((Number) body.get("conId")).intValue());
        contract.exchange("SMART");

        Order order = new Order();
        order.action((String) body.get("action"));
        order.orderType((String) body.getOrDefault("orderType", "LMT"));
        order.totalQuantity(Decimal.get(((Number) body.get("quantity")).longValue()));
        order.tif((String) body.getOrDefault("tif", "GTC"));

        if (body.containsKey("limitPrice")) {
            String underlying = (String) body.get("underlying");
            order.lmtPrice(roundToOptionTick(underlying, ((Number) body.get("limitPrice")).doubleValue()));
        }

        int orderId = bridge.getNextReqId();

        if (clientOrderRef != null) {
            recentOrders.put(clientOrderRef, new IdempotencyEntry(orderId, System.currentTimeMillis()));
            order.orderRef(clientOrderRef);
        }

        CompletableFuture<Map<String, Object>> future = bridge.createRequest(orderId);

        log.info("AUDIT placeOrder orderId={} conId={} action={} qty={} orderType={} limitPrice={} tif={} clientOrderRef={}",
                orderId, contract.conid(), order.action(), order.totalQuantity(), order.orderType(), order.lmtPrice(), order.tif(), clientOrderRef);

        bridge.getClient().placeOrder(orderId, contract, order);
        bridge.storeOrder(orderId, contract, order);
        awaitAndRespond(ctx, future, orderId);
    }

    @SuppressWarnings("unchecked")
    private void placeCombo(Context ctx) {
        Map<String, Object> body = ctx.bodyAsClass(Map.class);

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

        // Build BAG contract with ComboLegs
        Contract contract = new Contract();
        contract.symbol((String) body.get("symbol"));
        contract.secType("BAG");
        contract.exchange("SMART");
        contract.currency("USD");

        List<Map<String, Object>> legDefs = (List<Map<String, Object>>) body.get("legs");
        List<ComboLeg> comboLegs = new ArrayList<>();
        for (Map<String, Object> legDef : legDefs) {
            ComboLeg leg = new ComboLeg();
            leg.conid(((Number) legDef.get("conId")).intValue());
            leg.ratio(((Number) legDef.getOrDefault("ratio", 1)).intValue());
            leg.action((String) legDef.get("action"));
            leg.exchange((String) legDef.getOrDefault("exchange", "SMART"));
            comboLegs.add(leg);
        }
        contract.comboLegs(comboLegs);

        Order order = new Order();
        order.action((String) body.get("action"));
        order.orderType((String) body.getOrDefault("orderType", "LMT"));
        order.totalQuantity(Decimal.get(((Number) body.get("quantity")).longValue()));
        order.tif((String) body.getOrDefault("tif", "GTC"));

        if (body.containsKey("limitPrice")) {
            order.lmtPrice(roundToOptionTick(contract.symbol(), ((Number) body.get("limitPrice")).doubleValue()));
        }

        // CRITICAL: NonGuaranteed=1 is REQUIRED for SMART-routed combo orders
        List<TagValue> smartParams = new ArrayList<>();
        smartParams.add(new TagValue("NonGuaranteed", "1"));
        order.smartComboRoutingParams(smartParams);

        int orderId = bridge.getNextReqId();

        if (clientOrderRef != null) {
            recentOrders.put(clientOrderRef, new IdempotencyEntry(orderId, System.currentTimeMillis()));
            order.orderRef(clientOrderRef);
        }

        CompletableFuture<Map<String, Object>> future = bridge.createRequest(orderId);

        log.info("AUDIT placeOrder orderId={} symbol={} action={} qty={} orderType={} limitPrice={} tif={} legs={} clientOrderRef={}",
                orderId, contract.symbol(), order.action(), order.totalQuantity(), order.orderType(), order.lmtPrice(), order.tif(), comboLegs.size(), clientOrderRef);

        bridge.getClient().placeOrder(orderId, contract, order);
        bridge.storeOrder(orderId, contract, order);
        awaitAndRespond(ctx, future, orderId);
    }

    private void getStatus(Context ctx) {
        int orderId = Integer.parseInt(ctx.pathParam("orderId"));
        Map<String, Object> status = bridge.getOrderStatus(orderId);
        if (status != null) {
            ctx.json(status);
        } else {
            ctx.status(404).json(Map.of("error", "Order not found", "orderId", orderId));
        }
    }

    @SuppressWarnings("unchecked")
    private void modify(Context ctx) {
        int orderId = Integer.parseInt(ctx.pathParam("orderId"));
        Map<String, Object> body = ctx.bodyAsClass(Map.class);

        if (!body.containsKey("limitPrice")) {
            ctx.status(400).json(Map.of("error", "limitPrice is required", "orderId", orderId));
            return;
        }

        TwsBridge.StoredOrder stored = bridge.getStoredOrder(orderId);
        String underlying = stored != null ? stored.contract().symbol() : null;
        double newPrice = roundToOptionTick(underlying, ((Number) body.get("limitPrice")).doubleValue());
        CompletableFuture<Map<String, Object>> future = bridge.createRequest(orderId);

        stored = bridge.modifyOrderPrice(orderId, newPrice);
        if (stored == null) {
            bridge.failRequest(orderId, new RuntimeException("Order not in store"));
            ctx.status(404).json(Map.of("error", "Order not in store", "orderId", orderId));
            return;
        }

        log.info("AUDIT modifyOrder orderId={} conId={} newLimitPrice={}",
                orderId, stored.contract().conid(), newPrice);
        awaitAndRespond(ctx, future, orderId);
    }

    private void cancel(Context ctx) {
        int orderId = Integer.parseInt(ctx.pathParam("orderId"));

        log.info("AUDIT cancelOrder orderId={}", orderId);

        bridge.getClient().cancelOrder(orderId, new OrderCancel(""));

        // Return immediately — cancellation is async, status will update via orderStatus callback
        ctx.json(Map.of("orderId", orderId, "status", "PendingCancel"));
    }

    /**
     * Round price to valid option tick size.
     * - Penny Pilot symbols: always $0.01
     * - Below $3.00: $0.01 increments
     * - At/above $3.00: $0.05 increments
     */
    static double roundToOptionTick(String underlying, double price) {
        if (underlying != null && PENNY_PILOT.contains(underlying)) {
            return Math.round(price * 100.0) / 100.0;
        }
        if (price < 3.0) {
            return Math.round(price * 100.0) / 100.0;
        }
        return Math.round(price * 20.0) / 20.0;
    }
}
