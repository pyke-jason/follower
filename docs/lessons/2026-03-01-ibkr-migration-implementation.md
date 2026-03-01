# IBKR Migration Implementation — 2026-03-01

## Problem

Migrate from TradeStation to Interactive Brokers. The existing `BrokerService` interface is the abstraction boundary — everything above it (pipeline, orders, reconciliation) is broker-agnostic. Scope: (1) Java sidecar bridging TWS API to REST, (2) TypeScript IBKR client implementing `BrokerService`, (3) shared code extractions.

## What Was Built

### Phase 0: Code Extractions

- **0.1-0.2**: Moved `src/backtest/occ-symbology.ts` → `src/lib/occ-symbology.ts`. Updated 8 import paths. Exported canonical `extractUnderlying` (regex version from position-path.ts), deleted copies from `reconciler.ts` and `position-path.ts`.
- **0.3**: Exported `classifyError` + `ErrorCategory` from `src/lib/resilient.ts`. Deleted `classifyGeneric` duplicate from `src/broker/tradestation/client.ts`.
- **0.4**: Moved `getSpreadWidth` from `src/backtest/margin-model.ts` → `src/lib/trade.ts`.

### Phase 1: Java Sidecar (`sidecar/`)

7 Java files in `src/main/java/com/tradefollower/sidecar/`:

- `App.java` — Javalin HTTP server on port 8090, health endpoint, WS at `/events`
- `TwsBridge.java` — extends `DefaultEWrapper`, EReader thread, CompletableFuture request/response mapping (5s timeout), auto-reconnect, maintenance window (00:15-01:45 ET), error code classification
- `ContractRoutes.java` — POST `/api/contracts/resolve`
- `MarketDataRoutes.java` — POST `/api/market-data/snapshot`
- `OrderRoutes.java` — single + combo (BAG) orders with NonGuaranteed=1, tick rounding
- `AccountRoutes.java` — GET `/api/account/summary`, GET `/api/positions`
- `WsHandler.java` — WebSocket broadcasting (connected/disconnected/reconnected/orderStatus/error)

Build: `cd sidecar && ./gradlew jar` → `build/libs/ibkr-sidecar-1.0.0.jar`

### Phase 2: TypeScript IBKR Client (`src/broker/ibkr/`)

- `schemas.ts` — Zod schemas for all sidecar responses + `SidecarEvent` discriminated union
- `symbology.ts` — OCC → conId resolution via sidecar, in-memory cache
- `client.ts` — Full `BrokerService` implementation with `ibkrClassify` error classifier
- `ws-listener.ts` — WebSocket consumer, alert integration, auto-reconnect
- `index.ts` — exports `ibkrService`, `startWsListener`, `stopWsListener`

### Broker Selection

`src/live/runner.ts` — `BROKER` env var (`ibkr` | `tradestation`, default: tradestation). WS listener auto-starts when BROKER=ibkr.

## Key Files

| File | Role |
|---|---|
| `docs/plans/ibkr-migration-plan.md` | Full spec (architecture, API, phases) |
| `sidecar/src/main/java/com/tradefollower/sidecar/TwsBridge.java` | Critical: EReader thread, CompletableFuture mapping |
| `src/broker/ibkr/client.ts` | BrokerService implementation |
| `src/broker/ibkr/schemas.ts` | Zod validation for sidecar responses |
| `src/broker/interface.ts` | BrokerService interface (unchanged) |
| `src/live/runner.ts` | Broker factory + WS listener wiring |
| `src/lib/occ-symbology.ts` | Shared OCC symbology (moved from backtest/) |
| `src/lib/resilient.ts` | Shared classifyError (now exported) |

## Issues Found During Real Verification

### TWS API 10.40 Signature Changes (11 compile errors)

The agent-generated code assumed an older TWS API. Real build against `TwsApi.jar` (v10.40) revealed:

| Issue | Fix |
|---|---|
| `implements EWrapper` (100+ abstract methods) | `extends DefaultEWrapper` (gets all ProtoBuf stubs) |
| `error(int, int, String, String)` | `error(int, long, int, String, String)` — 5 params |
| `Decimal.doubleValue()` doesn't exist | `Decimal.value().doubleValue()` |
| `CommissionReport` class gone | `CommissionAndFeesReport` |
| `orderState.commission()` | `orderState.commissionAndFees()` |
| `cancelOrder(int, String)` | `cancelOrder(int, new OrderCancel(""))` |
| `orderStatus(..., int permId, ...)` | `..., long permId, ...` |
| `reader.processMsgs()` now throws IOException | Wrapped in try-catch |

### Other Issues Fixed

- **Jar name mismatch**: `start-sidecar.sh` expected `sidecar.jar`, Gradle produces `ibkr-sidecar-1.0.0.jar`
- **WS listener never started**: `startWsListener` was exported but not called in `runner.ts`
- **DRY violation**: `buildLegOccSymbol` in client.ts duplicated `formatOccSymbol` from occ-symbology.ts — replaced with import

## End-to-End Verification Results

Sidecar builds and starts. TypeScript client integration test against running sidecar:

- Sidecar returns 503 when Gateway disconnected (correct)
- Client classifies 503 as transient, retries with exponential backoff (correct)
- `getOrderStatus("99999")` returns 404, client doesn't retry (correct)
- Full HTTP round-trip works: TS client → fetch → sidecar → JSON response → Zod parse

## Watch Out

- **TwsApi.jar is NOT on Maven Central** — must download from `https://interactivebrokers.github.io` and place in `sidecar/lib/`
- **TWS API changes constantly** — if you update TwsApi.jar, expect new abstract methods on EWrapper. Using `DefaultEWrapper` mitigates this.
- **`Decimal` has no `doubleValue()`** — always go through `.value().doubleValue()` or `.longValue()`
- **Penny Pilot set is hardcoded** in `client.ts:25-30` — needs occasional update as CBOE adds/removes symbols
- **`fillTimestamp` is synthetic** — set to poll time, not actual fill time (sidecar doesn't return it)
- **`realizedPnl` hardcoded to 0** — IBKR account summary doesn't provide daily realized P&L
- **Combo orders MUST have `NonGuaranteed=1`** for SMART routing — sidecar enforces this

## Next Steps

1. Install IB Gateway + IBC on macOS
2. Create second IBKR username for API (avoid session collisions)
3. Test against paper trading (port 4002)
4. Run paper for 1+ week before live cutover
5. Set up launchd plists (Gateway, sidecar, Trade Follower)
6. Sunday 2FA reminder cron via Pushover
