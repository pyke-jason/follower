# IBKR Integration — Gaps & TODOs

> Prioritized list of known issues. Must-fix items are blocking live trading with real money.

---

## Phase 1 — Must Fix Before Live Trading

### SIDECAR (Java)

| # | Issue | File | Impact |
|---|---|---|---|
| S1 | **`execDetails()` is a no-op** — fills discarded, forced liquidations invisible | TwsBridge.java:400 | Critical: no liquidation detection, missed fills for market orders |
| S2 | **`commissionAndFeesReport()` only logs** — commission data never reaches TS client | TwsBridge.java:406 | High: trade records missing commission |
| S3 | **`ORDER_ERROR_CODES` too narrow** — only {110,201,202,460}. Missing: 200,203,392,399,404,412 | TwsBridge.java | High: important errors silently swallowed |
| S4 | **No `+PACEAPI`** — rate limit burst → disconnect instead of throttle | TwsBridge.java (eConnect) | High: production reliability |
| S5 | **Account summary tags too narrow** — missing Cushion, ExcessLiquidity, SMA, DayTradesRemaining | AccountRoutes.java | High: no margin/risk visibility |
| S6 | **PUT /orders/{id} requires full contract+order** — TS client sends only {limitPrice} | OrderRoutes.java | **Critical: modifyOrder is broken** |
| S7 | **No order state caching** — modify needs original contract, sidecar doesn't save it | TwsBridge.java | Blocks S6 fix |

### TS CLIENT

| # | Issue | File | Impact |
|---|---|---|---|
| T1 | **`modifyOrder()` sends only `{limitPrice}`** — sidecar needs full contract+order | client.ts:260-283 | **Critical: price chase will fail on IBKR** |
| T2 | **ws-listener ignores Cancelled/Inactive status** — only handles Filled | ws-listener.ts:67-69 | Medium: no alert on order rejection/cancellation |
| T3 | **ws-listener ignores error codes beyond 460** — misses 201 (reject), 202 (cancel) | ws-listener.ts:73-79 | Medium: no alert on order rejection |
| T4 | **`resolveConId()` has no timeout** — fetch call can hang forever | symbology.ts:59 | Medium: pipeline can hang |

### SCHEMAS (Fixed in this session)

| # | Issue | Status |
|---|---|---|
| Z1 | QuoteResponseSchema required `symbol` (sidecar never sends it) | **FIXED** — removed |
| Z2 | Quote fields all required (may be absent for illiquid) | **FIXED** — all optional |
| Z3 | PositionResponseSchema required `marketValue`/`unrealizedPnl` (not available) | **FIXED** — removed |
| Z4 | StatusResponseSchema missing `wsClients`/`maintenance` | **FIXED** — added |
| Z5 | OrderResponseSchema missing `remaining` | **FIXED** — added |
| Z6 | QuoteResponseSchema missing `close` field | **FIXED** — added |

---

## Phase 2 — After Live Trading Stabilizes

### SIDECAR

| # | Issue | Impact |
|---|---|---|
| S8 | ~~Add `reqAccountUpdates()` subscription~~ **DONE** — subscription starts on `managedAccounts`, enriches `/api/positions` with marketValue/unrealizedPnl | ~~Enables: marketValue, unrealizedPnl per position~~ |
| S9 | Implement margin threshold alerts — Cushion-based WS events | Risk monitoring |
| S10 | Handle `Inactive → Submitted` recovery — notify TS client when held order recovers | Correctness for short-locate scenarios |
| S11 | Add `whyHeld` and `mktCapPrice` to order status WS events | Visibility into order holds |
| S12 | Support `reqCompletedOrders()` — retrieve filled/cancelled orders after reconnect | State reconciliation |
| S13 | Support WhatIf orders — pre-trade margin check | Risk management |
| S14 | Add heartbeat watchdog — detect zombie connections | Reliability |
| S15 | Handle error 507 as disconnect trigger | Reliability |
| S16 | After reconnect: `reqOpenOrders()` + `reqExecutions()` to reconcile | State reconciliation |
| S17 | Execution correction detection — detect corrected `execId` to avoid double-counting | Correctness |
| S18 | Subscribe to tick type 49 (HALTED) for held securities | Risk visibility |

### TS CLIENT

| # | Issue | Impact |
|---|---|---|
| T5 | Handle `Inactive` status as non-terminal (can recover to Submitted) | Correctness |
| T6 | Handle partial fills (same status, different filled/remaining) | Feature |
| T7 | Monitor `Cushion` account value, alert on < 10% / < 5% | Risk |
| T8 | Detect option assignment from position changes | Correctness |

---

## Fix Plan for S6/T1 (modifyOrder — Most Critical Bug)

The sidecar's PUT /api/orders/{id} needs full contract + order for TWS modify. Two approaches:

### Option A: Fix in sidecar (recommended)

1. Store original contract + order in `ConcurrentHashMap<orderId, OrderEntry>` when placed
2. On PUT, merge the client's changed fields into the stored entry
3. Send complete order to TWS

**Pros:** TS client stays simple (just sends changed fields). Sidecar already stores orderStatuses, extending to full order is natural.

### Option B: Fix in TS client

1. Maintain orderId → original params map in client.ts
2. Send full contract + order on every modify

**Cons:** BrokerService interface needs change. More state management in TS.

---

## CompletableFuture Memory Leak

On timeout (5s), `CompletableFuture` stays in `pendingRequests` map but is no longer awaited. Late callbacks are consumed silently. Over time, the map grows unbounded.

**Fix:** Add cleanup after timeout — `pendingRequests.remove(reqId)` in the timeout handler.
