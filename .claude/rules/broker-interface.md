---
paths: src/broker/**
---

# Broker Interface

## BrokerService Abstraction

`src/broker/interface.ts` defines the `BrokerService` interface — the boundary between pipeline code and broker implementations. Implementations:

- `SimBroker` (`src/backtest/sim-broker.ts`) — simulated fills for backtesting
- Live brokers under `src/broker/` (e.g. `tradestation/`, `ibkr/`) — real API integrations

`src/broker/select.ts` selects the live broker at runtime via the `BROKER` env var.

## Rules

1. **Pipeline code imports the interface, never the implementation.** Files in `src/pipeline/`, `src/orders/`, `src/intents/` must only reference `BrokerService`, never concrete implementations like `SimBroker` or the live service exports.

2. **Order schemas** (`order-schemas.ts`) define Zod validation for orders and results:
   - `WorkingOrderParamsSchema`: LIMIT orders require `limitPrice` (`.refine()`)
   - `OrderResultSchema`: FILLED orders require `filledPrice` + `fillTimestamp` (`.refine()`)
   These are the boundary validation — don't duplicate these checks in calling code.

3. **Types** (`types.ts`): Canonical broker data types (e.g. `OrderResult`, `WorkingOrder`, `FilledWorkingOrder`, `BrokerPosition`, `Quote`). When the pipeline needs broker data, it flows through these types. Don't create parallel type hierarchies.

4. **Narrowed callbacks**: `onFill` receives `FilledWorkingOrder` (not `WorkingOrder`). `filledPrice`, `filledAt`, `fillTimestamp` are guaranteed present.
