Per-trader position sizing exposed in UI

Problem:
  Position sizing config (riskPercent, atrMultiplier, atrPeriod) existed in the DB schema but had zero UI. Only settable via seed data or direct DB edits. The backtest runner hardcoded null for all traders (5% default) while the live runner correctly read per-trader configs.

Decision:
  Exposed only riskPercent in the trader roster as an inline editable column. ATR-specific params (atrMultiplier, atrPeriod) are deliberately hidden — ATR strategy is behind a discriminated union + factory (buildPositionSizer), making it cleanly replaceable with zero UI changes. Fixed the backtest runner to do per-trader config lookup (matching the live runner pattern).

Key files:
  web/app/traders/actions.ts — added setRiskPercent server action (reads existing config to preserve ATR params)
  web/app/traders/trader-roster.tsx — added Risk % column with inline number input, optimistic updates
  src/backtest/runner.ts — changed from global buildPositionSizer(null, ...) to per-trader lookup via getTrader()

Watch out:
  Risk % displays as human-friendly percentage (e.g. "2.0") but stores as decimal (0.02). Conversion happens in RiskPercentCell.
  buildPositionSizer(null, ...) returns the default (5% risk, 2x ATR, 14 period). Clearing the field → null → system default. No separate "default" value stored.
