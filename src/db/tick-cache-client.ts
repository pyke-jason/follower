import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as tickCacheSchema from './tick-cache-schema.js';
import { PATHS } from '../lib/paths.js';

mkdirSync(dirname(PATHS.tickCacheDb), { recursive: true });

const sqlite = new Database(PATHS.tickCacheDb);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 30000');

// Hand-written DDL — WITHOUT ROWID for composite-PK tables (faster lookups, smaller on disk).
// tick_cache_ranges uses regular CREATE TABLE (has AUTOINCREMENT rowid).
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS quote_ticks (
    symbol TEXT NOT NULL,
    dbn_schema TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    bid REAL NOT NULL,
    ask REAL NOT NULL,
    open REAL,
    close REAL,
    volume INTEGER,
    PRIMARY KEY (symbol, dbn_schema, timestamp)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_qt_symbol_schema
    ON quote_ticks (symbol, dbn_schema);

  CREATE TABLE IF NOT EXISTS tick_cache_ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset TEXT NOT NULL,
    dbn_schema TEXT NOT NULL,
    symbol TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tcr_dataset_schema_symbol
    ON tick_cache_ranges (dataset, dbn_schema, symbol);

  CREATE TABLE IF NOT EXISTS chain_definitions (
    dataset TEXT NOT NULL,
    parent_symbol TEXT NOT NULL,
    day TEXT NOT NULL,
    raw_symbol TEXT NOT NULL,
    expiry TEXT NOT NULL,
    strike REAL NOT NULL,
    call_put TEXT NOT NULL,
    PRIMARY KEY (dataset, parent_symbol, day, raw_symbol)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_cd_dataset_parent_day
    ON chain_definitions (dataset, parent_symbol, day);

  CREATE TABLE IF NOT EXISTS chain_cache_meta (
    dataset TEXT NOT NULL,
    parent_symbol TEXT NOT NULL,
    day TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (dataset, parent_symbol, day)
  ) WITHOUT ROWID;
`);

export const tickCacheDb = drizzle(sqlite, { schema: tickCacheSchema });
export { tickCacheSchema };
export { sqlite as tickCacheSqliteClient };
