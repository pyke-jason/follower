package com.tradefollower.sidecar;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.websocket.WsConfig;
import io.javalin.websocket.WsContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * WebSocket handler for broadcasting sidecar events to connected clients.
 * Events: connected, disconnected, reconnected, orderStatus, error.
 */
public class WsHandler implements Consumer<WsConfig> {

    private static final Logger log = LoggerFactory.getLogger(WsHandler.class);
    private static final ObjectMapper mapper = new ObjectMapper();

    private final Set<WsContext> sessions = ConcurrentHashMap.newKeySet();

    @Override
    public void accept(WsConfig ws) {
        ws.onConnect(ctx -> {
            ctx.session.setIdleTimeout(Duration.ofHours(1));
            sessions.add(ctx);
            log.info("WebSocket client connected (total: {})", sessions.size());
        });
        ws.onClose(ctx -> {
            sessions.remove(ctx);
            log.info("WebSocket client disconnected (total: {})", sessions.size());
        });
        ws.onError(ctx -> {
            sessions.remove(ctx);
            log.warn("WebSocket error, removing client (total: {})", sessions.size());
        });
    }

    public void broadcast(Map<String, Object> event) {
        if (sessions.isEmpty()) return;
        try {
            String json = mapper.writeValueAsString(event);
            for (WsContext ctx : sessions) {
                try {
                    ctx.send(json);
                } catch (Exception e) {
                    log.debug("Failed to send to WS client, removing: {}", e.getMessage());
                    sessions.remove(ctx);
                }
            }
        } catch (Exception e) {
            log.error("Failed to serialize WS event", e);
        }
    }

    public void broadcastConnected() {
        broadcast(Map.of("type", "connected"));
    }

    public void broadcastDisconnected() {
        broadcast(Map.of("type", "disconnected"));
    }

    public void broadcastReconnected() {
        broadcast(Map.of("type", "reconnected"));
    }

    public void broadcastOrderStatus(int orderId, String status, double filled,
                                     double remaining, double avgFillPrice) {
        broadcast(Map.of(
                "type", "orderStatus",
                "orderId", orderId,
                "status", status,
                "filled", filled,
                "remaining", remaining,
                "avgFillPrice", avgFillPrice
        ));
    }

    public void broadcastError(int code, String message, int orderId) {
        if (orderId > 0) {
            broadcast(Map.of(
                    "type", "error",
                    "code", code,
                    "message", message,
                    "orderId", orderId
            ));
        } else {
            broadcast(Map.of(
                    "type", "error",
                    "code", code,
                    "message", message
            ));
        }
    }

    public void broadcastExecDetails(Map<String, Object> exec) {
        java.util.HashMap<String, Object> event = new java.util.HashMap<>(exec);
        event.put("type", "execDetails");
        broadcast(event);
    }

    public void broadcastCommission(String execId, double commission, int orderId) {
        broadcast(Map.of("type", "commission", "execId", execId,
                          "commission", commission, "orderId", orderId));
    }

    public int getClientCount() {
        return sessions.size();
    }
}
