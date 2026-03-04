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

    private void snapshot(Context ctx) throws Exception {
        var body = ctx.bodyAsClass(RequestBodies.SnapshotBody.class);

        Contract contract = new Contract();

        if (body.conId() != null) {
            contract.conid(body.conId());
            contract.secType(body.secTypeOrDefault(""));
            contract.exchange("SMART");
            contract.currency("USD");
        } else {
            contract.symbol(body.symbolOrDefault());
            contract.secType(body.secTypeOrDefault("STK"));
            contract.exchange(body.exchangeOrDefault());
            contract.currency(body.currencyOrDefault());

            if (body.expiry() != null) contract.lastTradeDateOrContractMonth(body.expiry());
            if (body.strike() != null) contract.strike(body.strike());
            if (body.right() != null) contract.right(body.right());
        }

        int reqId = bridge.getNextReqId();
        bridge.initTickAccumulator(reqId);
        CompletableFuture<Map<String, Object>> future = bridge.createRequest(reqId);

        log.debug("Requesting market data snapshot (reqId={})", reqId);

        // Request snapshot (empty genericTickList, snapshot=true)
        bridge.getClient().reqMktData(reqId, contract, "", true, false, null);

        try {
            ctx.json(bridge.awaitRequest(future));
        } catch (TimeoutException e) {
            bridge.getClient().cancelMktData(reqId);
            ctx.status(504).json(Map.of("error", "Market data snapshot timed out"));
        }
        // Other exceptions (TwsException, etc.) propagate to global handler
    }
}
