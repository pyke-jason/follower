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

    private void resolve(Context ctx) throws Exception {
        var body = ctx.bodyAsClass(RequestBodies.ResolveContractBody.class);

        Contract contract = new Contract();
        contract.symbol(body.symbolOrDefault());
        contract.secType(body.secTypeOrDefault());
        contract.exchange(body.exchangeOrDefault());
        contract.currency(body.currencyOrDefault());

        if (body.expiry() != null) contract.lastTradeDateOrContractMonth(body.expiry());
        if (body.strike() != null) contract.strike(body.strike());
        if (body.right() != null) contract.right(body.right());

        int reqId = bridge.getNextReqId();
        CompletableFuture<Map<String, Object>> future = bridge.createRequest(reqId);

        log.debug("Resolving contract: {} {} strike={} right={} (reqId={})",
                contract.symbol(), contract.secType(), contract.strike(), contract.right(), reqId);

        bridge.getClient().reqContractDetails(reqId, contract);

        try {
            ctx.json(bridge.awaitRequest(future));
        } catch (TimeoutException e) {
            ctx.status(504).json(Map.of("error", "Contract resolution timed out"));
        }
        // TwsException (including "No contract found") propagates to global handler → 422/400/500
    }
}
