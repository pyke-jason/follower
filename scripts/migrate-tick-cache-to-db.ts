/**
 * One-shot migration: .cache/databento/*.json → tick-cache SQLite DB.
 *
 * Reads every JSON file in the cache directory, classifies it as:
 *   1. v2 envelope  → inserts ticks + ranges into DB
 *   2. chain definition array → skips (can't recover parent/day from hashed filename)
 *   3. bare OHLCV object → skips (no envelope metadata)
 *   4. malformed → skips with error log
 *
 * Run: npx tsx scripts/migrate-tick-cache-to-db.ts
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { tickCacheDb, tickCacheSqliteClient } from '../src/db/tick-cache-client.js';
import { quoteTicks, tickCacheRanges } from '../src/db/tick-cache-schema.js';
import { isOccOptionSymbol } from '../src/backtest/occ-symbology.js';

const CACHE_DIR = '.cache/databento';
const BATCH_SIZE = 500; // rows per INSERT batch

// ── Types ──────────────────────────────────────────────────────

type V2Envelope = {
  v: 2;
  ranges: [number, number][];
  ticks: Array<{
    symbol: string;
    bid: number;
    ask: number;
    timestamp: string;
    open?: number;
    close?: number;
    volume?: number;
  }>;
};

type Stats = {
  totalFiles: number;
  v2Files: number;
  ticksInserted: number;
  rangesInserted: number;
  emptyV2Files: number;
  chainDefFiles: number;
  bareOhlcvFiles: number;
  skippedOther: number;
  errors: number;
};

// ── Helpers ────────────────────────────────────────────────────

function isV2Envelope(raw: unknown): raw is V2Envelope {
  return (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).v === 2
  );
}

function isChainDefinitionArray(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  if (raw.length === 0) return false;
  const first = raw[0];
  return (
    first !== null &&
    typeof first === 'object' &&
    'rawSymbol' in first &&
    'expiry' in first &&
    'callPut' in first
  );
}

function isBareOhlcv(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  return 'open' in obj && 'close' in obj && 'high' in obj && 'low' in obj && 'timestamp' in obj;
}

function inferDataset(symbol: string): string {
  return isOccOptionSymbol(symbol) ? 'OPRA.PILLAR' : 'DBEQ.BASIC';
}

/**
 * Infer dbn_schema from tick data.
 * - Has open/close → OHLCV type: check spacing for 1m vs 1d
 * - No open/close + OCC symbol → cbbo-1s
 * - No open/close + equity → ohlcv-1m (equity quotes also use ohlcv-1m with synthesized bid/ask)
 */
function inferDbnSchema(ticks: V2Envelope['ticks'], symbol: string): string {
  if (ticks.length === 0) {
    return isOccOptionSymbol(symbol) ? 'cbbo-1s' : 'ohlcv-1m';
  }

  const hasOhlcv = ticks.some(t => t.open != null || t.close != null);

  if (hasOhlcv) {
    if (ticks.length <= 2) return 'ohlcv-1d';

    // daily bars have ~24h gaps, minute bars have ~60s gaps
    const timestamps = ticks.slice(0, 10).map(t => new Date(t.timestamp).getTime());
    if (timestamps.length >= 2) {
      const avgGapMs = (timestamps[timestamps.length - 1] - timestamps[0]) / (timestamps.length - 1);
      if (avgGapMs > 6 * 60 * 60 * 1000) return 'ohlcv-1d';
    }
    return 'ohlcv-1m';
  }

  return isOccOptionSymbol(symbol) ? 'cbbo-1s' : 'ohlcv-1m';
}

// ── File processing ────────────────────────────────────────────

type TickRow = {
  symbol: string;
  dbnSchema: string;
  timestamp: number;
  bid: number;
  ask: number;
  open: number | null;
  close: number | null;
  volume: number | null;
};

type RangeRow = {
  dataset: string;
  dbnSchema: string;
  symbol: string;
  startMs: number;
  endMs: number;
};

type FileResult = {
  type: 'v2' | 'v2-empty' | 'chain' | 'bare-ohlcv' | 'unknown' | 'parse-error';
  tickRows: TickRow[];
  rangeRows: RangeRow[];
};

function classifyAndExtract(raw: string): FileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: 'parse-error', tickRows: [], rangeRows: [] };
  }

  if (isChainDefinitionArray(parsed)) {
    return { type: 'chain', tickRows: [], rangeRows: [] };
  }

  if (isBareOhlcv(parsed)) {
    return { type: 'bare-ohlcv', tickRows: [], rangeRows: [] };
  }

  if (!isV2Envelope(parsed)) {
    return { type: 'unknown', tickRows: [], rangeRows: [] };
  }

  const ticks = parsed.ticks ?? [];
  const ranges = parsed.ranges ?? [];
  const symbol = ticks.length > 0 ? ticks[0].symbol : null;

  if (!symbol) {
    return { type: 'v2-empty', tickRows: [], rangeRows: [] };
  }

  const dataset = inferDataset(symbol);
  const dbnSchema = inferDbnSchema(ticks, symbol);

  const tickRows: TickRow[] = ticks.map(t => ({
    symbol: t.symbol,
    dbnSchema,
    timestamp: new Date(t.timestamp).getTime(),
    bid: t.bid,
    ask: t.ask,
    open: t.open ?? null,
    close: t.close ?? null,
    volume: t.volume ?? null,
  }));

  const rangeRows: RangeRow[] = ranges.map(([startMs, endMs]) => ({
    dataset,
    dbnSchema,
    symbol,
    startMs,
    endMs,
  }));

  return { type: 'v2', tickRows, rangeRows };
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('=== Tick Cache Migration: JSON → SQLite ===\n');

  const files = (await readdir(CACHE_DIR)).filter(f => f.endsWith('.json'));
  console.log(`Found ${files.length} JSON files in ${CACHE_DIR}\n`);

  const stats: Stats = {
    totalFiles: files.length,
    v2Files: 0,
    ticksInserted: 0,
    rangesInserted: 0,
    emptyV2Files: 0,
    chainDefFiles: 0,
    bareOhlcvFiles: 0,
    skippedOther: 0,
    errors: 0,
  };

  // Accumulate all rows, then bulk-insert inside a transaction.
  // Reading ~20K small JSON files is fast; the bottleneck is SQLite writes.
  let allTickRows: TickRow[] = [];
  let allRangeRows: RangeRow[] = [];

  const REPORT_EVERY = 2000;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const raw = await readFile(join(CACHE_DIR, file), 'utf-8');
      const result = classifyAndExtract(raw);

      switch (result.type) {
        case 'v2':
          stats.v2Files++;
          allTickRows.push(...result.tickRows);
          allRangeRows.push(...result.rangeRows);
          break;
        case 'v2-empty':
          stats.emptyV2Files++;
          break;
        case 'chain':
          stats.chainDefFiles++;
          break;
        case 'bare-ohlcv':
          stats.bareOhlcvFiles++;
          break;
        case 'parse-error':
          stats.errors++;
          break;
        case 'unknown':
          stats.skippedOther++;
          break;
      }
    } catch (err) {
      stats.errors++;
      console.error(`  ERROR reading ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if ((i + 1) % REPORT_EVERY === 0) {
      console.log(
        `  read: ${i + 1}/${files.length} files | ` +
        `v2=${stats.v2Files} ticks=${allTickRows.length} ranges=${allRangeRows.length} ` +
        `chains=${stats.chainDefFiles} bare=${stats.bareOhlcvFiles} errors=${stats.errors}`
      );
    }
  }

  const readMs = Date.now() - t0;
  console.log(`\nRead phase complete in ${(readMs / 1000).toFixed(1)}s`);
  console.log(`  ${allTickRows.length} tick rows, ${allRangeRows.length} range rows to insert\n`);

  // Bulk insert inside a transaction for SQLite performance
  console.log('Inserting ticks...');
  const insertT0 = Date.now();

  await tickCacheDb.transaction(async (tx) => {
    // Insert ticks in batches
    for (let i = 0; i < allTickRows.length; i += BATCH_SIZE) {
      const batch = allTickRows.slice(i, i + BATCH_SIZE);
      await tx.insert(quoteTicks).values(batch).onConflictDoNothing().execute();
      if ((i + BATCH_SIZE) % 50_000 < BATCH_SIZE) {
        console.log(`  ticks: ${Math.min(i + BATCH_SIZE, allTickRows.length)}/${allTickRows.length}`);
      }
    }

    // Insert ranges in batches
    for (let i = 0; i < allRangeRows.length; i += BATCH_SIZE) {
      const batch = allRangeRows.slice(i, i + BATCH_SIZE);
      await tx.insert(tickCacheRanges).values(batch).execute();
    }
  });

  stats.ticksInserted = allTickRows.length;
  stats.rangesInserted = allRangeRows.length;

  const insertMs = Date.now() - insertT0;
  console.log(`Insert phase complete in ${(insertMs / 1000).toFixed(1)}s\n`);

  // Free memory
  allTickRows = [];
  allRangeRows = [];

  // Final summary
  console.log('=== Migration Complete ===');
  console.log(`  Total files:       ${stats.totalFiles}`);
  console.log(`  v2 envelopes:      ${stats.v2Files}`);
  console.log(`  Ticks inserted:    ${stats.ticksInserted}`);
  console.log(`  Ranges inserted:   ${stats.rangesInserted}`);
  console.log(`  Empty v2 files:    ${stats.emptyV2Files}`);
  console.log(`  Chain def files:   ${stats.chainDefFiles}`);
  console.log(`  Bare OHLCV files:  ${stats.bareOhlcvFiles}`);
  console.log(`  Skipped (other):   ${stats.skippedOther}`);
  console.log(`  Errors:            ${stats.errors}`);
  console.log(`  Total time:        ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Verification: count rows in DB
  const [tickCountRow] = await tickCacheDb
    .select({ count: sql<number>`COUNT(*)` })
    .from(quoteTicks);
  const [rangeCountRow] = await tickCacheDb
    .select({ count: sql<number>`COUNT(*)` })
    .from(tickCacheRanges);

  const tickCount = tickCountRow?.count ?? 0;
  const rangeCount = rangeCountRow?.count ?? 0;

  console.log(`\n=== Verification ===`);
  console.log(`  DB quote_ticks rows:       ${tickCount}`);
  console.log(`  DB tick_cache_ranges rows:  ${rangeCount}`);
  console.log(`  Source ticks:              ${stats.ticksInserted}`);
  console.log(`  Source ranges:             ${stats.rangesInserted}`);

  if (tickCount <= stats.ticksInserted && rangeCount === stats.rangesInserted) {
    console.log('  PASS');
    if (tickCount < stats.ticksInserted) {
      console.log(`  (${stats.ticksInserted - tickCount} duplicate ticks deduplicated via ON CONFLICT IGNORE)`);
    }
  } else {
    console.log('  UNEXPECTED: DB has more rows than source — investigate');
  }

  tickCacheSqliteClient.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
