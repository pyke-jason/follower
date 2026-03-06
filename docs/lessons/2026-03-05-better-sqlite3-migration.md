# Migration: @libsql/client → better-sqlite3

## Problem

`@libsql/client`'s `Sqlite3Client.transaction()` drops its internal `#db` handle after `BEGIN IMMEDIATE`, creating a new Database connection that lacks our `PRAGMA busy_timeout=30000`. This caused `SQLITE_BUSY` errors on any write contention between processes. We had band-aids (`reapplyPragmas`, `withBusyRetry`) that masked the root cause.

## Decision

Switched to `better-sqlite3` which uses a single persistent connection. PRAGMAs set once, never lost.

Key design change: `runTx` now uses drizzle's native synchronous `db.transaction()` instead of manual `BEGIN IMMEDIATE`/`COMMIT`. All drizzle operations inside transactions are synchronous — no `async`/`await` in transaction callbacks.

With the sync driver, drizzle query builders require explicit execution: `.run()` for inserts/updates/deletes, `.all()` for selects. Without these, builders are created but never execute.

## Key Files

- `src/db/client.ts` — Core rewrite. `runTx` is now a thin wrapper around `db.transaction()`.
- `src/db/tick-cache-client.ts` — Same pattern, sync init.
- `src/db/migrate.ts` — Migrator import changed.
- `src/backtest/tick-cache-db.ts` — `LibSQLDatabase` → `BetterSQLite3Database`.
- `src/trades/record-trade.ts` — All `runTx` callbacks synchronous, `.run()`/`.all()` on builders.
- `src/trades/trade-flags.ts` — Same.
- `src/reconciliation/fill-enrichment.ts` — Same.
- `src/reconciliation/fill-sweep.ts` — Same.
- `src/local-api/routes/web-mutations.ts` — Same.
- `src/ingestion/historical.ts` — `.rowsAffected` → `.changes` (better-sqlite3 API).
- `drizzle.config.ts` — Strip `file:` prefix.
- 6 test files — Mocks updated.

## Watch Out

- **No `async` in `runTx` callbacks.** better-sqlite3 throws "Transaction function cannot return a promise". All drizzle ops are sync with this driver.
- **`.run()` and `.all()` are required.** Without `await` to trigger `.then()`, drizzle query builders are inert objects. Forgetting `.run()` means writes silently don't execute.
- **`db.select()` outside transactions still works with `await`** — the builder's `.then()` auto-executes. Only inside sync `runTx` callbacks do you need explicit `.all()`.
- **`result.changes` not `result.rowsAffected`** — better-sqlite3's `RunResult` uses `.changes`.
- **`reapplyPragmas` is deleted.** Any reference to it is a bug.
