package com.tradefollower.sidecar;

import io.javalin.http.Context;
import io.javalin.http.HandlerType;

import java.time.Duration;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Map;
import java.util.Set;

public class Guards {
    private static final ZoneId ET = ZoneId.of("America/New_York");

    /** Paths that serve local-only state (no TWS call). */
    private static final Set<String> LOCAL_READ_PATHS = Set.of("/api/status");

    /** GET on these prefixes reads from in-memory maps only. */
    private static final Set<String> LOCAL_READ_GET_PREFIXES = Set.of("/api/orders/");

    private Guards() {}

    /** Javalin before-filter. Blocks requests when sidecar is not ready. */
    public static void requireReady(Context ctx, TwsBridge bridge) {
        if (isLocalRead(ctx)) return;

        if (!bridge.isConnected()) {
            ctx.status(503).json(Map.of("error", "Not connected to IB Gateway"));
            ctx.skipRemainingHandlers();
            return;
        }

        if (bridge.isInMaintenanceWindow()) {
            ctx.status(503).json(Map.of(
                "error", "Maintenance window",
                "retryAfter", maintenanceRetrySeconds()
            ));
            ctx.skipRemainingHandlers();
        }
    }

    private static boolean isLocalRead(Context ctx) {
        if (LOCAL_READ_PATHS.contains(ctx.path())) return true;
        if (ctx.method() == HandlerType.GET) {
            for (String prefix : LOCAL_READ_GET_PREFIXES) {
                if (ctx.path().startsWith(prefix)) return true;
            }
        }
        return false;
    }

    private static int maintenanceRetrySeconds() {
        ZonedDateTime now = ZonedDateTime.now(ET);
        ZonedDateTime endMaint = now.withHour(1).withMinute(45).withSecond(0);
        if (now.isAfter(endMaint)) endMaint = endMaint.plusDays(1);
        return (int) Duration.between(now, endMaint).getSeconds();
    }
}
