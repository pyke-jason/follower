package com.tradefollower.sidecar;

import com.ib.client.Contract;
import io.javalin.Javalin;
import io.javalin.http.Context;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;

/**
 * POST /api/market-data/snapshot — request a snapshot quote.
 * Takes symbol+secType or conId. Returns bid/ask/last/volume.
 */
public class MarketDataRoutes {

    private static final Logger log = LoggerFactory.getLogger(MarketDataRoutes.class);

    private final TwsBridge bridge;

    public MarketDataRoutes(TwsBridge bridge) {
        this.bridge = bridge;
    }

    public void register(Javalin app) {
        app.post("/api/market-data/snapshot", this::snapshot);
    }

    @SuppressWarnings("unchecked")
    private void snapshot(Context ctx) {
        if (!bridge.isConnected()) {
            ctx.status(503).json(Map.of("error", "Not connected to IB Gateway"));
            return;
        }

        Map<String, Object> body = ctx.bodyAsClass(Map.class);

        Contract contract = new Contract();

        if (body.containsKey("conId")) {
            contract.conid(((Number) body.get("conId")).intValue());
            contract.exchange("SMART");
        } else {
            contract.symbol((String) body.getOrDefault("symbol", ""));
            contract.secType((String) body.getOrDefault("secType", "STK"));
            contract.exchange((String) body.getOrDefault("exchange", "SMART"));
            contract.currency((String) body.getOrDefault("currency", "USD"));

            if (body.containsKey("expiry")) {
                contract.lastTradeDateOrContractMonth((String) body.get("expiry"));
            }
            if (body.containsKey("strike")) {
                contract.strike(((Number) body.get("strike")).doubleValue());
            }
            if (body.containsKey("right")) {
                contract.right((String) body.get("right"));
            }
        }

        int reqId = bridge.getNextReqId();
        bridge.initTickAccumulator(reqId);
        CompletableFuture<Map<String, Object>> future = bridge.createRequest(reqId);

        log.debug("Requesting market data snapshot (reqId={})", reqId);

        // Request snapshot (empty genericTickList, snapshot=true)
        bridge.getClient().reqMktData(reqId, contract, "", true, false, null);

        try {
            Map<String, Object> result = bridge.awaitRequest(future);
            ctx.json(result);
        } catch (TimeoutException e) {
            bridge.getClient().cancelMktData(reqId);
            ctx.status(504).json(Map.of("error", "Market data snapshot timed out"));
        } catch (Exception e) {
            String msg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            ctx.status(500).json(Map.of("error", msg));
        }
    }
}
