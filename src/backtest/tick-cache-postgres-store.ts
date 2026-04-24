import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as tickCachePgSchema from '../db/tick-cache-pg-schema.js';
import {
  pgChainCacheMeta,
  pgChainDefinitions,
  pgQuoteTicks,
  pgTickCacheRanges,
} from '../db/tick-cache-pg-schema.js';
import type { ChainDefinition, QuoteTick } from './databento-tape.js';
import { mergeRanges } from './databento-tape.js';
import type { TickCacheStore } from './tick-cache-store.js';

type PostgresTickCacheDB = NodePgDatabase<typeof tickCachePgSchema>;

const BATCH_SIZE = 500;

export class PostgresTickCacheStore implements TickCacheStore {
  constructor(private db: PostgresTickCacheDB) {}

  readCachedRanges(dataset: string, dbnSchema: string, symbol: string): Promise<[number, number][]> {
    return readCachedRanges(this.db, dataset, dbnSchema, symbol);
  }

  readCachedTicks(symbol: string, dbnSchema: string): Promise<QuoteTick[]> {
    return readCachedTicks(this.db, symbol, dbnSchema);
  }

  writeCachedTicks(
    dataset: string,
    dbnSchema: string,
    symbol: string,
    ticks: QuoteTick[],
    range: [number, number],
  ): Promise<boolean> {
    return writeCachedTicks(this.db, dataset, dbnSchema, symbol, ticks, range);
  }

  loadCachedChain(dataset: string, parentSymbol: string, day: string): Promise<ChainDefinition[] | null> {
    return loadCachedChain(this.db, dataset, parentSymbol, day);
  }

  saveCachedChain(
    dataset: string,
    parentSymbol: string,
    day: string,
    defs: ChainDefinition[],
  ): Promise<boolean> {
    return saveCachedChain(this.db, dataset, parentSymbol, day, defs);
  }
}

export async function initializePostgresTickCacheSchema(db: PostgresTickCacheDB): Promise<void> {
  // Drizzle schema objects do not create tables at runtime, so initialization DDL stays isolated here.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS quote_ticks (
      symbol text NOT NULL,
      dbn_schema text NOT NULL,
      timestamp bigint NOT NULL,
      bid double precision NOT NULL,
      ask double precision NOT NULL,
      open double precision,
      close double precision,
      volume bigint,
      PRIMARY KEY (symbol, dbn_schema, timestamp)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_pg_qt_symbol_schema
      ON quote_ticks (symbol, dbn_schema)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tick_cache_ranges (
      id serial PRIMARY KEY,
      dataset text NOT NULL,
      dbn_schema text NOT NULL,
      symbol text NOT NULL,
      start_ms bigint NOT NULL,
      end_ms bigint NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_pg_tcr_dataset_schema_symbol
      ON tick_cache_ranges (dataset, dbn_schema, symbol)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS chain_definitions (
      dataset text NOT NULL,
      parent_symbol text NOT NULL,
      day text NOT NULL,
      raw_symbol text NOT NULL,
      expiry text NOT NULL,
      strike double precision NOT NULL,
      call_put text NOT NULL,
      PRIMARY KEY (dataset, parent_symbol, day, raw_symbol)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_pg_cd_dataset_parent_day
      ON chain_definitions (dataset, parent_symbol, day)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS chain_cache_meta (
      dataset text NOT NULL,
      parent_symbol text NOT NULL,
      day text NOT NULL,
      fetched_at text NOT NULL,
      PRIMARY KEY (dataset, parent_symbol, day)
    )
  `);
}

/** Read all cached ranges for a given dataset/schema/symbol. */
async function readCachedRanges(
  db: PostgresTickCacheDB,
  dataset: string,
  dbnSchema: string,
  symbol: string,
): Promise<[number, number][]> {
  const rows = await db
    .select({ startMs: pgTickCacheRanges.startMs, endMs: pgTickCacheRanges.endMs })
    .from(pgTickCacheRanges)
    .where(and(
      eq(pgTickCacheRanges.dataset, dataset),
      eq(pgTickCacheRanges.dbnSchema, dbnSchema),
      eq(pgTickCacheRanges.symbol, symbol),
    ));
  return rows.map((row) => [row.startMs, row.endMs]);
}

/** Read all cached ticks for a symbol/schema (no range filter). */
async function readCachedTicks(
  db: PostgresTickCacheDB,
  symbol: string,
  dbnSchema: string,
): Promise<QuoteTick[]> {
  const rows = await db
    .select()
    .from(pgQuoteTicks)
    .where(and(
      eq(pgQuoteTicks.symbol, symbol),
      eq(pgQuoteTicks.dbnSchema, dbnSchema),
    ))
    .orderBy(pgQuoteTicks.timestamp);
  return rows.map(rowToTick);
}

/** Write ticks + merge range in a single transaction. */
async function writeCachedTicks(
  db: PostgresTickCacheDB,
  dataset: string,
  dbnSchema: string,
  symbol: string,
  ticks: QuoteTick[],
  range: [number, number],
): Promise<boolean> {
  await db.transaction(async (tx) => {
    await takeRangeMergeLock(tx, dataset, dbnSchema, symbol);

    for (let i = 0; i < ticks.length; i += BATCH_SIZE) {
      const batch = ticks.slice(i, i + BATCH_SIZE);
      if (batch.length === 0) continue;
      await tx.insert(pgQuoteTicks)
        .values(batch.map((tick) => ({
          symbol: tick.symbol,
          dbnSchema,
          timestamp: tick.timestamp.getTime(),
          bid: tick.bid,
          ask: tick.ask,
          open: tick.open ?? null,
          close: tick.close ?? null,
          volume: tick.volume ?? null,
        })))
        .onConflictDoNothing();
    }

    const existingRows = await tx
      .select({ startMs: pgTickCacheRanges.startMs, endMs: pgTickCacheRanges.endMs })
      .from(pgTickCacheRanges)
      .where(and(
        eq(pgTickCacheRanges.dataset, dataset),
        eq(pgTickCacheRanges.dbnSchema, dbnSchema),
        eq(pgTickCacheRanges.symbol, symbol),
      ));
    const existingRanges = existingRows.map((row) => [row.startMs, row.endMs] as [number, number]);
    const merged = mergeRanges(existingRanges, range);

    await tx.delete(pgTickCacheRanges)
      .where(and(
        eq(pgTickCacheRanges.dataset, dataset),
        eq(pgTickCacheRanges.dbnSchema, dbnSchema),
        eq(pgTickCacheRanges.symbol, symbol),
      ));

    if (merged.length > 0) {
      await tx.insert(pgTickCacheRanges)
        .values(merged.map(([startMs, endMs]) => ({
          dataset,
          dbnSchema,
          symbol,
          startMs,
          endMs,
        })));
    }
  });
  return true;
}

/** Load a cached chain. Returns null if never fetched, [] if fetched but empty. */
async function loadCachedChain(
  db: PostgresTickCacheDB,
  dataset: string,
  parentSymbol: string,
  day: string,
): Promise<ChainDefinition[] | null> {
  return db.transaction(async (tx) => {
    const metaRows = await tx
      .select()
      .from(pgChainCacheMeta)
      .where(and(
        eq(pgChainCacheMeta.dataset, dataset),
        eq(pgChainCacheMeta.parentSymbol, parentSymbol),
        eq(pgChainCacheMeta.day, day),
      ))
      .limit(1);

    if (metaRows.length === 0) return null;

    const rows = await tx
      .select()
      .from(pgChainDefinitions)
      .where(and(
        eq(pgChainDefinitions.dataset, dataset),
        eq(pgChainDefinitions.parentSymbol, parentSymbol),
        eq(pgChainDefinitions.day, day),
      ));

    return rows.map((row) => ({
      rawSymbol: row.rawSymbol,
      expiry: row.expiry,
      strike: row.strike,
      callPut: toCallPut(row.callPut),
    }));
  });
}

/** Save chain definitions + meta in a single transaction. */
async function saveCachedChain(
  db: PostgresTickCacheDB,
  dataset: string,
  parentSymbol: string,
  day: string,
  defs: ChainDefinition[],
): Promise<boolean> {
  await db.transaction(async (tx) => {
    const fetchedAt = new Date().toISOString();
    await tx.insert(pgChainCacheMeta)
      .values({ dataset, parentSymbol, day, fetchedAt })
      .onConflictDoUpdate({
        target: [pgChainCacheMeta.dataset, pgChainCacheMeta.parentSymbol, pgChainCacheMeta.day],
        set: { fetchedAt },
      });

    await tx.delete(pgChainDefinitions)
      .where(and(
        eq(pgChainDefinitions.dataset, dataset),
        eq(pgChainDefinitions.parentSymbol, parentSymbol),
        eq(pgChainDefinitions.day, day),
      ));

    for (let i = 0; i < defs.length; i += BATCH_SIZE) {
      const batch = defs.slice(i, i + BATCH_SIZE);
      if (batch.length === 0) continue;
      await tx.insert(pgChainDefinitions)
        .values(batch.map((def) => ({
          dataset,
          parentSymbol,
          day,
          rawSymbol: def.rawSymbol,
          expiry: def.expiry,
          strike: def.strike,
          callPut: def.callPut,
        })))
        .onConflictDoUpdate({
          target: [
            pgChainDefinitions.dataset,
            pgChainDefinitions.parentSymbol,
            pgChainDefinitions.day,
            pgChainDefinitions.rawSymbol,
          ],
          set: {
            expiry: sql`excluded.expiry`,
            strike: sql`excluded.strike`,
            callPut: sql`excluded.call_put`,
          },
        });
    }
  });
  return true;
}

// ─── Helpers ────────────────────────────────────────────

async function takeRangeMergeLock(
  db: PostgresTickCacheDB,
  dataset: string,
  dbnSchema: string,
  symbol: string,
): Promise<void> {
  const lockKey = JSON.stringify([dataset, dbnSchema, symbol]);
  // Postgres advisory transaction locks are exposed as functions, not Drizzle builders.
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

function rowToTick(row: typeof pgQuoteTicks.$inferSelect): QuoteTick {
  const tick: QuoteTick = {
    symbol: row.symbol,
    bid: row.bid,
    ask: row.ask,
    timestamp: new Date(row.timestamp),
  };
  if (row.open != null) tick.open = row.open;
  if (row.close != null) tick.close = row.close;
  if (row.volume != null) tick.volume = row.volume;
  return tick;
}

function toCallPut(value: string): 'C' | 'P' {
  if (value !== 'C' && value !== 'P') {
    throw new Error(`Invalid cached chain call_put value: ${value}`);
  }
  return value;
}
