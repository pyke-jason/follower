# Degraded-State Noise Reduction

## Problem

When the IB Gateway login popup blocks the API handshake, or when the OneOption page hasn't joined a chat room, the system was correct but extremely noisy:

- Sidecar reconnect retried every 5s forever; each attempt logged 502 ERROR + "Connection closed" WARN.
- The orchestrator killed and respawned the sidecar every 30s when `connected:false`, resetting the in-process backoff counter.
- Reconciliation regenerated the same BROKER_ONLY alerts every 5 min cycle even after the user resolved them with `decision: "broker"`.
- The ingestion browser-restart cycle fired one CRITICAL Discord alert every 30s while waiting for the user to join a chat room.
- Page-evaluate failures during browser-close races surfaced as WARNING alerts.
- `serveStatic({ root: 'web/dist' })` warned three times per request when the SPA hadn't been built.
- Default DB URL was hard-coded to `postgres://jason@…`, silently breaking `npm test` and `npm run up` for anyone whose macOS user wasn't the original developer.

## Decision

Throttle/dedupe alerts and reconcile alerts at the data layer; gate orch restarts on the actual failure mode (process-dead, not gateway-down); fix code paths that hung silently because they relied on callbacks the IBKR client doesn't always emit.

## Key Files

- `src/reconciliation/reconciler.ts` — dedupe new BROKER_ONLY alerts against resolved (symbol, brokerQuantity) pairs.
- `src/reconciliation/scheduler.ts` — 15-min cooldown on "Reconciliation failed" alert; reset on success.
- `src/ingestion/ingest.ts` — exponential backoff (30s→10m) on subscription-degraded restart cycle; 5-min cooldown on `Chat room subscription degraded` and `Browser closed` alerts; race-suppression for `Target page closed` / `Browser not launched` errors during normal browser restarts.
- `src/ingestion/browser.ts` — same race-suppression in the auth-monitor catch.
- `sidecar/src/main/java/com/tradefollower/sidecar/TwsBridge.java` — exponential backoff (5s→60s) for reconnect attempts; **handshake watchdog** (20s) that calls `eDisconnect` AND `scheduleReconnect()` directly, since the IBKR client does not always emit `connectionClosed` after a stalled handshake; `AtomicLong connectGeneration` guard so a stale watchdog can't kill a newer connect attempt.
- `scripts/dev-up.ts` — split sidecar health into `isSidecarConnected()` vs `isSidecarProcessAlive()`. The orchestrator now only respawns the sidecar process when its HTTP is unreachable, never on `connected:false` (which is a transient gateway-side condition the sidecar's own backoff handles).
- `src/local-api/server.ts` — gate `serveStatic` mounts on `existsSync('web/dist')`.
- `src/db/client.ts`, `drizzle.config.ts`, `src/test/pg-test-client.ts` — default DB URL uses `process.env.USER` instead of hard-coded `jason`.
- `src/lib/secrets/keychain-provider.ts` — demote "N keys not found" log from `warn` to `log` (most are optional).
- `src/reconciliation/scheduler.ts` (additional) — pre-flight `broker.isHealthy()` check skips the cycle when the broker is unreachable, avoiding ~10 retry warnings per 5-min tick (5× `getPositions` + 5× `getAccountBalance`).
- `scripts/dev-up.ts` (additional) — orchestrator's "Sidecar alive but not connected" status log throttled to 5-min cadence (was 30s).
- `src/ingestion/browser.ts` (additional) — `checkAuth` only logs `[Browser] Authenticated` / `[Browser] Not authenticated` on a state transition, using the module-level `authState`. The 30s auth-monitor tick was previously emitting one of these every cycle (~36 lines per 40 min).
- `src/lib/log-rotation.ts` — lazy file open. Streams are only created on first write so that any process which transitively imports the logger (e.g. the api via `routes/trades.ts → record-trade.ts`) doesn't materialize a 0-byte `<prefix>-YYYY-MM-DD.log` it never writes to.

## Watch Out

- The IBKR Java client (`com.ib.client.EClientSocket`) does not reliably emit `connectionClosed` when error 502 is fired during the handshake. Any reconnect logic that waits for that callback will hang. Always pair an `eDisconnect()` from a watchdog with an explicit `scheduleReconnect()` call.
- The orchestrator's sidecar-restart logic must not key on `connected:false`. The sidecar can be alive and healthy yet not connected to the gateway (popup, maintenance window, gateway restart). Tearing it down resets all in-process state including the backoff counter and any pending request futures.
- `BROKER_ONLY` reconciliation is "user has acknowledged broker positions we don't track". The user's standing rule is **broker is source of truth**, so once resolved with `decision: "broker"` for a given (symbol, quantity), the reconciler suppresses re-alerts. New positions or quantity changes still alert because the dedupe key includes the broker quantity.
- Browser-lifecycle races (`Target page closed`, `Browser not launched`, `Target closed`) are routine during the recovery cycle; treat them as informational, not as alertable failures.
- Default DB URL fallbacks should always derive from `process.env.USER` rather than hard-coding a name; otherwise downstream tests and migrations silently fail with `role "X" does not exist` for anyone but the original author.
- Periodic schedulers (`ReconciliationScheduler`, `FillSweep`, similar) should pre-flight broker health and skip the cycle when the backing service is unreachable. `getPositions`/`getAccountBalance` etc. retry 5× internally; without the gate, a single tick burns 10+ retries while the operator already knows the broker is down.
- `pino` writes through file streams that were previously eager-opened. If a process imports the logger transitively but never writes (e.g. only uses `console.log`), it would still create an empty rolled file every UTC midnight. Keep stream creation lazy.
