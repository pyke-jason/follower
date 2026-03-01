package com.tradefollower.sidecar;

import io.javalin.Javalin;
import io.javalin.http.Context;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;

/**
 * Account and position endpoints:
 *   GET /api/account/summary — netLiquidation, availableFunds, maintenanceMargin, unrealizedPnl
 *   GET /api/positions        — individual option legs with conId, symbol, position, avgCost, etc.
 */
public class AccountRoutes {

    private static final Logger log = LoggerFactory.getLogger(AccountRoutes.class);

    // Tags to request from TWS account summary
    private static final String ACCOUNT_TAGS =
            "NetLiquidation,AvailableFunds,MaintMarginReq,UnrealizedPnL";

    private final TwsBridge bridge;

    public AccountRoutes(TwsBridge bridge) {
        this.bridge = bridge;
    }

    public void register(Javalin app) {
        app.get("/api/account/summary", this::summary);
        app.get("/api/positions", this::positions);
    }

    @SuppressWarnings("unchecked")
    private void summary(Context ctx) {
        if (!bridge.isConnected()) {
            ctx.status(503).json(Map.of("error", "Not connected to IB Gateway"));
            return;
        }

        int reqId = bridge.getNextReqId();
        bridge.initAccountAccumulator(reqId);
        CompletableFuture<Map<String, Object>> future = bridge.createRequest(reqId);

        log.debug("Requesting account summary (reqId={})", reqId);

        bridge.getClient().reqAccountSummary(reqId, "All", ACCOUNT_TAGS);

        try {
            Map<String, Object> data = bridge.awaitRequest(future);

            // Map TWS tag names to our API field names
            ctx.json(Map.of(
                    "netLiquidation", data.getOrDefault("NetLiquidation", 0.0),
                    "availableFunds", data.getOrDefault("AvailableFunds", 0.0),
                    "maintenanceMargin", data.getOrDefault("MaintMarginReq", 0.0),
                    "unrealizedPnl", data.getOrDefault("UnrealizedPnL", 0.0)
            ));
        } catch (TimeoutException e) {
            bridge.getClient().cancelAccountSummary(reqId);
            ctx.status(504).json(Map.of("error", "Account summary timed out"));
        } catch (Exception e) {
            String msg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            ctx.status(500).json(Map.of("error", msg));
        }
    }

    @SuppressWarnings("unchecked")
    private void positions(Context ctx) {
        if (!bridge.isConnected()) {
            ctx.status(503).json(Map.of("error", "Not connected to IB Gateway"));
            return;
        }

        int reqId = bridge.getNextReqId();
        bridge.initPositionAccumulator(reqId);
        CompletableFuture<List<Map<String, Object>>> future = bridge.createRequest(reqId);

        log.debug("Requesting positions (reqId={})", reqId);

        bridge.getClient().reqPositions();

        try {
            List<Map<String, Object>> positions = bridge.awaitRequest(future);
            ctx.json(positions);
        } catch (TimeoutException e) {
            bridge.getClient().cancelPositions();
            ctx.status(504).json(Map.of("error", "Positions request timed out"));
        } catch (Exception e) {
            String msg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            ctx.status(500).json(Map.of("error", msg));
        }
    }
}
