Tick Cache: JSON Files → SQLite Migration

Problem
The Databento tick cache was 708MB across 20,844 JSON files in .cache/databento/ using SHA256-hashed filenames with v2 JSON envelopes and interval-merging range tracking. This meant: no indexing (linear scan + JSON parse on every cache check), no queryability, file-per-symbol-per-day explosion, and atomic write issues.

Decision
Moved to a separate SQLite database at data/tick-cache.db (independent lifecycle from the web server DB). Four tables: quote_ticks (WITHOUT ROWID, composite PK on symbol+dbn_schema+timestamp), tick_cache_ranges (autoincrement, stores merged intervals), chain_definitions (WITHOUT ROWID), chain_cache_meta (sentinel for fetched-but-empty vs never-fetched). In-memory Map<string, TickCacheData> hot cache stays — DB replaces disk as the persistence layer. The lookup path is: memory → DB → API.

Also upgraded drizzle-orm from 0.45.1 to 1.0.0-beta.15. Breaking change: drizzle() constructor now takes { client, schema } object instead of positional args. New drizzle-orm/zod exports createSelectSchema/createInsertSchema (replaces drizzle-zod package).

Key Files
  src/db/tick-cache-schema.ts — Drizzle table definitions + Zod schemas + inferred types
  src/db/tick-cache-client.ts — libsql client, PRAGMAs, hand-written DDL (WITHOUT ROWID), exports tickCacheDb
  src/backtest/tick-cache-db.ts — DB access layer: readCachedRanges, readCachedTicks, writeCachedTicks, loadCachedChain, saveCachedChain
  src/backtest/market-data.ts — Updated ensureRange/ensureRangeBatch: memory → DB → API flow
  src/backtest/databento-tape.ts — Removed all file cache code (CACHE_DIR, readTickCache, writeTickCache, getSymbolCachePath, CacheEnvelope). Kept: QuoteTick, mergeRanges, isRangeCovered, fetchTickWindow, loadChainDefinitions (now uses DB).
  src/backtest/runner.ts — Injects tickCacheDb into DatabentoMarketDataProvider constructor
  scripts/migrate-tick-cache-to-db.ts — One-shot migration script

Watch Out
  dbn_schema is part of the quote_ticks PK because the same symbol can have ohlcv-1m and ohlcv-1d records. Without it in the PK, minute bars and daily bars would collide. The in-memory cache uses "symbol:schema" keys for the same reason.
  The migration script skips 1,797 bare OHLCV files (old v1 format without envelope metadata) and 18 chain definition files (can't recover parent/day from hashed filenames). Chain defs re-fetch on demand. Old cache data in those bare files is lost but was mostly superseded by v2 entries.
  The libsql drizzle driver in 1.0.0-beta is fully async — all .all(), .get(), .run(), .transaction() return Promises.
  The .cache/databento/ directory still exists with the original JSON files. Safe to delete after confirming backtests run correctly against the DB.
