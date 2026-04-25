package com.tradefollower.sidecar;

import io.javalin.Javalin;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * IBKR sidecar — pure protocol translator between REST/WebSocket and TWS API.
 * Runs on localhost:8090. No business logic.
 */
public class App {

    private static final Logger log = LoggerFactory.getLogger(App.class);
    private static final int DEFAULT_PORT = 8090;
    private static final long HEALTHCHECK_INTERVAL_SECS = 60;

    public static void main(String[] args) {
        int port = Integer.parseInt(System.getenv().getOrDefault("SIDECAR_PORT", String.valueOf(DEFAULT_PORT)));

        WsHandler wsHandler = new WsHandler();
        TwsBridge bridge = new TwsBridge(wsHandler);

        Javalin app = Javalin.create(config -> {
            config.showJavalinBanner = false;
            config.http.defaultContentType = "application/json";
        });

        // WebSocket endpoint for event broadcasting
        app.ws("/events", wsHandler);

        // Health endpoint
        app.get("/api/status", ctx -> ctx.json(Map.of(
                "connected", bridge.isConnected(),
                "accountId", bridge.getAccountId() != null ? bridge.getAccountId() : "",
                "serverVersion", bridge.getServerVersion(),
                "wsClients", wsHandler.getClientCount(),
                "maintenance", bridge.isInMaintenanceWindow(),
                "lastHeartbeat", bridge.getLastHeartbeatResponse()
        )));

        app.before("/api/*", ctx -> Guards.requireReady(ctx, bridge));

        // Global error handlers
        app.exception(com.fasterxml.jackson.core.JsonParseException.class, (e, ctx) ->
                ctx.status(400).json(Map.of("error", "Invalid JSON body")));
        app.exception(com.fasterxml.jackson.databind.JsonMappingException.class, (e, ctx) -> {
            String detail = e.getOriginalMessage();
            ctx.status(400).json(Map.of("error", detail != null ? detail : "Invalid request body"));
        });

        // TwsException thrown directly (defensive)
        app.exception(TwsException.class, (e, ctx) -> {
            int status = twsStatus(e);
            ctx.status(status).json(Map.of("error", e.getMessage(), "twsCode", e.getErrorCode()));
        });

        // ExecutionException wrapping TwsException (from CompletableFuture.get())
        app.exception(java.util.concurrent.ExecutionException.class, (e, ctx) -> {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            if (cause instanceof TwsException twsErr) {
                ctx.status(twsStatus(twsErr)).json(Map.of("error", twsErr.getMessage(), "twsCode", twsErr.getErrorCode()));
            } else {
                String msg = cause.getMessage();
                ctx.status(500).json(Map.of("error", msg != null ? msg : "Internal error"));
            }
        });

        // Register route groups
        new ContractRoutes(bridge).register(app);
        new MarketDataRoutes(bridge).register(app);
        new OrderRoutes(bridge).register(app);
        new AccountRoutes(bridge).register(app);

        // Sidecar healthcheck — proves the Java process is alive
        ScheduledExecutorService healthcheckExecutor = startHealthcheckPing(bridge);

        // Graceful shutdown
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            log.info("Shutting down sidecar...");
            healthcheckExecutor.shutdownNow();
            bridge.disconnect();
            app.stop();
        }));

        app.start(port);
        log.info("IBKR sidecar started on port {}", port);

        // Connect to IB Gateway
        try {
            bridge.connect();
        } catch (Exception e) {
            log.error("Failed to connect to IB Gateway: {}", e.getMessage());
            log.info("Sidecar running — will retry connection when Gateway becomes available");
        }
    }

    /**
     * Map a TwsException to the HTTP status the route should return.
     * 402 signals a missing live market-data subscription — permanent, needs human action.
     */
    private static int twsStatus(TwsException e) {
        if (e.isNoMarketData()) return 402;
        if (e.isNoSecurityDef()) return 422;
        if (e.isValidationError()) return 400;
        return 500;
    }

    /**
     * Ping healthchecks.io every 60s from the Java process.
     * Appends /fail when not connected to IB Gateway.
     * Silent no-op if HEALTHCHECK_PING_URL is not set.
     */
    private static ScheduledExecutorService startHealthcheckPing(TwsBridge bridge) {
        ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "healthcheck-ping");
            t.setDaemon(true);
            return t;
        });

        if ("0".equals(System.getenv("HEALTHCHECK_ENABLED"))) {
            return executor;
        }

        String url = System.getenv("HEALTHCHECK_PING_URL");
        if (url == null || url.isBlank()) {
            return executor;
        }

        // Paper trading (port 4002) — skip healthcheck pings
        // IBKR_GATEWAY_PORT is required — TwsBridge throws at startup if absent.
        // Using getenv() here (no default) so a missing var disables pings rather than activating live.
        String gwPort = System.getenv("IBKR_GATEWAY_PORT");
        if ("4002".equals(gwPort)) {
            log.info("Paper trading detected (port 4002) — healthcheck pings disabled");
            return executor;
        }

        HttpClient httpClient = HttpClient.newHttpClient();
        executor.scheduleAtFixedRate(() -> {
            try {
                String pingUrl = bridge.isConnected() ? url : url + "/fail";
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(pingUrl))
                        .GET()
                        .build();
                httpClient.send(req, HttpResponse.BodyHandlers.discarding());
            } catch (Exception e) {
                log.debug("Healthcheck ping failed: {}", e.getMessage());
            }
        }, 0, HEALTHCHECK_INTERVAL_SECS, TimeUnit.SECONDS);

        log.info("Healthcheck ping started (interval={}s)", HEALTHCHECK_INTERVAL_SECS);
        return executor;
    }
}
