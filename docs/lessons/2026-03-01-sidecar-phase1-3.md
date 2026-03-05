# Sidecar Enhancements: OrderStore + execDetails + reqAccountUpdates

Date: 2026-03-01

## Problem

Three sidecar gaps blocked live trading:
1. `modifyOrder()` sent only `{ limitPrice }` — Java `modify()` rebuilt Contract+Order from empty body fields, guaranteed TWS rejection. Price chase broken.
2. `execDetails()` was a no-op — forced liquidation fills invisible, commission data lost.
3. `reqAccountSummary` one-shot gave only 4 tags — no Cushion, SMA, DayTradesRemaining, no per-position marketValue/unrealizedPnl.

## Decision

- **OrderStore**: Store Contract+Order in TwsBridge at placement time. `modify()` reads from store, updates only limitPrice, re-submits. Also populated via `openOrder()` callback (handles reconnect). No TS changes needed.
- **execDetails**: Implemented callbacks, store executions for execId→orderId correlation. Two separate WS events (execDetails + commission). Liquidation detection alerts on TS side.
- **reqAccountUpdates**: Persistent subscription started in `managedAccounts()`. Stores all account values + portfolio positions. `AccountRoutes` serves from subscription first, falls back to one-shot for cold start.
- **DRY cleanup**: Extracted `guardNotReady()` and `awaitAndRespond()` in OrderRoutes (was copy-pasted 3x).

## Key Files

- `sidecar/.../TwsBridge.java` — StoredOrder record, orderStore, executionStore, accountValues, portfolioPositions, all new callbacks
- `sidecar/.../OrderRoutes.java` — guardNotReady/awaitAndRespond helpers, storeOrder calls, rewritten modify()
- `sidecar/.../WsHandler.java` — broadcastExecDetails(), broadcastCommission()
- `sidecar/.../AccountRoutes.java` — subscription-first summary, position enrichment with portfolio data
- `src/broker/ibkr/schemas.ts` — ExecDetails + Commission WS events, optional fields on AccountSummary + Position
- `src/broker/ibkr/ws-listener.ts` — execDetails/commission event handling, forced liquidation alerts
- `src/broker/ibkr/client.ts` — pass through cushion/sma/dayTradesRemaining + marketValue/unrealizedPnl
- `src/broker/types.ts` — cushion/sma/dayTradesRemaining on AccountBalance

## Watch Out

- TWS Order objects are mutable — `modify()` reuses the stored instance. If TWS mutates it during processing, could cause race conditions. Monitor for unexpected order states.
- `execution.liquidation()` returns int (0=normal, nonzero=forced). Haven't been able to trigger forced liquidation in testing — code path validated by inspection only.
- `accountValues` map stores strings; `parseDouble()` in AccountRoutes converts. If TWS sends non-numeric values for numeric tags, will get `NumberFormatException`. The `parseDouble` helper returns 0.0 on null but doesn't catch parse failures — matches existing pattern in `accountSummary()`.
- `reqAccountUpdates` subscription refreshes every ~3 min from TWS. During first 10-15s after sidecar start, data may not be available (cold start fallback handles this).
