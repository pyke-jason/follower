# Sidecar Gaps & TODOs

> Prioritized list of known issues. Must-fix items are blocking live trading with real money.

---

## Phase 1 -- Must Fix Before Live Trading

### SIDECAR (Java)

| # | Issue | File | Status |
|---|---|---|---|
| S1 | ~~`execDetails()` is a no-op~~ | TwsBridge.java:460-474 | **DONE** -- stores in `executionStore`, broadcasts `execDetails` event via WS, includes `liquidation` field |
| S2 | ~~`commissionAndFeesReport()` only logs~~ | TwsBridge.java:480-485 | **DONE** -- correlates with `executionStore` by `execId`, broadcasts `commission` event via WS |
| S3 | ~~`ORDER_ERROR_CODES` too narrow~~ | TwsBridge.java:33-34 | **DONE** -- now 12 codes: {110, 200, 201, 202, 203, 392, 399, 404, 412, 426, 460, 10239} |
| S4 | **No `+PACEAPI`** -- rate limit burst -> disconnect instead of throttle | TwsBridge.java (eConnect) | **TODO** |
| S5 | ~~Account summary tags too narrow~~ | AccountRoutes.java:23-24, 44-57 | **PARTIALLY DONE** -- warm path returns 8 fields. Cold-start fallback still only 4 tags |
| S6 | ~~PUT /orders/{id} requires full contract+order~~ | OrderRoutes.java:160-183 | **DONE** -- looks up stored order via OrderStore, merges limitPrice |
| S7 | ~~No order state caching~~ | TwsBridge.java:51-52 | **DONE** -- StoredOrder with ConcurrentHashMap |

### TS CLIENT

| # | Issue | File | Status |
|---|---|---|---|
| T1 | ~~`modifyOrder()` sends only `{limitPrice}`~~ | client.ts:260-283 | **DONE** -- sidecar handles via OrderStore lookup |
| T2 | ~~ws-listener ignores Cancelled/Inactive status~~ | ws-listener.ts:131-136 | **DONE** -- forceCheckCallback fires on Filled, Cancelled, Inactive |
| T3 | ~~ws-listener ignores error codes beyond 460~~ | ws-listener.ts:53-66 | **DONE** -- ERROR_ACTIONS map handles all 12 codes |
| T4 | **`resolveConId()` has no timeout** -- fetch call can hang forever | symbology.ts:59 | **TODO** |

### SCHEMAS (Fixed)

| # | Issue | Status |
|---|---|---|
| Z1 | QuoteResponseSchema required `symbol` (sidecar never sends it) | **FIXED** |
| Z2 | Quote fields all required (may be absent for illiquid) | **FIXED** -- all optional |
| Z3 | PositionResponseSchema required `marketValue`/`unrealizedPnl` | **FIXED** -- removed |
| Z4 | StatusResponseSchema missing `wsClients`/`maintenance` | **FIXED** -- added |
| Z5 | OrderResponseSchema missing `remaining` | **FIXED** -- added |
| Z6 | QuoteResponseSchema missing `close` field | **FIXED** -- added |

---

## Phase 2 -- After Live Trading Stabilizes

### SIDECAR

| # | Issue | Impact |
|---|---|---|
| S8 | ~~Add `reqAccountUpdates()` subscription~~ | **DONE** -- subscription starts on managedAccounts |
| S9 | Implement margin threshold alerts -- Cushion-based WS events | Risk monitoring |
| S10 | Handle `Inactive -> Submitted` recovery -- notify TS client | Correctness for short-locate scenarios |
| S11 | Add `whyHeld` and `mktCapPrice` to order status WS events | Visibility into order holds |
| S12 | Support `reqCompletedOrders()` -- retrieve filled/cancelled after reconnect | State reconciliation |
| S13 | Support WhatIf orders -- pre-trade margin check | Risk management |
| S14 | Add heartbeat watchdog -- detect zombie connections | Reliability |
| S15 | Handle error 507 as disconnect trigger | Reliability |
| S16 | After reconnect: `reqOpenOrders()` + `reqExecutions()` to reconcile | State reconciliation |
| S17 | Execution correction detection -- detect corrected execId | Correctness |
| S18 | Subscribe to tick type 49 (HALTED) for held securities | Risk visibility |
| S19 | Handle error 2100 (account subscription preempted) | Account data reliability |
| S20 | Handle error 326 (client ID conflict) in reconnect logic | Reconnect reliability |
| S21 | Handle competing session risk (Client Portal login) | Reconnect reliability |
| S22 | Expose LookAhead* tags in account summary REST response | Margin monitoring |
| S23 | Fix CompletableFuture memory leak on timeout | Memory |

### TS CLIENT

| # | Issue | Impact |
|---|---|---|
| T5 | Handle `Inactive` status as non-terminal (can recover to Submitted) | Correctness |
| T6 | Handle partial fills (same status, different filled/remaining) | Feature |
| T7 | Monitor `Cushion` account value, alert on < 10% / < 5% | Risk |
| T8 | Detect option assignment from position changes | Correctness |

---

## CompletableFuture Memory Leak (S23)

On timeout (5s), `CompletableFuture` stays in `pendingRequests` map but is no longer awaited. Late callbacks are consumed silently. Over time, the map grows unbounded.

**Fix:** Add cleanup after timeout -- `pendingRequests.remove(reqId)` in the timeout handler.
