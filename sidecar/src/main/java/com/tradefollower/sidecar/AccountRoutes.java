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
 *
 * Account summary is served exclusively from the persistent reqAccountUpdates subscription
 * (started on connect). There is no one-shot reqAccountSummary fallback — TWS only allows
 * 2 concurrent reqAccountSummary subscriptions and leaked slots cause error 322.
 */
public class AccountRoutes {

    private static final Logger log = LoggerFactory.getLogger(AccountRoutes.class);

    private final TwsBridge bridge;

    public AccountRoutes(TwsBridge bridge) {
        this.bridge = bridge;
    }

    public void register(Javalin app) {
        app.get("/api/account/summary", this::summary);
        app.get("/api/positions", this::positions);
    }

    private void summary(Context ctx) {
        Map<String, String> subData = bridge.getAccountValues();
        if (!bridge.isAccountSubscriptionActive() || subData.isEmpty()) {
            ctx.status(503).json(Map.of("error", "Account data not ready — subscription still initializing"));
            return;
        }

        ctx.json(Map.of(
            "netLiquidation", parseDouble(subData, "NetLiquidation"),
            "availableFunds", parseDouble(subData, "AvailableFunds"),
            "maintenanceMargin", parseDouble(subData, "MaintMarginReq"),
            "unrealizedPnl", parseDouble(subData, "UnrealizedPnL"),
            "cushion", parseDouble(subData, "Cushion"),
            "sma", parseDouble(subData, "SMA-S"),
            "dayTradesRemaining", parseDouble(subData, "DayTradesRemaining"),
            "excessLiquidity", parseDouble(subData, "ExcessLiquidity-S")
        ));
    }

    private void positions(Context ctx) throws Exception {
        int reqId = bridge.getNextReqId();
        bridge.initPositionAccumulator(reqId);
        CompletableFuture<List<Map<String, Object>>> future = bridge.createRequest(reqId);

        log.debug("Requesting positions (reqId={})", reqId);

        bridge.getClient().reqPositions();

        try {
            List<Map<String, Object>> positions = bridge.awaitRequest(future);
            bridge.getClient().cancelPositions();

            // Enrich with marketValue/unrealizedPnl from portfolio subscription
            Map<Integer, Map<String, Object>> portfolio = bridge.getPortfolioPositions();
            for (Map<String, Object> pos : positions) {
                int conId = ((Number) pos.get("conId")).intValue();
                Map<String, Object> enrichment = portfolio.get(conId);
                if (enrichment != null) {
                    pos.put("marketValue", enrichment.get("marketValue"));
                    pos.put("unrealizedPnl", enrichment.get("unrealizedPnl"));
                }
            }

            ctx.json(positions);
        } catch (TimeoutException e) {
            bridge.getClient().cancelPositions();
            ctx.status(504).json(Map.of("error", "Positions request timed out"));
        }
        // Other exceptions propagate to global handler
    }

    private static double parseDouble(Map<String, String> map, String key) {
        String v = map.get(key);
        return v != null ? Double.parseDouble(v) : 0.0;
    }
}
