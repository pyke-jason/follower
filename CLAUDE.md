Trade Follower 3

Monorepo: src/ (Node.js backend + backtest engine), web/ (Next.js frontend).
SQLite via Drizzle ORM. Schema: src/db/schema.ts.
Web imports from src/ via relative paths.

Signal flow:
  Chat message → intent extraction (LLM) → Signal → trade agent (skip/execute) → pipeline → broker → record trade
  Key files: src/intents/extract-intent.ts → src/trading/trade-agent.ts → src/pipeline/execute.ts → src/trades/record-trade.ts

Shared utilities live in src/lib/. If something is used by more than one module, it goes here — not inline, not duplicated.
  src/lib/numbers.ts — safeParseFloat (null-safe string→number), roundCents, round(val, decimals), pctDisplay (0.5 → "50.0%"), priceEq (epsilon comparison)
  src/lib/et-date.ts — toDateKeyET (Date→"YYYY-MM-DD" in ET), dayBoundsUTC (ET day→UTC start/end), isTradingDay, isMarketHours, marketCloseMinute (handles early closes), getETComponents, MARKET_HOLIDAYS, MARKET_EARLY_CLOSES. All DST-aware.
  src/lib/pnl.ts — computeTradePnl: direction-aware, contract-multiplied PnL from entry/exit/qty/strategy. Throws on NaN. Single source of truth.
  src/lib/trade.ts — contractMultiplier (STOCK=1, options=100), assetType (EQ/OP), tradeQty (null→1 fallback for legacy rows)
  src/lib/enums.ts — Zod schemas for Direction, Strategy, TradeAction (OPEN/CLOSE/ADD/TRIM/LEG_OFF), LegType, LegAction. Single source for all trading enums.
  src/broker/order-schemas.ts — Zod schemas for OrderParams, WorkingOrderParams, OrderResult. Cross-field constraints via .refine(): LIMIT orders require limitPrice, FILLED results require filledPrice + fillTimestamp. Parsed at boundaries (OrderManager.submitOrder, OrderManager.tick, pipeline placeOrder).
  src/trades/filters.ts — composable Drizzle query fragments (isOpen, isClosed, forSymbol, forTrader, forStrategy, PositionFilters type). Imports from db/schema (not db/client) so the web layer can use it without pulling in native libsql.

Backtest vs live — shared infrastructure:
  Both paths wire up the same PipelineDeps interface (src/pipeline/execute.ts) with different implementations:
    broker:              SimBroker (backtest) vs TradeStation liveService (live)
    getOpenPositions:    broker.getOpenTrades (backtest, scoped to run) vs direct DB query (live, scoped to notBacktest)
    calculatePositionSize: both use buildPositionSizer() from src/position-sizing/index.ts with per-trader config
    checkRiskLimits:     no-op in backtest (agent pre-checks) vs full risk check in live
    recordTrade:         same function (src/trades/record-trade.ts), backtest adds backtestRunId + isBacktest flag
  Shared code that MUST stay identical across both paths:
    - recordTrade() — single write path for trades + trade_events
    - executeSignals() / executeSignal() — deterministic pipeline, no backtest-specific branches
    - computeTradePnl() — used by recordTrade and report
    - buildPositionSizer() — same factory, per-trader config
    - filters.ts — same composable fragments for position queries
  If you add a feature to one path, check whether the other path needs it too.

Position sizing: src/position-sizing/index.ts — discriminated union on strategy field, factory buildPositionSizer(). Currently only ATR strategy. Per-trader config in trackedTraders.positionSizingConfig.

Trade data model: trades table is a denormalized view. trade_events table is the append-only source of truth. recordTrade() in src/trades/record-trade.ts is the single write path — all mutations go through it, including sim-broker closes. When the caller already knows which trade to target, pass tradeId to skip the redundant scope-filter query.

Rules:
  - Validate at the boundary, not in orchestration. Cross-field constraints (e.g. LIMIT→limitPrice, FILLED→filledPrice+fillTimestamp) belong in Zod .refine() schemas parsed at entry points, not as ad-hoc throws deep in business logic. Pattern: Signal schemas (agent/schemas.ts), order schemas (broker/order-schemas.ts), API response schemas (broker/schemas.ts).
  - When a callback only fires in a narrowed state, type the callback with the narrowed type. Example: onFill receives FilledWorkingOrder (filledPrice: number) not WorkingOrder (filledPrice?: number). This eliminates ! assertions in every consumer.
  - Databento charges per byte transferred. Minimize data fetched: request only the columns/fields needed, use the narrowest date ranges possible, prefer cached data, and avoid redundant API calls. Never mass-delete .cache/databento/ files — they cost real money to re-fetch. Empty [] files are valid (weekends/holidays).
  - computeCoreStats() in src/backtest/report.ts is the single source of truth for trade stats. Don't duplicate it.
  - Backtest trades must have explicit timestamps — never fall back to wall-clock time.
  - dayBoundsUTC() dynamically detects EST/EDT. Don't hardcode UTC offsets.
  - Drizzle $type<>() annotations on JSON columns properly narrow types — don't add as casts.
  - No inline type imports. Never use `import('path').Type` in type annotations — always use a top-level `import type { Type } from 'path'`. Inline imports are unreadable and hide dependencies.
  - NO backwards compatibility. Ever. No optional fields for "older runs", no migration shims, no deprecated re-exports, no _unused vars. If a type changes, update all producers and consumers. This is an internal tool — there are no external clients to support.

Debugging: use disposable test scripts.
  When diagnosing issues, create temporary .ts scripts in scripts/ that directly call codebase components with real data.
  Flow: observe DB state → hypothesize → write a script that isolates the suspect component → verify fix → delete script.
  Use real data (actual DB records, actual cache files, actual configs), not mocks. Run with `npx tsx scripts/debug-xxx.ts`.
  The .env file has secrets to use for making real API calls. e.g. DATABENTO_API_KEY. NEVER READ the file directly.
  Clean up temp scripts after the fix is verified.

Self-documentation:
  After every implementation session, create a lesson file in docs/lessons/. Mandatory.
  Filename: YYYY-MM-DD-slug.md
  Use plain text, not markdown headers. Keep it scannable and flat.
  Sections (2-3 sentences each): Problem, Decision, Key Files, Watch Out.
  Qualifies: new features, non-obvious bug fixes, architectural decisions, schema changes.
  Doesn't qualify: typos, comments, config tweaks, pure styling.
  Why: the signal pipeline (intent → agent → pipeline → broker → recording) ripples across 3-5 files. Lessons capture the "why" that code comments can't.
