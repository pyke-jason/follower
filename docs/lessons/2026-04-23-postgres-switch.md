# Postgres Switch

## Problem

The local app and backtest paths had outgrown a file-backed database. Concurrent backtests could block writes, and the code depended on synchronous transaction behavior that did not match the target database.

## Decision

Use Postgres as the only application database and tick-cache store. Keep Drizzle as the schema/query boundary, use `jsonb` for structured columns, and require async transaction callbacks with `returning()` for mutation paths that need written rows.

## Key Files

- `src/db/client.ts`
- `src/db/schema.ts`
- `src/db/tick-cache-client.ts`
- `src/backtest/tick-cache-postgres-store.ts`
- `drizzle/0000_postgres_baseline.sql`

## Watch Out

Do not add fallback database drivers. Tests should use isolated Postgres schemas so they exercise the same JSONB, transaction, and SQL semantics as the app.
