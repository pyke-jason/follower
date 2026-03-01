package com.tradefollower.sidecar;

import com.ib.client.*;
import io.javalin.Javalin;
import io.javalin.http.Context;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;

/**
 * Order management endpoints:
 *   POST   /api/orders/single   — place single-contract order
 *   POST   /api/orders/combo    — place BAG (combo/spread) order
 *   GET    /api/orders/:orderId — get order status
 *   PUT    /api/orders/:orderId — modify order (limit price)
 *   DELETE /api/orders/:orderId — cancel order
 */
public class OrderRoutes {

    private static final Logger log = LoggerFactory.getLogger(OrderRoutes.class);

    private final TwsBridge bridge;

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

    @SuppressWarnings("unchecked")
    private void placeSingle(Context ctx) {
        if (!bridge.isConnected()) {
            ctx.status(503).json(Map.of("error", "Not connected to IB Gateway"));
            return;
        }
        if (bridge.isInMaintenanceWindow()) {
            ctx.status(503).json(Map.of("error", "Maintenance window", "retryAfter", maintenanceRetrySeconds()));
            return;
        }

        Map<String, Object> body = ctx.bodyAsClass(Map.class);

        Contract contract = new Contract();
        contract.conid(((Number) body.get("conId")).intValue());
        contract.exchange("SMART");

        Order order = new Order();
        order.action((String) body.get("action"));
        order.orderType((String) body.getOrDefault("orderType", "LMT"));
        order.totalQuantity(Decimal.get(((Number) body.get("quantity")).longValue()));
        order.tif((String) body.getOrDefault("tif", "GTC"));

        if (body.containsKey("limitPrice")) {
            order.lmtPrice(roundToOptionTick(((Number) body.get("limitPrice")).doubleValue()));
        }

        int orderId = bridge.getNextReqId();
        CompletableFuture<Map<String, Object>> future = bridge.createRequest(orderId);

        log.info("Placing single order: {} {} qty={} @ {} (orderId={})",
                order.action(), contract.conid(), order.totalQuantity(), order.lmtPrice(), orderId);

        bridge.getClient().placeOrder(orderId, contract, order);

        try {
            Map<String, Object> result = bridge.awaitRequest(future);
            ctx.json(result);
        } catch (TimeoutException e) {
            // Order may still be processing — return the orderId so client can poll
            ctx.json(Map.of("orderId", orderId, "status", "PendingSubmit"));
        } catch (Exception e) {
            String msg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            ctx.status(400).json(Map.of("error", msg, "orderId", orderId));
        }
    }

    @SuppressWarnings("unchecked")
    private void placeCombo(Context ctx) {
        if (!bridge.isConnected()) {
            ctx.status(503).json(Map.of("error", "Not connected to IB Gateway"));
            return;
        }
        if (bridge.isInMaintenanceWindow()) {
            ctx.status(503).json(Map.of("error", "Maintenance window", "retryAfter", maintenanceRetrySeconds()));
            return;
        }

        Map<String, Object> body = ctx.bodyAsClass(Map.class);

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
            order.lmtPrice(roundToOptionTick(((Number) body.get("limitPrice")).doubleValue()));
        }

        // CRITICAL: NonGuaranteed=1 is REQUIRED for SMART-routed combo orders
        List<TagValue> smartParams = new ArrayList<>();
        smartParams.add(new TagValue("NonGuaranteed", "1"));
        order.smartComboRoutingParams(smartParams);

        int orderId = bridge.getNextReqId();
        CompletableFuture<Map<String, Object>> future = bridge.createRequest(orderId);

        log.info("Placing combo order: {} {} legs={} qty={} @ {} (orderId={})",
                order.action(), contract.symbol(), comboLegs.size(),
                order.totalQuantity(), order.lmtPrice(), orderId);

        bridge.getClient().placeOrder(orderId, contract, order);

        try {
            Map<String, Object> result = bridge.awaitRequest(future);
            ctx.json(result);
        } catch (TimeoutException e) {
            ctx.json(Map.of("orderId", orderId, "status", "PendingSubmit"));
        } catch (Exception e) {
            String msg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            ctx.status(400).json(Map.of("error", msg, "orderId", orderId));
        }
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
        if (!bridge.isConnected()) {
            ctx.status(503).json(Map.of("error", "Not connected to IB Gateway"));
            return;
        }
        if (bridge.isInMaintenanceWindow()) {
            ctx.status(503).json(Map.of("error", "Maintenance window", "retryAfter", maintenanceRetrySeconds()));
            return;
        }

        int orderId = Integer.parseInt(ctx.pathParam("orderId"));
        Map<String, Object> body = ctx.bodyAsClass(Map.class);

        // For modify, we need to resend the order with the same orderId + updated fields.
        // The TWS API requires the full contract+order for modification.
        // We store a minimal version — the client should send the full order params.
        // For the common case (limit price update), we build a minimal modify.

        // The TS client will send { limitPrice, conId, action, orderType, quantity, tif }
        Contract contract = new Contract();
        if (body.containsKey("conId")) {
            contract.conid(((Number) body.get("conId")).intValue());
            contract.exchange("SMART");
        }

        Order order = new Order();
        if (body.containsKey("action")) order.action((String) body.get("action"));
        if (body.containsKey("orderType")) order.orderType((String) body.get("orderType"));
        if (body.containsKey("quantity")) order.totalQuantity(Decimal.get(((Number) body.get("quantity")).longValue()));
        if (body.containsKey("tif")) order.tif((String) body.get("tif"));
        if (body.containsKey("limitPrice")) {
            order.lmtPrice(roundToOptionTick(((Number) body.get("limitPrice")).doubleValue()));
        }

        // Handle combo modify
        if (body.containsKey("legs")) {
            contract.symbol((String) body.getOrDefault("symbol", ""));
            contract.secType("BAG");
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

            List<TagValue> smartParams = new ArrayList<>();
            smartParams.add(new TagValue("NonGuaranteed", "1"));
            order.smartComboRoutingParams(smartParams);
        }

        CompletableFuture<Map<String, Object>> future = bridge.createRequest(orderId);

        log.info("Modifying order {} (limitPrice={})", orderId, order.lmtPrice());

        bridge.getClient().placeOrder(orderId, contract, order);

        try {
            Map<String, Object> result = bridge.awaitRequest(future);
            ctx.json(result);
        } catch (TimeoutException e) {
            ctx.json(Map.of("orderId", orderId, "status", "PendingSubmit"));
        } catch (Exception e) {
            String msg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            ctx.status(400).json(Map.of("error", msg, "orderId", orderId));
        }
    }

    private void cancel(Context ctx) {
        if (!bridge.isConnected()) {
            ctx.status(503).json(Map.of("error", "Not connected to IB Gateway"));
            return;
        }

        int orderId = Integer.parseInt(ctx.pathParam("orderId"));

        log.info("Cancelling order {}", orderId);

        bridge.getClient().cancelOrder(orderId, new OrderCancel(""));

        // Return immediately — cancellation is async, status will update via orderStatus callback
        ctx.json(Map.of("orderId", orderId, "status", "PendingCancel"));
    }

    /**
     * Round price to valid option tick size.
     * Below $3.00: $0.01 increments. At/above $3.00: $0.05 increments.
     * Note: Penny Pilot exceptions (SPY, QQQ, etc.) use $0.01 for all prices,
     * but IB Gateway handles that — we round conservatively here.
     */
    static double roundToOptionTick(double price) {
        if (price < 3.0) {
            return Math.round(price * 100.0) / 100.0;
        } else {
            return Math.round(price * 20.0) / 20.0;
        }
    }

    private int maintenanceRetrySeconds() {
        // Return seconds until 01:45 ET
        java.time.ZonedDateTime now = java.time.ZonedDateTime.now(java.time.ZoneId.of("America/New_York"));
        java.time.ZonedDateTime endMaint = now.withHour(1).withMinute(45).withSecond(0);
        if (now.isAfter(endMaint)) {
            endMaint = endMaint.plusDays(1);
        }
        return (int) java.time.Duration.between(now, endMaint).getSeconds();
    }
}
