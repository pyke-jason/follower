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
| S4 | ~~**No `+PACEAPI`**~~ | TwsBridge.java:117 | **DONE** -- `client.setConnectOptions("+PACEAPI")` before `eConnect()` |
| S5 | ~~Account summary tags too narrow~~ | AccountRoutes.java:23-24, 44-57 | **PARTIALLY DONE** -- warm path returns 8 fields. Cold-start fallback still only 4 tags |
| S6 | ~~PUT /orders/{id} requires full contract+order~~ | OrderRoutes.java:160-183 | **DONE** -- looks up stored order via OrderStore, merges limitPrice |
| S7 | ~~No order state caching~~ | TwsBridge.java:51-52 | **DONE** -- StoredOrder with ConcurrentHashMap |
| S24 | ~~EReader thread stacking on reconnect~~ | TwsBridge.java:82-83, 115, 121-133 | **DONE** -- reader/dispatchThread stored as instance fields, old thread interrupted before creating new |

### TS CLIENT

| # | Issue | File | Status |
|---|---|---|---|
| T1 | ~~`modifyOrder()` sends only `{limitPrice}`~~ | client.ts:260-283 | **DONE** -- sidecar handles via OrderStore lookup |
| T2 | ~~ws-listener ignores Cancelled/Inactive status~~ | ws-listener.ts:131-136 | **DONE** -- forceCheckCallback fires on Filled, Cancelled, Inactive |
| T3 | ~~ws-listener ignores error codes beyond 460~~ | ws-listener.ts:53-66 | **DONE** -- ERROR_ACTIONS map handles all 12 codes |
| T4 | ~~**`resolveConId()` has no timeout**~~ | symbology.ts:61 | **DONE** -- `AbortSignal.timeout(10_000)` on fetch call |
| T9 | ~~Penny Pilot list incomplete (34 symbols vs 363+ real)~~ | client.ts:26-33 | **DONE** -- expanded to 43 symbols including AMD, COIN, PLTR, SOFI, etc. |

### SCHEMAS (Fixed)

| # | Issue | Status |
|---|---|---|
| Z1 | QuoteResponseSchema required `symbol` (sidecar never sends it) | **FIXED** |
| Z2 | Quote fields all required (may be absent for illiquid) | **FIXED** -- all optional |
| Z3 | PositionResponseSchema required `marketValue`/`unrealizedPnl` | **FIXED** -- removed |
| Z4 | StatusResponseSchema missing `wsClients`/`maintenance` | **FIXED** -- added |
| Z5 | OrderResponseSchema missing `remaining` | **FIXED** -- added |
| Z6 | QuoteResponseSchema missing `close` field | **FIXED** -- added |
| Z7 | ~~OrderResponseSchema missing `fillTime`~~ | **FIXED** -- added `fillTime: z.string().optional()` |

---

## Phase 2 -- After Live Trading Stabilizes

### SIDECAR

| # | Issue | Impact | Status |
|---|---|---|---|
| S8 | ~~Add `reqAccountUpdates()` subscription~~ | Account data | **DONE** -- subscription starts on managedAccounts |
| S9 | Implement margin threshold alerts -- Cushion-based WS events | Risk monitoring | TODO |
| S10 | ~~Handle `Inactive -> Submitted` recovery~~ | Correctness | **DONE** -- Inactive now maps to PENDING in TS client, order stays in working set |
| S11 | Add `whyHeld` and `mktCapPrice` to order status WS events | Visibility into order holds | TODO |
| S12 | Support `reqCompletedOrders()` -- retrieve filled/cancelled after reconnect | State reconciliation | TODO (partial -- reqExecutions added in S16) |
| S13 | Support WhatIf orders -- pre-trade margin check | Risk management | TODO |
| S14 | ~~Add heartbeat watchdog -- detect zombie connections~~ | Reliability | **DONE** -- heartbeatCheck() + declareConnectionDead() |
| S15 | ~~Handle error 507 as disconnect trigger~~ | Reliability | **DONE** -- 507 added to CONNECTION_CODES with eDisconnect + reconnect |
| S16 | ~~After reconnect: `reqOpenOrders()` + `reqExecutions()` to reconcile~~ | State reconciliation | **DONE** -- both called in nextValidId() after connect |
| S17 | Execution correction detection -- detect corrected execId | Correctness | TODO |
| S18 | Subscribe to tick type 49 (HALTED) for held securities | Risk visibility | TODO |
| S19 | ~~Handle error 2100 (account subscription preempted)~~ | Account data reliability | **DONE** -- resets accountSubscriptionActive, re-subscribes |
| S20 | ~~Handle error 326 (client ID conflict) in reconnect logic~~ | Reconnect reliability | **DONE** -- 15s reconnect delay on error 326 |
| S21 | ~~Handle competing session risk (Client Portal login)~~ | Reconnect reliability | **DONE** -- 507 in CONNECTION_CODES + persistent failure tracking (5+ failures broadcasts alert) |
| S22 | Expose LookAhead* tags in account summary REST response | Margin monitoring | TODO |
| S23 | ~~Fix CompletableFuture memory leak on timeout~~ | Memory | **DONE** -- awaitRequest() finally block + map reaper |
| S25 | ~~Error 1300/509 not handled as connection events~~ | Reliability | **DONE** -- 1300, 509 added to CONNECTION_CODES with eDisconnect + reconnect |
| S26 | ~~accountSubscriptionActive never resets on disconnect~~ | Account data reliability | **DONE** -- reset in connectionClosed() and declareConnectionDead() |
| S27 | ~~error() param `reqId` is actually `errorTime`~~ | Debuggability | **DONE** -- renamed param and log label |
| S28 | ~~fillTimestamp fabricated (poll time, not exchange time)~~ | Audit accuracy | **DONE** -- execDetails stores execution.time() as fillTime in orderStatuses; TS client uses it |
| S29 | ~~Penny Pilot awareness missing in sidecar rounding~~ | Price accuracy | **DONE** -- roundToOptionTick now accepts underlying, checks PENNY_PILOT set |

### TS CLIENT

| # | Issue | Impact | Status |
|---|---|---|---|
| T5 | ~~Handle `Inactive` status as non-terminal (can recover to Submitted)~~ | Correctness | **DONE** -- Inactive maps to PENDING, order stays in working set |
| T6 | Handle partial fills (same status, different filled/remaining) | Feature | TODO |
| T7 | Monitor `Cushion` account value, alert on < 10% / < 5% | Risk | TODO |
| T8 | Detect option assignment from position changes | Correctness | TODO |
| T10 | ~~ws-listener: alert on persistent reconnect failure~~ | Reliability | **DONE** -- critical alert when sidecar broadcasts 5+ consecutive failures |

---

## Remaining TODOs (prioritized)

| Priority | IDs | Description |
|---|---|---|
| High | S12 | `reqCompletedOrders()` for full post-reconnect order recovery |
| High | T6 | Partial fill detection via filled/remaining deltas |
| High | T8 | Option assignment detection from position changes |
| Medium | S9, T7 | Margin Cushion monitoring + threshold alerts |
| Medium | S11 | whyHeld/mktCapPrice in order status events |
| Medium | S13 | WhatIf orders for pre-trade margin check |
| Medium | S22 | LookAhead* tags in account summary |
| Low | S5 | Cold-start account summary fallback (only 4 tags) |
| Low | S17 | Execution correction detection |
| Low | S18 | HALTED tick type subscription |
