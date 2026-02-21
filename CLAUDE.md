Trade Follower 3

Monorepo: src/ (Node.js backend + backtest engine), web/ (Next.js frontend).
SQLite via Drizzle ORM. Schema: src/db/schema.ts.
Web imports from src/ via relative paths.

Signal flow:
  Chat message → intent extraction (LLM) → Signal → trade agent (skip/execute) → pipeline → broker → record trade
  Key files: src/intents/extract-intent.ts → src/trading/trade-agent.ts → src/pipeline/execute.ts → src/trades/record-trade.ts

Core enums: src/lib/enums.ts is the single source for Direction, Strategy, TradeAction, LegType, LegAction.

Shared utilities:
  src/lib/numbers.ts — safeParseFloat, roundCents, pctDisplay
  src/lib/et-date.ts — all ET timezone / market calendar logic
  src/lib/pnl.ts — computeTradePnl (direction-aware, contract-multiplied)
  src/lib/trade.ts — contractMultiplier, assetType, tradeQty

Position sizing: src/position-sizing/index.ts — discriminated union on strategy field, factory buildPositionSizer(). Currently only ATR strategy. Per-trader config in trackedTraders.positionSizingConfig.

Backtest: runner src/backtest/runner.ts, broker src/backtest/sim-broker.ts, margin src/backtest/margin-model.ts (Reg-T), market data via Databento tape replay.

Trade data model: trades table is a denormalized view. trade_events table is the append-only source of truth. recordTrade() in src/trades/record-trade.ts is the single write path — all mutations go through it, including sim-broker closes.

Rules:
  - Never mass-delete .cache/databento/ files. They cost real money to re-fetch. Empty [] files are valid (weekends/holidays).
  - computeCoreStats() in src/backtest/report.ts is the single source of truth for trade stats. Don't duplicate it.
  - Backtest trades must have explicit timestamps — never fall back to wall-clock time.
  - dayBoundsUTC() dynamically detects EST/EDT. Don't hardcode UTC offsets.
  - Drizzle $type<>() annotations on JSON columns properly narrow types — don't add as casts.

Self-documentation:
  After every implementation session, create a lesson file in docs/lessons/. Mandatory.
  Filename: YYYY-MM-DD-slug.md
  Use plain text, not markdown headers. Keep it scannable and flat.
  Sections (2-3 sentences each): Problem, Decision, Key Files, Watch Out.
  Qualifies: new features, non-obvious bug fixes, architectural decisions, schema changes.
  Doesn't qualify: typos, comments, config tweaks, pure styling.
  Why: the signal pipeline (intent → agent → pipeline → broker → recording) ripples across 3-5 files. Lessons capture the "why" that code comments can't.
