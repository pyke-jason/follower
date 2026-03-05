# IBKR Operational Risk Audit

Date: 2026-03-02

## Problem

Pre-live audit of the IBKR sidecar (Java) and TS client to identify operational risks that could lose money, miss fills, or cause downtime. All 13 identified risks were verified against the current codebase.

## Findings

### CRITICAL — Can Lose Money or Create Phantom Positions

#### 1. No state reconciliation after reconnect — CONFIRMED

`TwsBridge.java:189-207` — `attemptReconnect()` calls `connect()` which only does `eConnect()` + EReader setup. Zero calls to `reqOpenOrders()`, `reqExecutions()`, or `reqAllOpenOrders()` anywhere in the sidecar. After disconnect/reconnect (nightly reset, heartbeat timeout, error 1100/504), any fills that occurred during the gap are permanently invisible to the TS client.

- `nextValidId()` (line 346): sets `connected=true`, starts heartbeat + reaper. No reconciliation.
- `managedAccounts()` (line 590): re-subscribes account data only (portfolio/positions), NOT order state.
- Tracked as **S16** (Phase 2 TODO) + **S12** (`reqCompletedOrders`).

This is the single most dangerous gap. During overnight holds, an assignment during the 00:15-01:45 ET reset window goes undetected.

#### 2. EReader thread stacking on reconnect — CONFIRMED

`TwsBridge.java:108-125` — `connect()` creates a local `EReader` + anonymous dispatch `Thread`. No instance fields stored, no old threads stopped/interrupted. After N reconnects, N zombie reader threads may accumulate, all sharing the same `EJavaSignal`.

Race condition: if `connect()` re-establishes before the old thread's `while(client.isConnected())` check, the old thread stays alive and both threads process messages on the shared signal.

#### 3. Inactive treated as terminal REJECTED — CONFIRMED

`client.ts:111-127` — `mapIbkrStatus()` maps `Inactive` to `REJECTED`. Order manager immediately deletes from `workingOrders` and fires `onCancel`. Per `docs/ibkr/order-lifecycle.md:34-39`, Inactive can recover to Submitted (short-locate found, exchange reopens, TWS precautionary block accepted). If the order later fills, it's a phantom position.

Tracked as **T5** (Phase 2 TODO) + **S10** (Inactive->Submitted notification).

### HIGH — Can Cause Downtime or Stale State

#### 4. No +PACEAPI — CONFIRMED

Zero occurrences of `SetConnectOptions` or `PACEAPI` in the sidecar. Without it, 3 rate-limit violations (>50 msg/s) = hard disconnect. Error 100 is NOT in `CONNECTION_CODES`, so reconnect doesn't trigger — heartbeat watchdog catches it 40-70s later. Combined with risk #1 (no reconciliation), this cascades.

Tracked as **S4** (Phase 1 TODO — still open).

#### 5. resolveConId() has no timeout — CONFIRMED

`symbology.ts:59` — `fetch()` with no `AbortController` or timeout. In `placeOrder` (client.ts:167-182), called OUTSIDE the `withRetry` wrapper via `Promise.all(legs.map(resolveConId))`. A hung sidecar stalls the entire order pipeline indefinitely.

In `getQuote`, called inside `withRetry` but signal is NOT passed to `resolveConId`'s fetch — only to the subsequent `sidecar()` call.

Mitigated by in-memory `conIdCache` after first resolution.

Tracked as **T4** (Phase 1 TODO — still open).

#### 6. Error 2100 silently kills account subscription — CONFIRMED (with latent bug)

Error 2100 not in any code set — falls to generic handler, no WS event broadcast. `accountSubscriptionActive` is never reset to `false` — not on disconnect, not on error 2100, not anywhere except the field initializer. After any disconnect/reconnect, `managedAccounts()` checks `!accountSubscriptionActive` before re-subscribing — since the flag is stuck `true`, re-subscription never happens. Only a full sidecar restart recovers.

Tracked as **S19** (Phase 2 TODO).

### MEDIUM — Incorrect State or Suboptimal Behavior

#### 7. fillTimestamp fabricated — CONFIRMED

`client.ts:325` — `result.fillTimestamp = new Date().toISOString()` is TS client poll time, not exchange fill time. The real time exists in `execDetails` WS events (`execution.time()`), broadcast by sidecar, validated by `ExecDetailsEventSchema.time`, but the WS listener never extracts it — only uses execDetails for forceCheck triggers. Flows to trades DB via order-manager -> record-trade.

TradeStation client does this correctly using `order.ClosedDateTime`.

#### 8. Error 1300 (socket port reset) unhandled — CONFIRMED

Error 1300 not in `CONNECTION_CODES` (only 1100, 1101, 1102, 504). Falls to generic handler — no `eDisconnect()`, no `connected=false`, no reconnect. Socket dead but sidecar thinks it's alive until heartbeat catches it (40-70s). Also missing: 507 (S15), 509, 326 (S20).

#### 9. modifyOrder penny rounding — PARTIALLY CONFIRMED

`client.ts:264` — `Math.round(newLimitPrice * 100) / 100` always penny-rounds because `modifyOrder` doesn't know the underlying. For non-Penny-Pilot symbols >= $3, this sends $0.01-tick prices. Sidecar's `OrderRoutes.java` re-rounds to $0.05 ticks — acts as safety net. But sidecar also lacks Penny Pilot awareness, so Penny Pilot symbols above $3 get unnecessarily rounded to $0.05.

Net: no rejection risk (sidecar corrects), but price chase can overshoot by up to $0.04 on Penny Pilot symbols.

#### 10. Competing session detection — PARTIALLY CONFIRMED

NOT silent — heartbeat detects dead connection within 40s, WS listener escalates after 5min during market hours, healthchecks.io pings externally via Pushover (priority 2, re-alert every 60s). BUT error 507 (competing session indicator) is not in `CONNECTION_CODES`, so root cause is never identified and reconnect loop retries blindly until auth is released.

### LOW — Minor Issues

#### 11. error() param `reqId` is actually `errorTime` — PARTIALLY CONFIRMED

`TwsBridge.java:391` — TWS API 10.40 5-param error: `(int id, long errorTime, int errorCode, String msg, String json)`. The param is named `reqId` in the code and logged as `reqId={}` at line 410. Misleading for log analysis but no functional impact.

#### 12. Error 326 (client ID conflict) not handled — CONFIRMED

Not in any error code set. Falls to generic handler. During reconnect, if IB Gateway still holds old client ID, reconnect fails with 326 repeatedly. The 5s retry delay may be enough for the old session to time out, but no explicit handling. Tracked as **S20**.

#### 13. Penny Pilot list incomplete — CONFIRMED

`client.ts:26-31` — 34 hardcoded symbols. Real CBOE Penny Pilot is 363+ classes. Missing: AMD, SOFI, PLTR, COIN, UBER, etc. For missing symbols, options >= $3 get $0.05 rounding when $0.01 would be valid — suboptimal but not rejected. Sidecar rounding is the safety net.

## Sidecar Hardening Plan Status

`docs/plans/sidecar-hardening-plan.md` — All 5 phases are implemented in code but the doc still reads as a proposal:

| Phase | Description | Code Status |
|-------|-------------|-------------|
| 1 | Guards.java | DONE — `Guards.java` exists, wired in `App.java:50` |
| 2 | Atomic modify + idempotency | DONE — `modifyOrderPrice()`, `clientOrderRef` idempotency |
| 3 | Audit logging | DONE — AUDIT log lines in OrderRoutes |
| 4 | Memory reaper | DONE — `evictStaleEntries()`, timestamp maps |
| 5 | Heartbeat watchdog | DONE — `heartbeatCheck()`, `declareConnectionDead()` |

## Live Path Hardening Plan Status

`docs/plans/live-path-hardening.md` — All 8 issues appear implemented but doc still says "PROPOSED":

- Orphan fill detection (DONE — `orphan_fills` table, `onOrphanFill` callback)
- Working order exposure in risk check (DONE — `getExposure()`, `WorkingOrderExposure`)
- Broker circuit breaker (DONE — `BrokerCircuitBreaker` class)
- messageId assertion (DONE — no `!` assertion found)
- TaskContext Zod schema (DONE — `TaskContextSchema`)
- Dead startTask export (DONE — removed)
- Shared factory (DONE — `buildPipelineDeps()`)

## gaps-and-todos.md — Open Items by Priority

**Phase 1 (blocking live):** S4 (+PACEAPI), T4 (resolveConId timeout), S5 partial (cold-start tags)

**Phase 2 (highest blast radius, still open):**
- S16 — Post-reconnect state reconciliation (reqOpenOrders + reqExecutions)
- S12 — reqCompletedOrders for order recovery
- T5 — Inactive as non-terminal
- T6 — Partial fill handling
- S9/T7 — Margin Cushion monitoring
- S15 — Error 507 as disconnect trigger
- S19 — Error 2100 handling
- S20 — Error 326 handling
- S21 — Competing session detection
- T8 — Option assignment detection
- S10 — Inactive->Submitted recovery notification
- S17 — Execution correction detection

**Confirmed done but not marked in doc:** S14 (heartbeat), S23 (memory leak)

## Decision

Assessment only — no fixes applied. Priority order for remediation:

1. **S16 + S12** — State reconciliation after reconnect (CRITICAL, money-losing)
2. **T5** — Inactive as non-terminal (CRITICAL, phantom positions)
3. **Risk #2** — EReader thread stacking (HIGH, slow-burn degradation)
4. **S4** — +PACEAPI one-liner (HIGH, easy fix)
5. **T4** — resolveConId timeout (HIGH, pipeline hang)
6. **accountSubscriptionActive reset** — Reset to false in `connectionClosed()` + `declareConnectionDead()` (HIGH, latent bug)

## Key Files

- `sidecar/src/main/java/com/tradefollower/sidecar/TwsBridge.java` — All sidecar risks
- `sidecar/src/main/java/com/tradefollower/sidecar/OrderRoutes.java` — Rounding, idempotency
- `src/broker/ibkr/client.ts` — Status mapping, fill timestamp, penny rounding
- `src/broker/ibkr/ws-listener.ts` — Escalation, forceCheck wiring
- `src/broker/ibkr/symbology.ts` — resolveConId timeout gap
- `docs/ibkr-sidecar/gaps-and-todos.md` — Gap tracking
- `docs/plans/sidecar-hardening-plan.md` — Implemented but doc stale
- `docs/plans/live-path-hardening.md` — Implemented but doc stale

## Watch Out

- The `accountSubscriptionActive` bug is worse than it appears — it's not just error 2100. ANY disconnect/reconnect cycle leaves the flag stuck `true`, preventing re-subscription forever. Only a sidecar restart recovers.
- Error codes 507, 509, 1300, 326 all fall through to generic handling. The `CONNECTION_CODES` set needs expanding.
- The sidecar hardening plan and live path hardening plan are both implemented but their docs are stale — they still read as proposals. Update them to reflect completion status.
