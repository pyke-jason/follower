# Live Failure Mode Audit — 2026-04-24

Pre-live exhaustive audit of failure paths, detection times, and recovery correctness.

---

## A. External Dependency Failures

### A1. Sidecar process crash

**Detection:** NOT fast. Node client uses HTTP fetch with 10s read timeout and 5 retries → ~50s before circuit breaker registers the crash as consecutive failures and opens (~3 failures = circuit open, 30s probe interval). Total worst case: ~2m before task submissions stop.

**Recovery path:** Manual restart only. No supervisor or watchdog exists for the Java sidecar process. On restart: sidecar reconnects to IB Gateway automatically via `TwsBridge.scheduleReconnect()` (5s delay, then `eConnect`).

**Alert:** Circuit breaker opens after 3 consecutive failures → WARNING alert. 10+ failures → CRITICAL. No explicit "sidecar process dead" alert — only implicit via circuit breaker.

**Does bot stop placing orders?** YES — circuit breaker gates task claims. Tasks are re-submitted with 10s delay while circuit is open.

**Severity if missing/bad:** HIGH — 2-minute blind window before protection kicks in. No auto-restart.

**Fix applied:** None. Recommend: run sidecar under PM2 or systemd with auto-restart.

**Recommended PM2 command:**
```
pm2 start "java -jar sidecar/build/libs/sidecar-*.jar" --name sidecar --restart-delay 2000
```

---

### A2. IB Gateway / IBC restart (primaryoverride)

**Detection:** TwsBridge heartbeat fires every 30s. If no response within 40s → declares connection dead.

**Recovery path:** `declareConnectionDead()` broadcasts `disconnected` to WS clients, fails pending requests, calls `scheduleReconnect()` (5s). `connect()` calls `eConnect()`. With `primaryoverride=yes` in IBC config, the new session takes precedence. Reconnect has no exponential backoff (always 5s retry). During 00:15–01:45 ET maintenance window, reconnects defer 60s.

**Bot survives disconnection?** YES — circuit breaker opens when sidecar signals unhealthy, re-closes when healthy probe succeeds. In-flight task times out via the new 120s task timeout.

**Severity:** LOW — path is well-handled; `primaryoverride` ensures re-entry.

---

### A3. IBKR API disconnect (bot ↔ gateway)

**Detection:** Sidecar heartbeat (30s interval, 40s timeout). Total detection: up to 70s.

**Recovery:** Sidecar auto-reconnects (5s delay). Node side: reads have 5 retries with 200ms–15s backoff; writes have 2 retries with 500ms–15s backoff.

**Orders during disconnect?** Writes fail with transient error after 2 retries → task FAILED → circuit breaker records failure. Bot does NOT place orders during disconnect.

**Severity:** LOW — handled.

---

### A4. Database lock / connection failure

**Detection:** Immediate — Postgres write throws on first failure. No pre-flight DB health check before order placement.

**Critical gap — verified in code:**
- `placeOrder()` → `orderManager.submitOrder()` → order submitted to IBKR
- Then `recordFill()` is called. If DB is down at that moment, the fill is orphaned.
- **Fixed:** `build-order-callbacks.ts:68-74` now wraps `recordFill()` in try/catch → writes to `orphan_fills` and sends CRITICAL alert.

**Does bot stop placing orders if DB is down?** No pre-flight check. A DB failure during order placement now triggers the orphan path. For new orders after a DB failure is detected, the `handleTaskError` flow will fail the task and circuit breaker will record it — but this is indirect protection. Consider adding an explicit DB health check.

**withDbRetry:** Exists (`src/db/client.ts`) with 3 attempts + exponential backoff for serialization/deadlock errors (codes 40001, 40P01, 55P03), but is opt-in (not wrapping all operations).

**Severity:** HIGH — partially fixed. Full pre-flight DB gate is a future improvement.

---

### A5. Network partition

**Detection:** Per-channel independent watchers:
- Sidecar: circuit breaker opens after 3 connection failures (~30–90s)
- Databento: AbortSignal timeout 30s, 3 retries → DependencyUnavailableError
- Chat/SignalR: message watchdog → WARNING at 5 min silence, force restart at 10 min

**Recovery:** All three auto-recover on network return. No "all systems down" aggregate alarm.

**Severity:** MEDIUM — no aggregate partition alarm. Individual channel watchers are solid.

---

### A6. Databento / market data feed failure

**422 errors:** Symbol is blacklisted in `deadSymbols` for the run. Signals for that symbol emit FAIL with `marketDataFail` flag. Execution continues for other symbols.

**Full outage:** 3 retries with exponential backoff → `DependencyUnavailableError`. Signal emits FAIL; bot does NOT block — it skips that trade and continues.

**Can bot trade without market data?** For CLOSE orders: yes (uses `getMidpoint` from broker). For OPEN orders: no — quote is required for sizing. Fails gracefully, does not crash.

**Severity:** LOW — handled correctly. No fallback data source (by design).

---

### A7. LLM provider outage

**Live mode — no timeout (FIXED):**
- Previously: `processTaskShared()` in `runner.ts:handleTask` had no timeout. A hung provider call blocked all signals indefinitely.
- **Fixed:** `runner.ts` now wraps `processTaskShared()` in `Promise.race([..., timeoutPromise])` with `TASK_TIMEOUT_MS = 120_000`. Timeout fires → task FAILED → circuit breaker records failure.

**Retry behavior:** Backtest agent has 3 retries with 1–30s backoff. Live path calls `AnthropicAgent.run()` directly with no retry wrapper. The 120s timeout covers 1 SDK-level attempt.

**Rate-limit (429):** Classified as `transient` → retried with backoff.

**Severity:** CRITICAL → FIXED. Without the timeout, a single hung LLM call could stall all trading for the session.

---

### A8. Disk full / log rotation failure

**Log rotation:** Daily rolling files via `src/lib/log-rotation.ts`. Date-based only (no size limit).

**Disk full behavior:** Stream write errors are emitted to `stderr` and logged, but do NOT crash the bot. Subsequent writes stall silently (backpressure). No alert is sent.

**No ENOSPC detection or alert.** No log archival/cleanup job.

**Severity:** MEDIUM — silent failure. Recommend `logrotate` config or periodic disk-space alert.

---

### A9. Time skew

**No clock validation.** System timestamps are used directly for `placedAt` in trade records. IBKR order submission uses server-side timestamps in the sidecar — local clock drift doesn't cause order rejection.

**Risk:** Minimal for IBKR (sidecar owns timestamps). Could cause confusion in DB `placedAt` timestamps if clock jumps, but no trading impact.

**Severity:** LOW.

---

## B. Internal Failure Modes

### B1. Bot process kill -9

**On restart:**
1. Startup maintenance (`src/db/startup-maintenance.ts`) cleans FK orphans.
2. All IN_PROGRESS tasks → EXPIRED ("stale: interrupted by restart"). System alert sent.
3. All PENDING tasks older than 60s → EXPIRED.
4. Reconciliation (every 5 min) queries IBKR positions, creates DB_ONLY alerts for any position at broker not in DB. Blocks new trades until resolved.

**In-flight order at IBKR?** If killed after `submitOrder()` but before `recordFill()`:
- Task marked EXPIRED on restart (no reprocessing).
- If order fills later, `onFill` callback fires with no matching `pendingIntent` → **orphan fill handler** creates `orphan_fills` row and sends CRITICAL alert.
- Operator must manually reconcile.

**Verdict:** RECOVERS cleanly. Orphan detection is solid post-fix.

---

### B2. OOM / memory leak

**OrderManager:** Clean — `workingOrders` entries deleted on fill/cancel/reject.

**IBKR client Sets (FIXED):**
- `creditComboOrderIds`: entries added on place, deleted on cancel but NOT on fill. Capped at 2000 entries (evicts oldest on overflow).
- `alertedMissingSubscription`: capped at 500 entries.

**Unbounded DB tables:** `messages`, `trade_events`, `run_decisions`, `historicalFetchRuns`, `runtimeHealth` — no TTL or archival. Long-running system will accumulate GBs over months. Not critical day-1 but worth scheduling a cleanup job.

**Severity:** LOW post-fix.

---

### B3. Infinite loop / deadlock

**No `while(true)` found in src/.** Supervision loops use `while (shouldRun)` with clean exit. `drainQueue` exits naturally when queue is empty. All `setInterval` handles cleared on shutdown. No deadlock risk identified.

**Severity:** LOW.

---

### B4. Stack overflow on recursion

No recursive parsers found. Parsing is iterative.

**Severity:** NONE.

---

### B5. Promise rejection swallowed

**Global handler:** `process.on('unhandledRejection')` in `src/lib/log-safety.ts` — logs + exits with code 1. All unhandled rejections crash the process.

**Fire-and-forget patterns found:**
- `checkExpiryWarnings().catch(() => {})` in `runner.ts` — **fixed** to `.catch(err => log.error(...))`.
- Browser cleanup: `closeBrowser().catch(() => {})` — intentional, safe.
- `orphanFills` insert in `build-order-callbacks.ts` — double-guarded (outer catch logs even if inner insert fails).

**Severity:** LOW post-fix.

---

## C. Recovery Validation Matrix

| Failure | Detect within | Stops orders? | Alert? | Resumes cleanly? | State reconciled? |
|---------|--------------|---------------|--------|-----------------|-------------------|
| Sidecar crash | ~50–120s (circuit breaker) | YES (circuit open) | WARNING/CRITICAL | YES (manual restart) | YES (fill sweep) |
| IB Gateway restart | 30–70s (heartbeat) | YES (circuit) | WARNING | YES (auto-reconnect) | YES |
| IBKR API disconnect | 30–70s | YES | WARNING | YES | YES |
| DB failure mid-fill | Immediate (exception) | Not directly gated | CRITICAL (orphan alert) | YES (after DB recover) | Manual via orphan_fills |
| Network partition | 30–600s per channel | YES (per-channel) | WARNING/CRITICAL | YES (auto) | YES |
| Databento outage | 30s + 3 retries | NO (skips trade) | Via circuit breaker | YES | N/A (trade skipped) |
| LLM hang | 120s (FIXED) | YES (task timeout) | Via circuit breaker | YES | YES (task EXPIRED) |
| SIGKILL | On restart | YES (no new tasks until expiry sweep) | WARNING (stale tasks) | YES | YES (reconciliation) |
| Disk full | None (silent) | NO | NO | NO (logs lost) | N/A |

---

## D. Specific Scenarios

### D1. SIGKILL mid-order-placement. Restart. In-flight order?

- Order submitted to IBKR, `recordFill` not yet called.
- Task row: IN_PROGRESS → EXPIRED on restart.
- If order fills while bot is down: `onFill` fires on reconnect → no `pendingIntent` → orphan fill handler → CRITICAL alert + `orphan_fills` row.
- If order never fills and cancels: sidecar cancel propagates on reconnect → orphan cancel handler → WARNING alert.
- **Verdict:** Position is detected within one reconciliation cycle (5 min). Operator alerted. No zombie trades silently accumulating.

### D2. SIGKILL between "decided to trade" and "submitted to IBKR"

- Task: IN_PROGRESS → EXPIRED.
- Message: already stored in DB. A NEW message from the same chat event would create a new task if the chat room re-sends it, but the original message is NOT reprocessed.
- **At-most-once semantics** — the trade is missed, not doubled. Safer than at-least-once for a trading system.
- **Verdict:** Signal is missed. No duplicate order.

### D3. SIGKILL mid-reconciliation. Restart.

- Reconciliation is idempotent: alert deduplication via `existingUnresolved` set; fill enrichment uses `runTx` and overwrites same data.
- On restart, reconciler runs fresh and re-derives state from IBKR positions + DB.
- **Verdict:** Safe to interrupt. No data corruption.

### D4. IBKR "order rejected: insufficient buying power" (code 201)

- Classified as `permanent` in `ibkrClassify()` — NOT retried.
- `executeResolvedSignal` returns `{ executed: false, reason: 'Order rejected' }`.
- Task completes successfully (SETTLED with outcome FAIL).
- **No alert sent. No cascade protection.** If 5 signals arrive and all get 201, each silently fails.
- **Severity:** MEDIUM. Recommend: alert on first 201 rejection; alert CRITICAL if 3+ rejections in the same task.

### D5. IBKR "order rejected: invalid contract" (code 200/422)

- Classified as `permanent`. Not retried.
- `QuoteResolutionError` triggers LLM re-parse (one retry). If still invalid, FAIL with `marketDataFail` flag.
- **Verdict:** One automatic retry via LLM. Handled.

### D6. Multiple rejections in quick succession (margin call cascade)

- Each signal processed independently. No shared rejection counter across signals or tasks.
- Broker health check (`isHealthy()`) only checks TCP/WebSocket connectivity, not rejection rate.
- Circuit breaker only opens on broker connectivity failures, not on order rejections.
- **Verdict:** Bot keeps trying. Up to N signals per message × M messages = unbounded rejection flood. No kill.
- **Severity:** HIGH — no cascade breaker on buying power exhaustion.

---

## E. Kill Switch

### Command

```bash
# Immediate halt — all future placeOrder() calls return REJECTED instantly
curl -X POST http://localhost:3791/settings/toggles/orders \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'

# Or set env var (requires process restart):
LIVE_ORDERS_ENABLED=0

# Re-enable:
curl -X POST http://localhost:3791/settings/toggles/orders \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'
```

### How it works

`LIVE_ORDERS_ENABLED` is checked at the top of `placeOrder()` in `execute-resolved.ts`. If `=== '0'`:
- Returns `{ status: 'REJECTED', message: 'Order placement halted (LIVE_ORDERS_ENABLED=0)' }`
- No broker call is made.
- Signal is marked `executed: false` — task completes normally (no crash, no circuit breaker hit).
- Ingestion continues so no messages are missed.

### Verification

Toggle `orders` to `false` → send a test message → check task row: `status=COMPLETED`, signal settled with `outcome=FAIL`, `reason='Order placement halted'`. No order in IBKR.

---

## Implemented Fixes (this worktree)

| Fix | File | Severity |
|-----|------|----------|
| 120s task timeout in live runner | `src/live/runner.ts` | CRITICAL |
| Kill switch: LIVE_ORDERS_ENABLED | `src/local-api/routes/web-mutations.ts`, `src/pipeline/execute-resolved.ts` | CRITICAL |
| recordFill DB failure → orphan alert | `src/orders/build-order-callbacks.ts` | HIGH |
| Cap unbounded Sets (credit combos, subscription alerts) | `src/broker/ibkr/client.ts` | LOW |
| Log swallowed expiry warning errors | `src/live/runner.ts` | LOW |

---

## Remaining Recommendations (not implemented — follow-up)

1. **Sidecar supervisor (day-1 priority):** Run sidecar under PM2 with `--restart-delay 2000`. Without this, a sidecar crash requires manual intervention within the ~2-minute blind window.

2. **Rejection cascade alert:** When `executeResolvedSignals` sees 3+ REJECTED outcomes in one task, send a CRITICAL alert. Buying power exhaustion should not be silent.

3. **DB pre-flight health check before order placement:** Check DB connectivity before calling `submitOrder`. If DB is unreachable, skip execution and circuit-break. This eliminates the remaining window where an order could be placed without DB tracking.

4. **Disk space monitor:** Add a periodic check (e.g., `df -h` in healthcheck) that alerts at 80% disk usage. Log rotation is date-based only — no size protection.

5. **DB table archival:** Schedule monthly archival/delete for `messages`, `trade_events`, `run_decisions` rows older than 90 days. Tables grow unbounded.

6. **LLM retry wrapper in live path:** The live path calls `AnthropicAgent.run()` directly without the 3-retry wrapper used in backtest. If the LLM returns a transient error, the task fails immediately. Consider applying `LLM_DEFAULTS` retry logic to the live path.
