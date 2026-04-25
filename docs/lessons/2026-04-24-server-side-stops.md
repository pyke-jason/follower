# Server-Side Stop Orders

## Problem

Every open position was unprotected if the bot died. Stops were not implemented at all — no bracket orders, no polling loop, nothing. A `kill -9` mid-trade left positions fully exposed.

## Decision

Implement **post-fill GTC stop orders** rather than bracket orders attached at entry. Reasoning:
- Bracket orders must be submitted before the entry fills, before we know the exact fill price. Our price-chase mechanism makes this awkward.
- GTC stop submitted immediately after fill is simpler, equally durable, and lets us use the actual fill price for stop calculation.
- Stop lives at IBKR as an independent order — survives bot restart entirely.

Architecture: `placeStopOrder()` added to `BrokerService` interface, implemented in IBKR client as a `STP` (stocks) or `STP LMT` (options) single order placed via the sidecar's `/orders/single` endpoint.

## Defaults (no explicit stop from trader)

| Strategy | Direction | Stop type | Trigger |
|---|---|---|---|
| STOCK | LONG | STP (market) | 5% below entry |
| STOCK | SHORT | STP (market) | 5% above entry |
| CALL / PUT | LONG | STP LMT | 50% of premium lost; limit 10% below trigger |
| CALL / PUT | SHORT | STP LMT | 3× received premium (buyback); limit 10% above trigger |
| Spreads | any | — | **Not supported** (v2 backlog) |

## Lifecycle

- **OPEN fill**: `execute-resolved.ts` `recordFill` wrapper → `placeTradeStop()` → `stopOrderId` stamped in `trades.metadata`
- **CLOSE fill**: `cancelTradeStop()` cancels at IBKR and clears `stopOrderId`
- **TRIM fill**: `cancelAndReplaceStop()` — cancels old stop, re-reads remaining quantity from DB, places new stop
- **Startup**: `reconcileStops()` in `src/reconciliation/stop-reconciler.ts` — called before ingestion starts in `src/index.ts`. Checks each open trade: if `stopOrderId` is absent or the order is gone at IBKR, places a fresh stop based on the recorded `entryPrice`

## Key Files

- `src/config/stop-defaults.ts` — constants and `computeStopParams()`
- `src/trades/stop-orders.ts` — `placeTradeStop`, `cancelTradeStop`, `cancelAndReplaceStop`
- `src/reconciliation/stop-reconciler.ts` — startup reconciliation
- `src/broker/ibkr/client.ts` — `placeStopOrder()` (STP/STP LMT via sidecar)
- `sidecar/.../RequestBodies.java` — `auxPrice` field added to `PlaceSingleBody`
- `sidecar/.../OrderRoutes.java` — `order.auxPrice()` applied in `placeSingle`
- `src/db/schema.ts` — `TradeMetadata.stopOrderId` field

## Watch Out

- **Spreads have no stop**. The reconciler logs a warning and skips them. Multi-leg close orders need spread-aware stop logic — tracked as backlog.
- **TRIM stop replacement is async** — if the bot crashes between TRIM fill and re-placement, the startup reconciler catches it next boot.
- **Stop quantity on IBKR must match position size** — if a stop fires for more contracts than exist, IBKR fills what it can. The re-placement after TRIM corrects this.
- **The sidecar `auxPrice` field is new** — sidecar needs to be rebuilt and redeployed alongside the TypeScript changes.
- **No schema migration needed** — `stopOrderId` is added to the `TradeMetadata` JSONB column type only (no DDL change).
