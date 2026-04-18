---
paths: data/**, src/db/client.ts, src/db/tick-cache-client.ts, src/db/startup-maintenance.ts, src/lib/channel.ts
---

# data/ — Database & Data Directory

Applies when working with files in `data/` or the DB client/connection layer. For schema definitions, migrations, trade recording, and filters, see the `database-trades` rule (triggers on `src/db/**`, `src/trades/**`, `drizzle/**`).

## Critical Warnings

- **WAL mode on both databases.** `trade-follower.db` and `tick-cache.db` both set `journal_mode = WAL`. Never delete `.db-shm` or `.db-wal` files while the backend is running -- this causes data loss.
- **Databento costs real money.** `tick-cache.db` caches market data fetched from Databento's paid API. Never delete valid cache entries or drop/recreate tick-cache tables without understanding the re-fetch cost.
- **Foreign keys are enforced.** `src/db/client.ts` sets `foreign_keys = ON` and validates it at startup. Raw SQL inserts that violate FK constraints will fail (unlike the SQLite default).
- **Busy timeout is 30 seconds.** `busy_timeout = 30000` means SQLite will wait up to 30s for a lock before throwing `SQLITE_BUSY`. `withBusyRetry()` in `src/db/client.ts` adds an additional retry layer on top of this.

## Data Directory Layout

| File | Purpose | Managed by |
|------|---------|------------|
| `data/trade-follower.db` | Main application database (all tables in `src/db/schema.ts`) | Drizzle ORM via `src/db/client.ts` |
| `data/tick-cache.db` | Databento market data cache | Hand-written DDL in `src/db/tick-cache-client.ts` (not Drizzle-managed) |
| `data/browser-session/` | Chromium session for chat ingestion | Playwright (do not manually edit) |

## Startup Maintenance

`src/db/startup-maintenance.ts` runs automatically on every backend start. It deletes orphaned `trade_events` and clears dangling FK references in `trades` and `run_decisions`. If you see a startup log about "repaired N rows", this is expected cleanup -- not data corruption.

## Channel-based Scoping

All trades, tasks, and decisions are scoped by `channel_id`. Always filter queries by channel -- unscoped queries will mix live, paper, and backtest data.

**Format:** `<broker>:<mode>:<accountId>` for live/paper, `bt:<runId>` for backtests.

**Helpers in `src/lib/channel.ts`:**
- `runtimeChannel(broker, mode, accountId)` -- general-purpose
- `ibkrChannel(mode, accountId)` -- IBKR shortcut
- `liveChannel(accountId)` -- shortcut for `ibkrChannel('live', accountId)`
- `paperChannel(accountId)` -- shortcut for `ibkrChannel('paper', accountId)`
- `btChannel(runId)` -- backtest channel

Do not hand-construct channel ID strings. Use these helpers so the format stays consistent.

## Schema

`src/db/schema.ts` is the authoritative source for all table definitions. Read it directly -- do not rely on stale table listings or column descriptions elsewhere.
