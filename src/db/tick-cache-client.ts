import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as tickCachePgSchema from './tick-cache-pg-schema.js';
import {
  initializePostgresTickCacheSchema,
  PostgresTickCacheStore,
} from '../backtest/tick-cache-postgres-store.js';
import type { TickCacheStore } from '../backtest/tick-cache-store.js';

const DEFAULT_TICK_CACHE_DATABASE_URL = 'postgres://jason@127.0.0.1:5432/trade_follower_tick_cache';
const postgresUrl = process.env.TICK_CACHE_DATABASE_URL
  ?? process.env.POSTGRES_DATABASE_URL
  ?? DEFAULT_TICK_CACHE_DATABASE_URL;

if (postgresUrl.startsWith('file:')) {
  throw new Error('Tick cache requires a postgres:// URL.');
}

const tickCachePool = new pg.Pool({ connectionString: postgresUrl });
const tickCacheDb = drizzle(tickCachePool, { schema: tickCachePgSchema });
await initializePostgresTickCacheSchema(tickCacheDb);

export const tickCacheStore: TickCacheStore = new PostgresTickCacheStore(tickCacheDb);
