import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { PATHS } from '../lib/paths.js';

const dbPath = process.env.DATABASE_URL?.replace(/^file:/, '') ?? PATHS.db;

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 30000');

export const db = drizzle(sqlite, { schema });
export { schema };
export { sqlite as sqliteClient };

/** Synchronous transaction via better-sqlite3's native `.transaction()`. */
export function runTx<T>(cb: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => T): T {
  return db.transaction(cb);
}

/**
 * Retry wrapper for SQLITE_BUSY errors with jittered exponential backoff.
 *
 * With better-sqlite3 + busy_timeout=30000, SQLite handles contention
 * internally (waits up to 30s before throwing SQLITE_BUSY). This retry
 * wrapper is a safety net for edge cases where even 30s isn't enough.
 */
export async function withBusyRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const code = error?.code ?? error?.cause?.code;
      if (code === 'SQLITE_BUSY' && attempt < retries - 1) {
        const delay = Math.min(100 * Math.pow(2, attempt), 5000) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error('withBusyRetry: unreachable');
}
