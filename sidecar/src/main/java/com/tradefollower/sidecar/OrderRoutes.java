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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
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

    private final TwsBridge bridge;

    private static final long IDEMPOTENCY_TTL_MS = 60_000;

    private record IdempotencyEntry(int orderId, long createdAt) {}
    private final ConcurrentHashMap<String, IdempotencyEntry> recentOrders = new ConcurrentHashMap<>();

    private final ScheduledExecutorService idempotencyReaper = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "idempotency-reaper");
        t.setDaemon(true);
        return t;
    });

    private void evictStaleRefs() {
        long cutoff = System.currentTimeMillis() - IDEMPOTENCY_TTL_MS;
        recentOrders.entrySet().removeIf(e -> e.getValue().createdAt() < cutoff);
    }

    public OrderRoutes(TwsBridge bridge) {
        this.bridge = bridge;
        // Background cleanup prevents unbounded growth when sidecar is idle
        idempotencyReaper.scheduleAtFixedRate(this::evictStaleRefs, 1, 1, TimeUnit.MINUTES);
    }

    public void register(Javalin app) {
        app.post("/api/orders/single", this::placeSingle);
        app.post("/api/orders/combo", this::placeCombo);
        app.get("/api/orders/{orderId}", this::getStatus);
        app.put("/api/orders/{orderId}", this::modify);
        app.delete("/api/orders/{orderId}", this::cancel);
        app.delete("/api/orders", this::cancelAll);
    }

    /** Await order future with standard timeout/error handling. */
    private void awaitAndRespond(Context ctx, CompletableFuture<Map<String, Object>> future, int orderId) {
        try {
            ctx.json(bridge.awaitRequest(future));
        } catch (TimeoutException e) {
            ctx.json(Map.of("orderId", orderId, "status", "PendingSubmit"));
        } catch (Exception e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            String msg = cause.getMessage() != null ? cause.getMessage() : cause.getClass().getSimpleName();
            if (cause instanceof TwsException twsErr) {
                int status = twsErr.isNoSecurityDef() ? 422
                           : twsErr.isValidationError() ? 400
                           : twsErr.isOrderRejected() ? 400
                           : 500;
                ctx.status(status).json(Map.of("error", msg, "orderId", orderId, "twsCode", twsErr.getErrorCode()));
            } else {
                ctx.status(500).json(Map.of("error", msg, "orderId", orderId));
            }
        }
    }

    private void placeSingle(Context ctx) {
        var body = ctx.bodyAsClass(RequestBodies.PlaceSingleBody.class);

        if (body.clientOrderRef() != null) {
            evictStaleRefs();
            IdempotencyEntry existing = recentOrders.get(body.clientOrderRef());
            if (existing != null) {
                log.info("AUDIT idempotent-hit clientOrderRef={} existingOrderId={}", body.clientOrderRef(), existing.orderId());
                Map<String, Object> status = bridge.getOrderStatus(existing.orderId());
                ctx.json(status != null ? status : Map.of("orderId", existing.orderId(), "status", "PendingSubmit"));
                return;
            }
        }

        Contract contract = new Contract();
        contract.conid(body.conId());
        contract.exchange("SMART");

        Order order = new Order();
        order.action(body.action());
        order.orderType(body.orderType());
        order.totalQuantity(Decimal.get(body.quantity()));
        order.tif(body.tif());

        if (body.limitPrice() != null) {
            order.lmtPrice(body.limitPrice());
        }
        // auxPrice is the stop/trigger price for STP and STP LMT orders
        if (body.auxPrice() != null) {
            order.auxPrice(body.auxPrice());
        }

        int orderId = bridge.getNextReqId();

        if (body.clientOrderRef() != null) {
            recentOrders.put(body.clientOrderRef(), new IdempotencyEntry(orderId, System.currentTimeMillis()));
            order.orderRef(body.clientOrderRef());
        }

        CompletableFuture<Map<String, Object>> future = bridge.createRequest(orderId);

        log.info("AUDIT placeOrder orderId={} conId={} action={} qty={} orderType={} limitPrice={} auxPrice={} tif={} clientOrderRef={}",
                orderId, contract.conid(), order.action(), order.totalQuantity(), order.orderType(), order.lmtPrice(), order.auxPrice(), order.tif(), body.clientOrderRef());

        bridge.getClient().placeOrder(orderId, contract, order);
        bridge.storeOrder(orderId, contract, order);
        awaitAndRespond(ctx, future, orderId);
    }

    private void placeCombo(Context ctx) {
        var body = ctx.bodyAsClass(RequestBodies.PlaceComboBody.class);

        if (body.clientOrderRef() != null) {
            evictStaleRefs();
            IdempotencyEntry existing = recentOrders.get(body.clientOrderRef());
            if (existing != null) {
                log.info("AUDIT idempotent-hit clientOrderRef={} existingOrderId={}", body.clientOrderRef(), existing.orderId());
                Map<String, Object> status = bridge.getOrderStatus(existing.orderId());
                ctx.json(status != null ? status : Map.of("orderId", existing.orderId(), "status", "PendingSubmit"));
                return;
            }
        }

        // Build BAG contract with ComboLegs
        Contract contract = new Contract();
        contract.symbol(body.symbol());
        contract.secType("BAG");
        contract.exchange("SMART");
        contract.currency("USD");

        List<ComboLeg> comboLegs = new ArrayList<>();
        for (var legDef : body.legs()) {
            ComboLeg leg = new ComboLeg();
            leg.conid(legDef.conId());
            leg.ratio(legDef.ratio());
            leg.action(legDef.action());
            leg.exchange(legDef.exchange());
            comboLegs.add(leg);
        }
        contract.comboLegs(comboLegs);

        Order order = new Order();
        order.action(body.action());
        order.orderType(body.orderType());
        order.totalQuantity(Decimal.get(body.quantity()));
        order.tif(body.tif());

        if (body.limitPrice() != null) {
            order.lmtPrice(body.limitPrice());
        }

        // CRITICAL: NonGuaranteed=1 is REQUIRED for SMART-routed combo orders
        List<TagValue> smartParams = new ArrayList<>();
        smartParams.add(new TagValue("NonGuaranteed", "1"));
        order.smartComboRoutingParams(smartParams);

        int orderId = bridge.getNextReqId();

        if (body.clientOrderRef() != null) {
            recentOrders.put(body.clientOrderRef(), new IdempotencyEntry(orderId, System.currentTimeMillis()));
            order.orderRef(body.clientOrderRef());
        }

        CompletableFuture<Map<String, Object>> future = bridge.createRequest(orderId);

        log.info("AUDIT placeOrder orderId={} symbol={} action={} qty={} orderType={} limitPrice={} tif={} legs={} clientOrderRef={}",
                orderId, contract.symbol(), order.action(), order.totalQuantity(), order.orderType(), order.lmtPrice(), order.tif(), comboLegs.size(), body.clientOrderRef());

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

    private void modify(Context ctx) {
        int orderId = Integer.parseInt(ctx.pathParam("orderId"));
        var body = ctx.bodyAsClass(RequestBodies.ModifyBody.class);

        double newPrice = body.limitPrice();
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

    private void cancel(Context ctx) {
        int orderId = Integer.parseInt(ctx.pathParam("orderId"));

        if (bridge.getStoredOrder(orderId) == null && bridge.getOrderStatus(orderId) == null) {
            ctx.status(404).json(Map.of("error", "Order not found", "orderId", orderId));
            return;
        }

        log.info("AUDIT cancelOrder orderId={}", orderId);

        bridge.getClient().cancelOrder(orderId, new OrderCancel(""));

        // Return immediately — cancellation is async, status will update via orderStatus callback
        ctx.json(Map.of("orderId", orderId, "status", "PendingCancel"));
    }

    private void cancelAll(Context ctx) {
        log.info("AUDIT cancelAllOrders (reqGlobalCancel) — kill switch triggered");
        bridge.getClient().reqGlobalCancel(new OrderCancel(""));
        ctx.json(Map.of("cancelled", true));
    }

}
