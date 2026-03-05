# Channel Scoping: Unified channelId Replaces isBacktest + backtestRunId

Date: 2026-03-04

## Problem

Data isolation between live and backtest used a dual-column pattern: `is_backtest` boolean + nullable `backtest_run_id` FK. This created several issues:

1. **No multi-account support.** Live was a singleton — `isBacktest = false` lumped all live data together. Multiple live accounts (TradeStation + IBKR, or multiple TS accounts) couldn't be distinguished.
2. **Discriminated union scope type (`TradeScope`)** threaded through every function — `{ kind: 'live' }` vs `{ kind: 'backtest', runId }`. Callers had to branch on `.kind` everywhere.
3. **Two filter functions** (`notBacktest` and `forRun(runId)`) with different shapes and semantics.
4. **Schema drift** — `tasks`, `run_decisions`, `backtest_mtm_snapshots` all had their own backtest_run_id columns with slightly different patterns.

## Decision

Replaced everything with a single `channelId: string` column. Format: `bt:<runId>`, `live:<accountId>`, `paper:<accountId>`.

- `TradeScope` discriminated union → plain `string` (the channelId itself)
- `notBacktest` + `forRun(runId)` → single `forChannel(channelId)` filter
- `parseChannel(id)` returns `{ mode: 'bt' | 'live' | 'paper', id: string }` for the rare cases that need mode-specific logic (e.g., auto-skip reconciliation for backtest)
- Helper constructors: `liveChannel(accountId)`, `btChannel(runId)`, `paperChannel(accountId)`
- Factory (`buildPipelineDeps`) receives `scope: string` (the channelId), injects it into `recordTrade` wrapper so callers never pass it

Migration: `drizzle/0023_channel_scoping.sql` adds `channel_id TEXT` to 4 tables, backfills from `backtest_run_id`. Old columns left in place (SQLite can't DROP COLUMN; Drizzle ignores unmapped columns).

## Key Files

- `src/lib/channel.ts` — `parseChannel`, `liveChannel`, `btChannel`, `paperChannel`
- `src/db/filters.ts` — `forChannel(channelId)` replaces `notBacktest` + `forRun`
- `src/db/schema.ts` — `channelId` columns on trades, tasks, runDecisions, backtestMtmSnapshots
- `src/pipeline/build-deps.ts` — Factory takes `scope: string`, auto-derives reconciliation skip from mode
- `src/pipeline/execute-resolved.ts` — `recordTrade` type narrowed to `Omit<RecordTradeInput, 'channelId'>`
- `src/trades/record-trade.ts` — `channelId` required on `RecordTradeInput`, replaces `isBacktest` + `backtestRunId`
- `src/live/runner.ts` — `selectBroker()` returns `{ broker, channelId }` derived from env vars
- `web/lib/queries.ts` — `getLiveChannelId()` derives from `BROKER` + account ID env vars
- `drizzle/0023_channel_scoping.sql` — Migration adding channel_id + backfill

## Watch Out

- **MULTIPLE LIVE CHANNELS**: Never use `NOT LIKE 'bt:%'` as "live scope". Always derive the specific `live:<accountId>` channelId from env vars. The web layer uses `getLiveChannelId()`, the backend uses `selectBroker().channelId`.
- **Web env vars**: `getLiveChannelId()` reads `BROKER` (default 'tradestation') + `TS_ACCOUNT_ID` or `IBKR_ACCOUNT_ID`. These must be set in the Next.js environment.
- **Old columns still in DB**: `is_backtest` and `backtest_run_id` columns remain in SQLite (can't drop). Schema maps ignore them. Don't read from them — they won't be populated for new data.
- **channelId is NOT NULL, no default**: Every insert must provide an explicit `channelId`. There is no bare `'live'` — always `'live:<accountId>'`.
- **RecordTradeInput narrowing**: Pipeline callers pass `Omit<RecordTradeInput, 'channelId'>`. The factory wrapper in `buildPipelineDeps` adds `channelId: scope`. Direct callers of `recordTrade()` (outside pipeline) must pass `channelId` themselves.
