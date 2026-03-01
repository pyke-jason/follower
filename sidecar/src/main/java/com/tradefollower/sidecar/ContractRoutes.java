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
 * POST /api/contracts/resolve — resolve contract details to get conId.
 * Takes symbol/secType/expiry/strike/right/exchange/currency.
 * Returns conId/localSymbol/multiplier/exchange.
 */
public class ContractRoutes {

    private static final Logger log = LoggerFactory.getLogger(ContractRoutes.class);

    private final TwsBridge bridge;

    public ContractRoutes(TwsBridge bridge) {
        this.bridge = bridge;
    }

    public void register(Javalin app) {
        app.post("/api/contracts/resolve", this::resolve);
    }

    private void resolve(Context ctx) {
        Map<String, Object> body = ctx.bodyAsClass(Map.class);

        Contract contract = new Contract();
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

        int reqId = bridge.getNextReqId();
        CompletableFuture<Map<String, Object>> future = bridge.createRequest(reqId);

        log.debug("Resolving contract: {} {} strike={} right={} (reqId={})",
                contract.symbol(), contract.secType(), contract.strike(), contract.right(), reqId);

        bridge.getClient().reqContractDetails(reqId, contract);

        try {
            Map<String, Object> result = bridge.awaitRequest(future);
            ctx.json(result);
        } catch (TimeoutException e) {
            ctx.status(504).json(Map.of("error", "Contract resolution timed out"));
        } catch (Exception e) {
            String msg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            if (msg != null && msg.contains("No contract found")) {
                ctx.status(422).json(Map.of("error", "No contract found", "detail", msg));
            } else {
                ctx.status(500).json(Map.of("error", msg));
            }
        }
    }
}
