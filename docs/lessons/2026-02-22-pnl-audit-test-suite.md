Problem
No tests existed for the core P&L computation pipeline: computeTradePnl, computeCoreStats,
commission calculation, equity curve construction, extended metrics (Sharpe/Sortino/Calmar),
or the SimBroker round-trip flow. Real money depends on these being correct.

Decision
Built 7 test files with 132 tests (property-based via fast-check + deterministic). Tests
assert idealized behavior, not existing behavior — bugs discovered during the audit were
fixed in source code rather than accommodated in tests.

Bugs found and fixed:
- pnl.ts: Number.isNaN guard missed Infinity inputs. Changed to Number.isFinite.
- trade.ts: tradeQty(0) returned 0 silently. Now throws (zero-quantity trade is nonsensical).
- commission.ts: stock min > max schedule silently returned max. Now throws.

Key invariants tested:
- PnL direction antisymmetry: LONG(A,B) = -SHORT(A,B)
- PnL quantity linearity: PnL(N) = N * PnL(1) within 0.005*N + 0.005
- Net PnL conservation: sum of per-trade net PnLs = summary.netPnl
- Equity curve cumulative consistency: cumPnl[i] = cumPnl[i-1] + pnl[i]
- Commission round-trip = 2x entry (always)
- Drawdown non-negative, drawdown <= sum of losses
- Profit factor = grossWins / grossLosses (999.99 sentinel for zero losses)

Key Files
src/lib/pnl.test.ts — 18 tests: antisymmetry, linearity, multiplier, rounding, NaN/Infinity guard
src/lib/commission.test.ts — 14 tests: round-trip=2x, bounds, leg scaling, min/max validation
src/lib/helpers.test.ts — 37 tests: safeParseFloat, roundCents idempotency, contractMultiplier, tradeQty
src/backtest/report.test.ts — 17 tests: conservation, partition, drawdown, profit factor, commissions
src/backtest/equity-curve.test.ts — 12 tests: chronological, cumulative, MTM merge, final=netPnl
src/backtest/extended-metrics.test.ts — 8 tests: Sharpe, Sortino, streaks, median, holding period
src/backtest/sim-broker-pnl.test.ts — 26 tests: round-trip, TRIM lifecycle, ADD lifecycle, forceCloseAll

Watch Out
- Sortino uses N denominator (population), Sharpe uses N-1 (sample). This is correct per their
  respective standard definitions, not a bug.
- roundCents(1.005) = 1.00, not 1.01 — IEEE 754 representation issue. Documented, not a bug.
- sim-broker-temporal.test.ts has 6 pre-existing failures (option time-value model precision),
  unrelated to this work.
- The quantity linearity tolerance (0.005*qty + 0.005) is mathematically tight. Don't loosen it
  without understanding why a test fails — it probably indicates a real rounding bug.
