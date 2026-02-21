Problem
OrderManager had no tests. Property-based analysis revealed three truthy-check bugs:
maxSteps: 0 treated as unlimited (0 is falsy), cancelAfterSec: 0 treated as "no timeout",
and the hasRules gate using the same pattern. Also found two silent fallbacks:
limitPrice non-null assertion that could propagate NaN, and fillTimestamp falling back to
wall-clock time when missing.

Decision
Fixed all truthy checks to use != null. Replaced non-null assertion on limitPrice with
an explicit throw. Replaced fillTimestamp fallback with an explicit throw — a broker
reporting FILLED without a timestamp is a bug that should be caught, not papered over.
Added 20 fast-check property tests covering fills, auto-cancel, price chase, and guard rails.

Key Files
src/orders/order-manager.ts — the three truthy-check fixes + two throw guards
src/orders/order-manager.test.ts — new property test file (20 tests)
src/backtest/test-fixtures.ts — existing arbitraries (not modified, but referenced for pattern)

Watch Out
The cumulative price chase property (initial + K * step) does NOT hold due to iterative
rounding — each step rounds to cents before the next addition. The correct property is
that each step equals roundCents(previousPrice + stepAmount). Fast-check would catch the
divergence with stepAmount=0.007 after ~3 steps.
