Problem
OrderManager had no tests. Property-based analysis revealed three truthy-check bugs:
maxSteps: 0 treated as unlimited (0 is falsy), cancelAfterSec: 0 treated as "no timeout",
and the hasRules gate using the same pattern. Also found two cross-field constraints
(LIMIT → limitPrice, FILLED → fillTimestamp) enforced nowhere.

Decision
Fixed all truthy checks to use != null. Added Zod schemas in broker/order-schemas.ts
with .refine() cross-field constraints: LIMIT requires limitPrice, FILLED requires
filledPrice + fillTimestamp. OrderManager.submitOrder() parses WorkingOrderParams at
entry; tick() parses OrderResult from getOrderStatus(). No ad-hoc throws in
orchestration — validation is at the boundary via Zod, matching the codebase pattern
(Signal uses .refine(), TradeStation uses parseApiResponse()).
Added 20 fast-check property tests covering fills, auto-cancel, price chase, and guard rails.

Key Files
src/broker/order-schemas.ts — Zod schemas for OrderParams, WorkingOrderParams, OrderResult
src/orders/order-manager.ts — three truthy-check fixes + Zod parse at boundaries
src/orders/order-manager.test.ts — 20 property tests
src/backtest/test-fixtures.ts — existing arbitraries (referenced for pattern)

Watch Out
The cumulative price chase property (initial + K * step) does NOT hold due to iterative
rounding — each step rounds to cents before the next addition. The correct property is
that each step equals roundCents(previousPrice + stepAmount). Fast-check would catch the
divergence with stepAmount=0.007 after ~3 steps.
