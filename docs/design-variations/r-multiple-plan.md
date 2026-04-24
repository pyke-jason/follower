# Algorithmic Trade Quality + R-Multiple Plan

_Status: in-flight implementation as of 2026-04-24._

## Summary
Add R-multiple and quality analytics without any manual grading, manual risk entry, or feedback workflow. The feature is entirely derived from existing trade data: entry/exit prices, quantity, legs, strategy, lifecycle events, metadata flags, slippage, and chase data.

Trades without defensible finite risk are excluded from R calculations and reported in coverage instead of being manually filled in.

## Key Changes
- Add a pure trade risk model that computes finite risk from trade structure:
  - Long calls/puts: premium paid.
  - Debit spreads: debit paid.
  - Credit spreads: spread width minus credit received.
  - Stock and unbounded short/naked positions: no true R unless finite risk is structurally known.
- Store computed risk in trade metadata at lifecycle write time through `recordTrade()`:
  - Preserve `peakRisk` across `ADD`, `TRIM`, `LEG_OFF`, and `CLOSE`.
  - Use `peakRisk` as the denominator for closed-trade R.
- Add a pure quality model:
  - `rMultiple = pnl / peakRisk` when finite risk exists.
  - Score is algorithmic only, based on outcome, execution quality, process flags, and sizing vs median finite-risk trade.
  - Grade is derived from score, with reason chips like `+1.8R`, `slippage`, `chase`, `oversized`, `close failed`.
- Add a quality summary API for dashboard/performance UI:
  - risk coverage
  - R distribution
  - grade distribution
  - flag frequency
  - strategy breakdown with P&L and average R
  - optional closed-trade rows with computed quality fields

## UI Plan
- Add a compact `QualitySnapshotPanel` to the dashboard, not the full dense terminal layout.
- Show:
  - R distribution
  - grade distribution
  - finite-risk coverage
  - most common quality/process flags
- Build the full dense analytics layout later as a dedicated `/quality` or `/performance` page using existing `DataTable`, `QueryBoundary`, format helpers, and `TradeDetailPanel`.

## Test Plan
- Unit-test risk math for long options, debit spreads, credit spreads, stock, naked/unbounded, and malformed legs.
- Unit-test lifecycle preservation of `peakRisk` through `OPEN`, `ADD`, `TRIM`, `LEG_OFF`, and `CLOSE`.
- Unit-test quality scoring and grade buckets from synthetic trades with slippage/chase/flags.
- API tests for coverage counts, R buckets, grade buckets, and strategy summaries.
- Frontend check/build plus `/verify` after implementation.

## Assumptions
- No manual grading UI.
- No manual risk-entry workflow.
- No training/feedback dataset.
- No quality override field.
- Trades with unknown or unbounded risk show `--` for R and are excluded from R distribution.
- Coverage is first-class so missing R data is visible rather than hidden.
