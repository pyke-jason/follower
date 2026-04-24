import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as tickCachePgSchema from '../db/tick-cache-pg-schema.js';
import { createPgTestPool } from '../test/pg-test-client.js';
import {
  initializePostgresTickCacheSchema,
  PostgresTickCacheStore,
} from './tick-cache-postgres-store.js';

let pool: Awaited<ReturnType<typeof createPgTestPool>>['pool'];
let store: PostgresTickCacheStore;

beforeAll(async () => {
  ({ pool } = await createPgTestPool('tick_cache_postgres_store'));
  const db = drizzle(pool, { schema: tickCachePgSchema });
  await initializePostgresTickCacheSchema(db);
  store = new PostgresTickCacheStore(db);
});

afterAll(async () => {
  await pool.end();
});

describe('PostgresTickCacheStore', () => {
  test('writes ticks and merges cached ranges', async () => {
    await expect(store.writeCachedTicks(
      'DBEQ.BASIC',
      'ohlcv-1m',
      'AAPL',
      [
        { symbol: 'AAPL', timestamp: new Date(0), bid: 1, ask: 2, open: 1.5, close: 1.8, volume: 10 },
        { symbol: 'AAPL', timestamp: new Date(60_000), bid: 2, ask: 3, open: 2.5, close: 2.8, volume: 11 },
      ],
      [0, 60_000],
    )).resolves.toBe(true);

    await expect(store.writeCachedTicks(
      'DBEQ.BASIC',
      'ohlcv-1m',
      'AAPL',
      [{ symbol: 'AAPL', timestamp: new Date(120_000), bid: 3, ask: 4 }],
      [60_000, 120_000],
    )).resolves.toBe(true);

    await expect(store.readCachedRanges('DBEQ.BASIC', 'ohlcv-1m', 'AAPL')).resolves.toEqual([[0, 120_000]]);
    await expect(store.readCachedTicks('AAPL', 'ohlcv-1m')).resolves.toHaveLength(3);
  });

  test('round-trips option chain cache', async () => {
    await expect(store.loadCachedChain('OPRA.PILLAR', 'AAPL.OPT', '2025-09-03')).resolves.toBeNull();
    await expect(store.saveCachedChain('OPRA.PILLAR', 'AAPL.OPT', '2025-09-03', [
      { rawSymbol: 'AAPL250919C00150000', expiry: '2025-09-19', strike: 150, callPut: 'C' },
    ])).resolves.toBe(true);

    await expect(store.loadCachedChain('OPRA.PILLAR', 'AAPL.OPT', '2025-09-03')).resolves.toEqual([
      { rawSymbol: 'AAPL250919C00150000', expiry: '2025-09-19', strike: 150, callPut: 'C' },
    ]);
  });
});
