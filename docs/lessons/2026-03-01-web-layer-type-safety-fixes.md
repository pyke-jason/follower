# Web Layer Type Safety Fixes

2026-03-01

## Problem

Five type safety issues in the web layer identified during `hasSubsequentMessage` threading work. See `docs/web-layer-type-safety-issues.md` for the original analysis.

## Decisions

### 1. Drizzle pinned to stable 0.45.1

Root `package.json` had `drizzle-orm@^1.0.0-beta.15` while web had `^0.45.1`. Beta breaks `getTableColumns()` spread inference, causing 300+ phantom type errors and requiring a `SAFETY` double-cast in `getOpenTrades()`.

Pinned root to `drizzle-orm@^0.45.1` / `drizzle-kit@^0.31.9`. Removed dead `drizzle-orm/zod` import from `tick-cache-schema.ts` (unused Zod schemas, beta-only module path).

### 2. startingEquity now required on BacktestRunConfig

Removed `?` from `startingEquity` in `BacktestRunConfig`. Both creation sites (CLI `launch.ts`, web `actions.ts`) already defaulted to `DEFAULT_STARTING_EQUITY` — now enforced by the type. Deleted three `?? 100_000` magic number fallbacks.

### 3. commissionSchedule now required on BacktestRunConfig

Same treatment. Both creation sites now always build a `CommissionSchedule` using `DEFAULT_COMMISSION_SCHEDULE` for any omitted values. `generateReportFromTrades` param also made required. Cancelled-run report path simplified from `cancelledConfig?.commissionSchedule` guessing to direct config access.

### 4. Deduplicated EXISTS subquery

Extracted `subsequentMessageExists` constant in `queries.ts`. Used by both `hasSubsequentMessage` (SELECT column for open trades) and `getTradesWithSubsequentMessages()` (WHERE clause for closed trades batch). Single source of truth for the SQL logic.

### 5. SQLite boolean 0/1 fix

Changed `{t.hasSubsequentMessage && ...}` to `{!!t.hasSubsequentMessage && ...}` in open trades page. SQLite returns `0`/`1` not `true`/`false` — without `!!`, JSX `&&` renders `0` as visible text.

## Key Files

- `package.json` — drizzle version pins
- `src/db/schema.ts:337,345` — required fields
- `src/config/risk-defaults.ts` — DEFAULT_STARTING_EQUITY, DEFAULT_COMMISSION_SCHEDULE
- `src/backtest/launch.ts` — CLI config assembly
- `src/backtest/runner.ts:150` — removed fallback
- `src/backtest/report.ts:256` — required param
- `src/backtest/extended-metrics.test.ts` — added commissionSchedule to all test calls
- `src/db/tick-cache-schema.ts` — removed dead drizzle-orm/zod imports
- `web/app/backtests/actions.ts` — always provides both fields
- `web/app/backtests/[id]/page.tsx` — removed ?? fallbacks
- `web/app/backtests/[id]/backtest-trades-table.tsx` — required prop
- `web/lib/queries.ts` — shared SQL constant, removed SAFETY cast
- `web/app/trades/open/page.tsx:63` — !! boolean fix
- `web/stores/trades-store.ts` — store types unchanged (still nullable for live trades path)

## Watch Out

- Old backtest runs in the DB may have configs without `startingEquity`/`commissionSchedule`. The `getConfig()` accessor does `as BacktestRunConfig` — old data will have `undefined` at runtime despite required types. Per NO BACKWARDS COMPATIBILITY rule, this is accepted.
- Store `startingEquity`/`commissionSchedule` remain nullable because the live trades page (`web/app/trades/page.tsx`) doesn't have a backtest config to source them from.
- `computeCoreStats` and `computeTradeCommission` still accept optional `CommissionSchedule` — they're shared utilities used in non-backtest contexts too.
