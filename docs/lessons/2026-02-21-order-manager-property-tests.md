Problem
OrderManager had no tests. Property-based analysis revealed three truthy-check bugs:
maxSteps: 0 treated as unlimited (0 is falsy), cancelAfterSec: 0 treated as "no timeout",
and the hasRules gate using the same pattern. Also found two cross-field constraints
(LIMIT → limitPrice, FILLED → fillTimestamp) enforced nowhere, plus consumer cruft from
WorkingOrder's optional fields forcing ! assertions even though onFill only fires with
guaranteed data.

Decision
Fixed all truthy checks to use != null. Added Zod schemas in broker/order-schemas.ts
with .refine() cross-field constraints: LIMIT requires limitPrice, FILLED requires
filledPrice + fillTimestamp. OrderManager.submitOrder() parses WorkingOrderParams at
entry; tick() parses OrderResult from getOrderStatus(); execute.ts placeOrder() parses
OrderResult for the direct-broker path too. No ad-hoc throws in orchestration —
validation is at the boundary via Zod, matching the codebase pattern (Signal uses
.refine(), TradeStation uses parseApiResponse()). Added FilledWorkingOrder type to
narrow onFill callback — eliminates ! assertions in runner.ts and index.ts consumers.
Removed dead filledPrice null-check and fillTimestamp ternary from execute.ts placeOrder().
Added 20 fast-check property tests covering fills, auto-cancel, price chase, and guard rails.

Key Files
src/broker/types.ts — FilledWorkingOrder type (narrows onFill callback)
src/broker/order-schemas.ts — Zod schemas for OrderParams, WorkingOrderParams, OrderResult
src/orders/order-manager.ts — truthy-check fixes + Zod parse at boundaries + FilledWorkingOrder onFill
src/pipeline/execute.ts — Zod parse on both broker paths, dead null check removed
src/orders/order-manager.test.ts — 20 property tests

Watch Out
Zod .refine() doesn't narrow the TypeScript output type — filledPrice/fillTimestamp remain
optional in z.infer<>. The ! assertions on these fields after Zod parse are TypeScript
necessities (safe because Zod validates at runtime), not lazy escapes. Discriminated unions
would fix this but require a larger refactor across BrokerService interface.

The cumulative price chase property (initial + K * step) does NOT hold due to iterative
rounding — each step rounds to cents before the next addition. The correct property is
that each step equals roundCents(previousPrice + stepAmount). Fast-check would catch the
divergence with stepAmount=0.007 after ~3 steps.
