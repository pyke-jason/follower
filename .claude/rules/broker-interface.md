---
paths: src/broker/**
---

# Broker Interface

## BrokerService Interface (`interface.ts`)

The `BrokerService` interface is the boundary between pipeline code and broker implementations. All pipeline/orders/orchestrator code depends on this interface, never on concrete implementations.

Methods: `getQuote`, `placeOrder`, `modifyOrder`, `cancelOrder`, `getOrderStatus`, `getPositions`, `getAccountBalance`, `isHealthy`.

Implementations:
- `SimBroker` (`src/backtest/sim-broker.ts`) — simulated fills for backtesting
- IBKR (`src/broker/ibkr/`) — Interactive Brokers via Java sidecar
- TradeStation (`src/broker/tradestation/`) — TradeStation REST API

## Broker Selection (`select.ts`)

`getRuntimeChannelServices()` returns an array of `RuntimeChannelService` (channel definition + `BrokerService` instance). `getRuntimeBrokerMap()` returns a `Map<channelId, BrokerService>` for lookup.

Channel config is resolved by `getRuntimeChannelDefinitions()` in `src/lib/runtime-channels.ts`, which reads env vars (`IBKR_LIVE_ACCOUNT_ID`, `IBKR_PAPER_ACCOUNT_ID`, `TS_ACCOUNT_ID`) and applies `ENABLED_CHANNEL_IDS` filtering.

## Rules

1. **Pipeline imports the interface, never an implementation.** Files in `src/pipeline/`, `src/orders/`, `src/intents/` reference only `BrokerService` and types from `src/broker/types.ts`. This keeps pipeline code broker-agnostic so it runs identically in backtest and live — behavioral differences belong in `BrokerService` implementations.

2. **Boundary schemas (`order-schemas.ts`) own cross-field validation.** Do not duplicate these checks in calling code.
   - `WorkingOrderParamsSchema`: LIMIT orders require `limitPrice` (`.refine()`)
   - `OrderResultSchema`: FILLED orders require `filledPrice` + `fillTimestamp` (`.refine()`)

3. **Canonical types (`types.ts`) are the single type hierarchy for broker data.** Key types: `OrderParams`, `WorkingOrderParams`, `OrderResult`, `WorkingOrder`, `FilledWorkingOrder`, `BrokerPosition`, `AccountBalance`, `Quote`, `AdjustmentRule`. Do not create parallel type hierarchies — if a new concept touches order flow, add it here.

4. **Narrowed callbacks — `onFill` receives `FilledWorkingOrder`, not `WorkingOrder`.** The fields `filledPrice`, `filledAt`, `fillTimestamp` are guaranteed present. This is wired in `src/orders/build-order-callbacks.ts` which bridges broker types to pipeline callbacks for both live and backtest runners.

5. **`isHealthy()` is a lightweight probe, not a full connectivity test.** Returns `false` if the broker is unreachable or in maintenance. Used for runtime health checks — do not add heavy logic here.
