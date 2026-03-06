# data/ — Database Context

Applies when working with files in `data/` or querying SQLite databases.

## Critical Warnings

- **WAL mode**: `trade-follower.db` uses WAL mode — never delete `.db-shm`/`.db-wal` while the backend runs.
- **Databento costs money**: `tick-cache.db` is a market data cache that charges per byte fetched. Never delete valid cache entries.

## Channel-based Scoping

Trades, tasks, and decisions are scoped by `channel_id`. Format: `<broker>:<mode>:<accountId>` for live/paper (e.g. `ibkr:live:U14368257`, `tradestation:live:12345678`) or `bt:<runId>` for backtests. See `src/lib/channel.ts` for helpers (`liveChannel`, `btChannel`, `paperChannel`).

## Schema

`src/db/schema.ts` is the authoritative source for all table definitions. Read it directly — don't rely on stale table listings.

`src/db/tick-cache-client.ts` has hand-written DDL for tick-cache.db (not Drizzle-managed).
