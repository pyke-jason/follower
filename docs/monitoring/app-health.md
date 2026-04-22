# App Health — Living Monitor

Auto-updated by `/loop` every 5 min. Most recent snapshot at top; older snapshots trimmed to last 12 (~1h of history).

Refresh script: `scripts/monitor-health.sh` (read-only queries against `data/trade-follower.db` + `localhost:3791/health`).

---

## Ongoing incidents / findings

### 2026-04-21 — IBKR Gateway connection flapping (recurring, currently stable)

**Pattern observed:**
- 16:40:49Z → 16:55:32Z: circuit OPEN (~15 min), then auto-recovered
- 17:05:02Z → ~17:06:32Z: circuit OPEN (~1.5 min), auto-recovered (correlates with user logging into IBKR paper on phone — no session conflict)
- 17:11:32Z: circuit CLOSED, `broker_healthy=1`. Now stable.
- Discord + Pushover alerts ENABLED at 17:09Z — future flaps will ping.

**Channel:** `ibkr:paper:DUP246375`
**runtime_health:** `broker_healthy=0`, `circuit_open=1`, `last_error="Broker health check failed"`

**Interpretation:** This is no longer a one-off drop. The sidecar's upstream TWS socket is flapping, which strongly suggests IB Gateway itself is the source — likely auto-logout / daily restart / network instability on the Gateway side, NOT anything in our code. Sidecar process has been up continuously (pid 58815) across both outages.

**Impact:**
- EXECUTE_TRADE tasks cannot place orders while circuit is open; they re-submit every 10 s (`src/live/runner.ts:105-113`).
- If Gateway flaps while a task is mid-flight (post-parse, pre-order), we get the exact failure pattern documented in the SNPS incident below: broker quote retries exhaust with `"This operation was aborted"`.
- REVIEW_MESSAGE tasks are unaffected.

**Next steps to diagnose (not yet done):**
1. Check IB Gateway log for the two outage windows (16:40Z and 17:05Z) — look for `disconnect`, `reLogin`, or session-expiry entries.
2. Confirm Gateway auto-restart schedule — IBKR resets its servers nightly around 23:45–00:45 ET (03:45–04:45 UTC), NOT mid-afternoon, so this isn't the nightly reset.
3. Check sidecar logs (`sidecar/src/main/resources/logback.xml`) for `TwsBridge` reconnect attempts to correlate with the circuit open/close timing.

**Recovery path (manual, per outage):** Gateway typically reconnects on its own within a few minutes. If not: re-login in the Gateway desktop UI; sidecar will pick up the new session.

**Root cause:** The Java sidecar on `:8090` is still up (`pgrep -f tradefollower.sidecar` → pid 58815, 7-min etime at tick time), but `GET /api/status` returns `{"connected":false,"accountId":"","serverVersion":0,"lastHeartbeat":1776790239497}`. The sidecar has lost its TWS API socket to IB Gateway, so `isHealthy()` (`src/broker/ibkr/client.ts:473-484`) returns `false` (checks `connected && !maintenance`). The circuit breaker opened on consecutive failures.

**Impact:**
- EXECUTE_TRADE tasks are NOT expired — runner's gate at `src/live/runner.ts:105-113` re-submits them via `setTimeout(10_000)` and waits for the circuit to recover.
- REVIEW_MESSAGE tasks are unaffected (they don't touch the broker).
- Signal ingestion continues; nothing is dropped.

**Recovery path (manual):**
1. Check IB Gateway desktop app — likely logged out or disconnected. Re-login.
2. Sidecar will reconnect automatically once Gateway is back (persistent reconnect loop — see `TwsBridge.java`).
3. Next health probe (runs every 30 s per `live-tasks.md`) flips `broker_healthy=1`, `circuit_open=0`. Queued EXECUTE_TRADE tasks resume on next re-submit.

**Watch for:** Tasks reaching the 60 s stale threshold while the circuit is open — these get EXPIRED, not retried. If this incident lasts >1 min with pending tasks, expect EXPIRED rows to start appearing in the failure feed.

---

### 2026-04-21 — REVIEW_MESSAGE failed with "This operation was aborted" (xAI)

### 2026-04-21 — REVIEW_MESSAGE failed with "This operation was aborted" (xAI)

**Task:** `65f01f45-7738-46e8-b9b4-67a9f4666cff` — message 518724, Hariseldon, SNPS
**Text:** "I sold the $465 Puts on SNPS for $8.50 earlier - expiring Friday"
**Duration:** 76 s (started 14:51:49Z → failed 14:53:05Z)
**Model:** `xai` / `grok-4-1-fast-reasoning`

**Root cause (most likely):** undici `fetch` in the `ai` SDK emits the generic `AbortError: This operation was aborted` when the underlying socket is terminated mid-stream. xAI SSE stalls on reasoning-heavy prompts; after ~75 s the socket closed and the SDK surfaced it as an abort. No `abortSignal` is passed from our side (`src/agent/xai-agent.ts:56` — `generateText` call has no signal), so the abort did not originate in this codebase.

**Evidence ruling out local causes:**
- No `AbortController` or `AbortSignal.timeout` around `XAIAgent.run` (grep: `src/agent/**`).
- Runner does not cancel in-flight tasks — `handleTask` only catches rejections (`src/live/runner.ts:126-157`).
- Task was not stale: 76 s < 60 s stale-threshold check fires at enqueue, not during execution.

**Watch for:**
- Repeats on long reasoning prompts for the same trader/symbol pattern.
- Circuit breaker state — currently `brokerHealthy=1`, `circuit_open=0`.

**Possible mitigations (not yet applied):**
- Pass an explicit `abortSignal: AbortSignal.timeout(60_000)` in `XAIAgent.run` so the error surfaces as a clean timeout with context rather than the bare "aborted" string.
- Add per-task retry for transient xAI 5xx / abort errors in `handleTask` — currently none.

---

## Snapshots

<!-- SNAPSHOTS_BEGIN -->

## Snapshot 2026-04-21T17:30:49Z

- Backend: UP (pid=96561, uptime=05:39, rss=44MB)
- Local API /health: {"ok":true}

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error  updated_at              
--------------------  --------------  ------------  ----------  ------------------------
ibkr:paper:DUP246375  1               0                         2026-04-21T17:30:41.578Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T17:26:05Z — backend restarted

- Backend: UP (pid=96561, uptime=00:55, rss=66MB) — new pid (was 41749, uptime 02:38:50 at 17:21Z). Backend restarted between ticks.
- Local API /health: {"ok":true}
- Circuit stable: `broker_healthy=1`, `circuit_open=0`. No new failures.

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error  updated_at              
--------------------  --------------  ------------  ----------  ------------------------
ibkr:paper:DUP246375  1               0                         2026-04-21T17:25:41.617Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T17:16:33Z

- Backend: UP (pid=41749, uptime=02:34:05, rss=32MB)
- Local API /health: {"ok":true}

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error  updated_at              
--------------------  --------------  ------------  ----------  ------------------------
ibkr:paper:DUP246375  1               0                         2026-04-21T17:16:32.094Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T17:11:47Z — ✅ CIRCUIT RECOVERED (2nd)

- Backend: UP (pid=41749, uptime=02:29:19, rss=32MB)
- Local API /health: {"ok":true}
- **Recovered at 17:11:32Z** from the 17:05Z flap (~6 min outage). Discord + Pushover alerting enabled at 17:09Z — next flap will send a push notification.

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error  updated_at              
--------------------  --------------  ------------  ----------  ------------------------
ibkr:paper:DUP246375  1               0                         2026-04-21T17:11:32.087Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T17:05:19Z — 🔴 CIRCUIT RE-OPENED

- Backend: UP (pid=41749, uptime=02:22:51, rss=32MB)
- Local API /health: {"ok":true}
- **Flap:** circuit opened again at 17:05:02Z — ~10 min after recovering from the 16:40Z incident. See updated "IBKR Gateway connection flapping" entry above.

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error                  updated_at              
--------------------  --------------  ------------  --------------------------  ------------------------
ibkr:paper:DUP246375  0               1             Broker health check failed  2026-04-21T17:05:02.083Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T17:00:35Z

- Backend: UP (pid=41749, uptime=02:18:07, rss=32MB)
- Local API /health: {"ok":true}

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error  updated_at              
--------------------  --------------  ------------  ----------  ------------------------
ibkr:paper:DUP246375  1               0                         2026-04-21T17:00:32.075Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T16:55:47Z — ✅ CIRCUIT RECOVERED

- Backend: UP (pid=41749, uptime=02:13:19, rss=33MB)
- Local API /health: {"ok":true}
- **Recovered at 16:55:32Z** from the circuit-open incident flagged at 16:40:49Z (~15 min outage). `broker_healthy=1`, `circuit_open=0`. IB Gateway reconnected.

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error  updated_at              
--------------------  --------------  ------------  ----------  ------------------------
ibkr:paper:DUP246375  1               0                         2026-04-21T16:55:32.075Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T16:40:53Z — 🔴 CIRCUIT OPENED

- Backend: UP (pid=41749, uptime=01:58:25, rss=33MB)
- Local API /health: {"ok":true}
- **New incident:** IBKR `ibkr:paper:DUP246375` circuit_open=1, broker_healthy=0, last_error="Broker health check failed". Sidecar is up (pid 58815, etime 7:12) but `/api/status` returns `connected=false` → IB Gateway upstream dropped. See "Ongoing incidents" section above.

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error                  updated_at              
--------------------  --------------  ------------  --------------------------  ------------------------
ibkr:paper:DUP246375  0               1             Broker health check failed  2026-04-21T16:40:49.128Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T16:33:14Z

- Backend: UP (pid=41749, uptime=01:50:46, rss=33MB)
- Local API /health: {"ok":true}

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error  updated_at              
--------------------  --------------  ------------  ----------  ------------------------
ibkr:paper:DUP246375  1               0                         2026-04-21T16:33:10.633Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T16:24:35Z

- Backend: UP (pid=41749, uptime=01:42:07, rss=33MB)
- Local API /health: {"ok":true}

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error  updated_at              
--------------------  --------------  ------------  ----------  ------------------------
ibkr:paper:DUP246375  1               0                         2026-04-21T16:24:29.815Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T16:19:48Z

- Backend: UP (pid=41749, uptime=01:37:20, rss=33MB)
- Local API /health: {"ok":true}

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error  updated_at              
--------------------  --------------  ------------  ----------  ------------------------
ibkr:paper:DUP246375  1               0                         2026-04-21T16:19:29.807Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```

---

## Snapshot 2026-04-21T16:15:04Z

- Backend: UP (pid=41749, uptime=01:32:36, rss=33MB)
- Local API /health: {"ok":true}

### Runtime health (per channel)
```
channel_id            broker_healthy  circuit_open  last_error  updated_at              
--------------------  --------------  ------------  ----------  ------------------------
ibkr:paper:DUP246375  1               0                         2026-04-21T16:14:59.791Z
```

### Tasks — last 60 min
```
task_type       status     n
--------------  ---------  -
EXECUTE_TRADE   COMPLETED  4
REVIEW_MESSAGE  COMPLETED  2
REVIEW_MESSAGE  FAILED     1
```

### Most recent failures (last 24h, up to 5)
```
id        task_type       model_provider  error                                                                                       completed_at            
--------  --------------  --------------  ------------------------------------------------------------------------------------------  ------------------------
65f01f45  REVIEW_MESSAGE  xai             This operation was aborted                                                                  2026-04-21T14:53:05.814Z
cf79fb1d  EXECUTE_TRADE   xai             IBKR sidecar 400: {"orderId":148,"twsCode":201,"error":"TWS error 201: Order rejected - re  2026-04-20T18:34:57.176Z
7bd623c6  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T18:01:46.524Z
6af8c798  EXECUTE_TRADE   xai             IBKR sidecar 503: {"error":"Account data not ready — subscription still initializing"}      2026-04-20T17:48:43.208Z
a8a7f4f5  EXECUTE_TRADE   xai             IBKR sidecar 504: {"error":"Market data snapshot timed out"}                                2026-04-20T17:38:32.295Z
```

### Pending / in-progress (live channels only)
```
```



