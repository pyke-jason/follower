package com.tradefollower.sidecar;

import io.javalin.Javalin;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;

/**
 * IBKR sidecar — pure protocol translator between REST/WebSocket and TWS API.
 * Runs on localhost:8090. No business logic.
 */
public class App {

    private static final Logger log = LoggerFactory.getLogger(App.class);
    private static final int DEFAULT_PORT = 8090;

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
                "maintenance", bridge.isInMaintenanceWindow()
        )));

        // Register route groups
        new ContractRoutes(bridge).register(app);
        new MarketDataRoutes(bridge).register(app);
        new OrderRoutes(bridge).register(app);
        new AccountRoutes(bridge).register(app);

        // Graceful shutdown
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            log.info("Shutting down sidecar...");
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
}
