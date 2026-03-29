---
paths: src/db/**, src/trades/**, src/reconciliation/**, drizzle/**, drizzle.config.ts
---

# Database & Trade Recording

## Trade Lifecycle Write Path

`recordTrade()` in `src/trades/record-trade.ts` is the sole entry point for trade lifecycle actions: OPEN, CLOSE, ADD, TRIM, LEG_OFF. It writes to both `trade_events` (append-only source of truth) and `trades` (denormalized view) within a single transaction via `runTx()`.

**Never write lifecycle events outside of `recordTrade()`.**

Supplementary mutations that touch `trades` only (never `trade_events`):
- `enrichTradeWithFill()` in `src/reconciliation/fill-enrichment.ts` -- backfills broker fill data (price, qty, commission, leg fills)
- `FillSweep` in `src/reconciliation/fill-sweep.ts` -- periodic sweep for missed fills and cancel/reject status updates
- `addTradeFlags()` / `stampHasUpdate()` in `src/trades/trade-flags.ts` -- metadata flag management

## Typed JSON Columns

Most JSON columns use the `typedJson<T>()` helper (a Drizzle `customType` defined at the top of `src/db/schema.ts`). This bakes the TS type into the column definition so it propagates through `select()`, `findFirst()`, and partial selects without manual casts.

Two columns on `evalLabels` use an older pattern: `text('col', { mode: 'json' }).$type<EvalLabel>()`. Do not mix patterns -- use `typedJson<T>()` for new columns.

If you find yourself casting the same JSON column at multiple call sites, that means the column should use `typedJson<T>()` instead.

## Composable Filters (filters.ts)

`src/trades/filters.ts` exports composable Drizzle query fragments: `isOpen`, `isClosed`, `isCancelled`, `forChannel()`, `forSymbol()`, `forTrader()`, `forStrategy()`, `forTask()`. Use with `and()`:

```ts
db.select().from(trades).where(and(isOpen, forChannel(channelId), forSymbol('AAPL')))
```

Filters import from `db/schema` only (not `db/client`). These are backend-only -- the web frontend has its own filter UI components and does not import this file.

## Schema & Migrations

`src/db/schema.ts` is the source of truth for all table definitions (SQLite dialect). **NEVER create or edit `.sql` files in `drizzle/` manually** -- hand-written migrations have no matching snapshot JSON and corrupt the snapshot chain, which breaks `db:generate` for all future migrations.

**schema.ts must be self-contained for drizzle-kit.** drizzle-kit loads it via a CJS bundler that cannot resolve relative `../` imports. Runtime values used in schema (e.g. Zod schemas for column validation) must be inlined or imported from npm packages only. Type-only imports (`import type`) are fine since they're erased.

When changing the schema:
1. Edit `src/db/schema.ts`
2. `npm run db:generate` -- generates migration + snapshot via `drizzle-kit generate`
3. `npm run db:migrate` -- applies via `tsx src/db/migrate.ts` (better-sqlite3 migrator)
4. Update any affected types/queries

For custom DDL migrations (e.g. table rebuilds for SQLite column drops): `npm run db:generate -- --custom --name=<name>` scaffolds an empty `.sql` with proper snapshot tracking. Write your SQL in the generated file. This is the **only** case where writing SQL in a migration file is allowed.

**SQLite column constraints survive forever** -- `ALTER TABLE ADD COLUMN` cannot remove constraints from old columns, and SQLite has no `ALTER COLUMN`. When replacing a column, you must eventually rebuild the table via a custom migration to drop the old column, or the old NOT NULL/FK constraints will cause insert failures.

Do not:
- Edit applied `.sql` migrations (checksum mismatch)
- Delete `drizzle/meta/` files (breaks snapshot chain)
- Use `drizzle-kit push` (project uses generate+migrate flow)

## computeCoreStats

`computeCoreStats()` in `src/backtest/report.ts` is the single source of truth for trade statistics (win rate, P&L, drawdown, profit factor, equity curve). Used by both backtest reports and the web dashboard (`src/local-api/routes/web-queries.ts`). Never compute these stats independently.
