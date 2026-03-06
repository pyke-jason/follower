---
paths: src/db/**, src/trades/**, drizzle/**, drizzle.config.ts
---

# Database & Trade Recording

## Trade Lifecycle Write Path

`recordTrade()` in `src/trades/record-trade.ts` handles the core trade lifecycle: OPEN, CLOSE, ADD, TRIM, and LEG_OFF. It writes to both `trade_events` (append-only source of truth) and `trades` (denormalized view).

Supplementary mutations exist outside `recordTrade()` for non-lifecycle concerns: `enrichTradeWithFill()` (broker fill enrichment), fill-sweep (cancel/reject status), `addTradeFlags()`/`stampHasUpdate()` (metadata flags). These touch `trades` only — never `trade_events`.

Never write lifecycle events (OPEN/CLOSE/ADD/TRIM/LEG_OFF) outside of `recordTrade()`.

## JSON Column Accessors

Drizzle's `$type<>()` does NOT propagate through `select()`. For JSON columns that are cast repeatedly, create a typed accessor in `src/db/accessors.ts`. Cast/parse happens **once** inside the accessor. If you find yourself writing the same `as X` cast at multiple call sites, extract an accessor.

## Composable Filters (filters.ts)

`src/trades/filters.ts` exports composable Drizzle query fragments for common queries (e.g., `isOpen`, `isClosed`, `forChannel()`, `forSymbol()`, `forTrader()`). Check the file for the complete list of available filters.

Filters import from `db/schema` only (not `db/client`) for web compatibility. The web frontend imports these filters directly.

## Schema & Migrations

`src/db/schema.ts` is the source of truth for all table definitions (SQLite dialect). **NEVER create or edit `.sql` files in `drizzle/` manually** — hand-written migrations have no matching snapshot JSON and corrupt the snapshot chain, which breaks `db:generate` for all future migrations.

**schema.ts must be self-contained for drizzle-kit.** drizzle-kit loads it via a CJS bundler that cannot resolve relative `../` imports. Runtime values used in schema (e.g. Zod schemas for column validation) must be inlined or imported from npm packages only. Type-only imports (`import type`) are fine since they're erased.

When changing the schema:
1. Edit `src/db/schema.ts`
2. `npm run db:generate` — generates migration + snapshot via `drizzle-kit generate`
3. `npm run db:migrate` — applies via `tsx src/db/migrate.ts` (libsql migrator)
4. Update any affected accessors in `src/db/accessors.ts`
5. Update any affected types/queries

For data-only or custom DDL migrations (e.g. table rebuilds for SQLite column drops): `npm run db:generate -- --custom --name=<name>` scaffolds an empty `.sql` with proper snapshot tracking. Write your SQL in the generated file. This is the **only** case where writing SQL in a migration file is allowed.

**SQLite column constraints (NOT NULL, FK) survive forever** — `ALTER TABLE ADD COLUMN` in SQLite cannot remove constraints from old columns, and SQLite has no `ALTER COLUMN` or `DROP COLUMN` (for older versions). When replacing a column (e.g. `backtest_run_id` → `channel_id`), you must eventually rebuild the table via a custom migration to drop the old column, or the old NOT NULL/FK constraints will cause insert failures.

Don't edit applied `.sql` migrations (checksum mismatch). Don't delete `drizzle/meta/` files. Don't use `drizzle-kit push` (project uses generate+migrate flow).

## computeCoreStats

`computeCoreStats()` is the single source of truth for trade statistics (win rate, P&L, drawdown, etc.). Used by both backtest reports and the web dashboard. Don't compute stats independently — use this function.
