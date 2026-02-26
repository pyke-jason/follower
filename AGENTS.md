# AGENTS.md — Trade Follower

## What This Is

An autonomous trade-copy system that monitors a live trading chat room, classifies messages using an AI agent, and mirrors trades via a broker API — with full backtesting, evaluation, and a dashboard.

**Pipeline:** Chat Message → Parse → Task → Claude Agent → Trade Execution → Reconciliation

## Tech Stack

- **Runtime:** TypeScript (ESM), Node.js, tsx
- **Database:** SQLite via Drizzle ORM (`data/trade-follower.db`)
- **AI:** Anthropic Claude SDK (primary), xAI Grok (secondary) — tool-use agent loop
- **Broker:** TradeStation REST API (OAuth2)
- **Market Data:** Databento API (historical quotes for backtesting)
- **Ingestion:** Playwright + SignalR (OneOption chat room)
- **Frontend:** Next.js 15 + React 19, Tailwind 4, shadcn/ui (new-york style, zinc base)
- **API:** Hono (local REST API for backtest management)
- **Alerts:** Discord webhooks, Pushover push notifications, Healthchecks.io
- **Secrets:** macOS Keychain (primary), .env (fallback)
- **Daemon:** macOS LaunchD (auto-restart, sleep prevention)

## Directory Structure

```
src/
├── index.ts                    # Main entry: ingestion + task runner + reconciliation
├── agent/
│   ├── trade-agent.ts          # Claude agent system prompt + runner
│   ├── agent-loop.ts           # Generic tool-use loop
│   ├── tool-factory.ts         # Build tools for agent (broker, sizing, risk)
│   ├── providers/              # LLM provider abstraction (anthropic, xai)
│   └── schemas.ts              # Zod schemas for agent decisions
├── backtest/
│   ├── runner.ts               # Orchestrates backtest: load msgs → execute → report
│   ├── deterministic-executor.ts  # Fast path for high-confidence trades (≥70%)
│   ├── sim-broker.ts           # Simulated broker with fill models
│   ├── position-tracker.ts     # In-memory position state machine
│   ├── market-data.ts          # Databento quote provider with caching
│   ├── databento-tape.ts       # Raw tick loading from Databento API
│   ├── occ-symbology.ts        # OCC option symbol format (21-char)
│   ├── report.ts               # P&L, Sharpe, Sortino, equity curve
│   ├── launch.ts               # CLI entry for backtests
│   └── types.ts                # BacktestConfig, FillModel, etc.
├── broker/
│   ├── tradestation.ts         # TradeStation API client (quotes, orders, positions)
│   ├── auth.ts                 # OAuth2 token refresh
│   ├── interface.ts            # BrokerService interface
│   └── types.ts                # Quote, Order, Fill, WorkingOrder types
├── db/
│   ├── schema.ts               # Source of truth — all tables defined here
│   ├── client.ts               # Drizzle client setup
│   └── migrate.ts              # Migration runner
├── ingestion/
│   ├── browser.ts              # Playwright: launch, login, session persistence
│   ├── signalr.ts              # SignalR hub: real-time message stream
│   ├── ingest.ts               # Orchestrator: browser + signalr + storage
│   └── historical.ts           # Backfill messages via search API
├── parsing/
│   ├── classify.ts             # Message → parsed classification (badges, symbols, strategy)
│   ├── html.ts                 # Raw HTML → clean text
│   ├── badges.ts               # Extract trade signal badges
│   ├── symbols.ts              # Extract ticker symbols
│   └── strategy.ts             # Regex-based strategy detection (CDS, PDS, etc.)
├── tasks/
│   ├── factory.ts              # Message → Task (EXECUTE_TRADE or REVIEW_MESSAGE)
│   ├── runner.ts               # Poll pending tasks, dispatch to agent, record trades
│   └── recorder.ts             # Write steps + results + fill enrichment to DB
├── orders/
│   └── risk-check.ts           # Pre-trade risk limits (max positions, drawdown, notional)
├── position-sizing/
│   ├── index.ts                # Sizing service factory
│   └── atr.ts                  # ATR-based position sizing (14-period, 2x stop)
├── reconciliation/
│   └── index.ts                # ReconciliationScheduler, FillSweep, balance capture
├── local-api/
│   └── server.ts               # Hono API (backtest CRUD, logs, health)
├── lib/
│   ├── alert.ts                # Discord + Pushover alerts (never throws)
│   ├── resilient.ts            # Retry with exponential backoff + error classification
│   ├── secrets/                # Keychain + .env provider pattern
│   ├── zod-financial.ts        # Price, quantity, percentage Zod schemas
│   ├── logger.ts               # Tagged, level-filtered logging
│   ├── numbers.ts              # safeParseFloat, roundCents, pctDisplay
│   ├── healthcheck.ts          # Healthchecks.io ping (60s interval)
│   ├── paths.ts                # Project path constants
│   └── pidlock.ts              # PID-based process locking
└── config/
    └── traders.ts              # Trader whitelist + per-trader settings

web/
├── app/
│   ├── layout.tsx              # Root: dark mode, SidebarProvider, RunScopeProvider
│   ├── page.tsx                # Dashboard: stats, open trades, equity curve, signals
│   ├── backtests/
│   │   ├── page.tsx            # Backtest list with compare, pin, experiment tags
│   │   ├── new/page.tsx        # Launch new backtest
│   │   ├── [id]/page.tsx       # Backtest detail: metrics, equity curve, trades
│   │   └── compare/page.tsx    # Side-by-side backtest comparison
│   ├── traders/[name]/page.tsx # Trader deep-dive: P&L, strategy breakdown, curve
│   ├── trades/[id]/page.tsx    # Trade detail: steps, fills, slippage, partial exits
│   ├── tasks/[id]/page.tsx     # Task audit trail: agent steps, tool calls
│   ├── reconciliation/page.tsx # Position mismatch alerts (DB vs broker)
│   ├── settings/page.tsx       # Secrets, toggles (ingestion, Discord, Pushover)
│   └── components/             # Sidebar, TopBar, Badge, charts, RunScopeSelector
├── lib/
│   ├── db.ts                   # Drizzle client (imports schema from src/db/schema)
│   ├── queries.ts              # All DB queries (stats, trades, messages, labels, etc.)
│   ├── format.ts               # formatCurrency, formatDate, formatPnl
│   └── run-scope.ts            # ?run= URL scoping for backtest context
└── components/ui/              # shadcn/ui primitives (button, card, table, dialog, etc.)
```

## Database Tables

| Table | Purpose |
|-------|---------|
| `messages` | Ingested chat messages with parsed badges, symbols, action/direction hints |
| `message_labels` | Ground truth labels for eval (action, direction, strategy, strikes, expiry) |
| `tasks` | Agent tasks: PENDING → IN_PROGRESS → COMPLETED/FAILED |
| `trades` | Open/closed trades with entry/exit price, P&L, broker fills, legs |
| `tracked_traders` | Whitelist of traders to copy with position sizing config |
| `backtest_runs` | Test runs with config, summary metrics, equity curve |
| `run_decisions` | Per-message agent decisions during backtests (EXECUTE/SKIP + reasoning) |
| `daily_balances` | Daily account snapshots (equity, cash, P&L) |
| `reconciliation_alerts` | Position mismatches between DB and broker |
| `eval_runs` | Accuracy metrics per eval run (action, direction, strategy, price) |
| `historical_fetch_runs/chunks` | Tracking for bulk message backfills |

## Key Concepts

### Trade Agent
The Claude agent receives a chat message and tools (get_quote, get_options_chain, get_open_positions, calculate_position_size, check_risk_limits, place_order, flag_for_review). It classifies the message, validates against market data, sizes the position, and outputs a JSON decision: EXECUTE, SKIP, or MANUAL_REVIEW.

### Dual Execution Paths (Backtest)
- **Deterministic (≥70% confidence):** Regex-parsed, no LLM call. Fast and free.
- **Agent (<70% confidence):** Full Claude agent loop with tools. Budget-limited.

### Strategies
- **STOCK:** Direct equity trades
- **CALL/PUT:** Single-leg options
- **CDS:** Call Debit Spread (buy lower strike call, sell higher)
- **PDS:** Put Debit Spread (buy higher strike put, sell lower)
- **PCS:** Put Credit Spread

### Position Lifecycle
OPEN → ADD (increases quantity, recalc avg price) → TRIM (partial close, tracks remainingPercent) → CLOSE (full exit, compute P&L)

### Fill Models (Backtesting)
- **ORATS:** Realistic fill estimate based on bid-ask width and leg count
- **Midpoint:** (bid + ask) / 2
- **Natural:** Buy at ask, sell at bid (worst case)

### Run Scoping
The dashboard supports `?run=<backtestRunId>` to view any page filtered to a specific backtest's data. Live mode shows only non-backtest trades.

## NPM Scripts

```bash
npm run dev              # Start backend (ingestion + agent + reconciliation)
npm run web              # Start Next.js dashboard on :3000
npm run local-api        # Start Hono API on :4000
npm run backtest         # Launch backtest (tsx src/backtest/launch.ts)
npm run db:generate      # Generate Drizzle migrations
npm run db:migrate       # Apply migrations
npm run secrets:import   # Import .env keys to macOS Keychain
npm run test             # Vitest
```

## Environment Variables

### Required
- `ANTHROPIC_API_KEY` — Claude API
- `TS_CLIENT_ID`, `TS_CLIENT_SECRET`, `TS_ACCOUNT_ID`, `TS_REFRESH_TOKEN` — TradeStation

### Optional
- `DATABENTO_API_KEY` — Historical market data (backtesting)
- `XAI_API_KEY` — Grok alternative provider
- `ONE_OP_EMAIL`, `ONE_OP_PASS` — Chat room login
- `DISCORD_WEBHOOK_URL` — Alert notifications
- `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY` — Mobile push
- `HEALTHCHECK_PING_URL` — Uptime monitoring
- `DATABASE_URL` — Override SQLite path
- `LIVE_INGESTION_ENABLED=0` — Disable browser ingestion

## Conventions

- Schema is the source of truth: `src/db/schema.ts`
- Web imports schema directly from `../../src/db/schema` via path aliases
- Prices stored as text in DB (SQLite has no decimal type)
- All timestamps are ISO 8601 strings
- Agents never throw on alerting/monitoring failures
- Retry logic classifies errors: auth → 2 retries, transient → exponential backoff, permanent → fail immediately
- Position sizing uses ATR-based approach: 5% equity risk per trade, 2x ATR stop loss
- Risk limits: max 20 open positions, max 3 per symbol, 5% daily drawdown stop, 2x equity notional cap
