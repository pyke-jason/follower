import { eq, and } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type * as tickCacheSchema from '../db/tick-cache-schema.js';
import { quoteTicks, tickCacheRanges, chainDefinitions, chainCacheMeta } from '../db/tick-cache-schema.js';
import type { QuoteTick, ChainDefinition } from './databento-tape.js';
import { mergeRanges } from './databento-tape.js';

export type TickCacheDB = LibSQLDatabase<typeof tickCacheSchema>;

/** Read all cached ranges for a given dataset/schema/symbol. */
export async function readCachedRanges(
  db: TickCacheDB,
  dataset: string,
  dbnSchema: string,
  symbol: string,
): Promise<[number, number][]> {
  const rows = await db
    .select({ startMs: tickCacheRanges.startMs, endMs: tickCacheRanges.endMs })
    .from(tickCacheRanges)
    .where(and(
      eq(tickCacheRanges.dataset, dataset),
      eq(tickCacheRanges.dbnSchema, dbnSchema),
      eq(tickCacheRanges.symbol, symbol),
    ));
  return rows.map(r => [r.startMs, r.endMs]);
}

/** Read all cached ticks for a symbol/schema (no range filter). */
export async function readCachedTicks(
  db: TickCacheDB,
  symbol: string,
  dbnSchema: string,
): Promise<QuoteTick[]> {
  const rows = await db
    .select()
    .from(quoteTicks)
    .where(and(
      eq(quoteTicks.symbol, symbol),
      eq(quoteTicks.dbnSchema, dbnSchema),
    ))
    .orderBy(quoteTicks.timestamp);
  return rows.map(rowToTick);
}

/** Write ticks + merge range in a single transaction. INSERT OR IGNORE for dedup. */
export async function writeCachedTicks(
  db: TickCacheDB,
  dataset: string,
  dbnSchema: string,
  symbol: string,
  ticks: QuoteTick[],
  range: [number, number],
): Promise<void> {
  await db.transaction(async (tx) => {
    // Batch insert ticks (INSERT OR IGNORE handles dupes on composite PK)
    const BATCH_SIZE = 500;
    for (let i = 0; i < ticks.length; i += BATCH_SIZE) {
      const batch = ticks.slice(i, i + BATCH_SIZE);
      if (batch.length === 0) continue;
      await tx.insert(quoteTicks)
        .values(batch.map(t => ({
          symbol: t.symbol,
          dbnSchema,
          timestamp: t.timestamp.getTime(),
          bid: t.bid,
          ask: t.ask,
          open: t.open ?? null,
          close: t.close ?? null,
          volume: t.volume ?? null,
        })))
        .onConflictDoNothing();
    }

    // Merge ranges: read existing, merge, delete old, insert merged
    const existingRows = await tx
      .select({ startMs: tickCacheRanges.startMs, endMs: tickCacheRanges.endMs })
      .from(tickCacheRanges)
      .where(and(
        eq(tickCacheRanges.dataset, dataset),
        eq(tickCacheRanges.dbnSchema, dbnSchema),
        eq(tickCacheRanges.symbol, symbol),
      ));
    const existingRanges = existingRows.map(r => [r.startMs, r.endMs] as [number, number]);

    const merged = mergeRanges(existingRanges, range);

    // Delete old range rows for this key
    await tx.delete(tickCacheRanges)
      .where(and(
        eq(tickCacheRanges.dataset, dataset),
        eq(tickCacheRanges.dbnSchema, dbnSchema),
        eq(tickCacheRanges.symbol, symbol),
      ));

    // Insert merged ranges
    if (merged.length > 0) {
      await tx.insert(tickCacheRanges)
        .values(merged.map(([startMs, endMs]) => ({
          dataset,
          dbnSchema,
          symbol,
          startMs,
          endMs,
        })));
    }
  });
}

/** Load a cached chain. Returns null if never fetched, [] if fetched but empty. */
export async function loadCachedChain(
  db: TickCacheDB,
  dataset: string,
  parentSymbol: string,
  day: string,
): Promise<ChainDefinition[] | null> {
  // Check if we ever fetched this chain
  const meta = await db
    .select()
    .from(chainCacheMeta)
    .where(and(
      eq(chainCacheMeta.dataset, dataset),
      eq(chainCacheMeta.parentSymbol, parentSymbol),
      eq(chainCacheMeta.day, day),
    ))
    .get();

  if (!meta) return null; // never fetched

  // Load definitions
  const rows = await db
    .select()
    .from(chainDefinitions)
    .where(and(
      eq(chainDefinitions.dataset, dataset),
      eq(chainDefinitions.parentSymbol, parentSymbol),
      eq(chainDefinitions.day, day),
    ));

  return rows.map(r => ({
    rawSymbol: r.rawSymbol,
    expiry: r.expiry,
    strike: r.strike,
    callPut: r.callPut as 'C' | 'P',
  }));
}

/** Save chain definitions + meta in a single transaction. */
export async function saveCachedChain(
  db: TickCacheDB,
  dataset: string,
  parentSymbol: string,
  day: string,
  defs: ChainDefinition[],
): Promise<void> {
  await db.transaction(async (tx) => {
    // Upsert meta
    await tx.insert(chainCacheMeta)
      .values({ dataset, parentSymbol, day, fetchedAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: [chainCacheMeta.dataset, chainCacheMeta.parentSymbol, chainCacheMeta.day],
        set: { fetchedAt: new Date().toISOString() },
      });

    // Delete old definitions for this key
    await tx.delete(chainDefinitions)
      .where(and(
        eq(chainDefinitions.dataset, dataset),
        eq(chainDefinitions.parentSymbol, parentSymbol),
        eq(chainDefinitions.day, day),
      ));

    // Insert new definitions
    if (defs.length > 0) {
      const BATCH_SIZE = 500;
      for (let i = 0; i < defs.length; i += BATCH_SIZE) {
        const batch = defs.slice(i, i + BATCH_SIZE);
        await tx.insert(chainDefinitions)
          .values(batch.map(d => ({
            dataset,
            parentSymbol,
            day,
            rawSymbol: d.rawSymbol,
            expiry: d.expiry,
            strike: d.strike,
            callPut: d.callPut,
          })));
      }
    }
  });
}

// ─── Helpers ────────────────────────────────────────────

function rowToTick(row: typeof quoteTicks.$inferSelect): QuoteTick {
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
