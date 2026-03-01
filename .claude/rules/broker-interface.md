---
paths: src/broker/**
---

# Broker Interface

## BrokerService Abstraction

`src/broker/interface.ts` (or `types.ts`) defines the `BrokerService` interface — the boundary between pipeline code and broker implementations. Two implementations exist:

- `SimBroker` (`src/backtest/sim-broker.ts`) — simulated fills for backtesting
- `liveService` (`src/broker/tradestation/`) — real TradeStation API

## Rules

1. **Pipeline code imports the interface, never the implementation.** Files in `src/pipeline/`, `src/orders/`, `src/intents/` must only reference `BrokerService`, never `SimBroker` or `liveService` directly.

2. **Order schemas** (`order-schemas.ts`) define Zod validation for orders and results:
   - `WorkingOrderParamsSchema`: LIMIT orders require `limitPrice` (`.refine()`)
   - `OrderResultSchema`: FILLED orders require `filledPrice` + `fillTimestamp` (`.refine()`)
   These are the boundary validation — don't duplicate these checks in calling code.

3. **Types** (`types.ts`): `OrderResult`, `WorkingOrder`, `FilledWorkingOrder`, `BrokerPosition`, `Quote`. When the pipeline needs broker data, it flows through these types. Don't create parallel type hierarchies.

4. **Narrowed callbacks**: `onFill` receives `FilledWorkingOrder` (not `WorkingOrder`). `filledPrice`, `filledAt`, `fillTimestamp` are guaranteed present.
