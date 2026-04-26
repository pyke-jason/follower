import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { runStartupMaintenance } from './startup-maintenance.js';

const DEFAULT_DATABASE_URL = `postgres://${process.env.USER ?? 'postgres'}@127.0.0.1:5432/trade_follower`;
const databaseUrl = process.env.POSTGRES_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

if (databaseUrl.startsWith('file:')) {
  throw new Error('Postgres is required. Set POSTGRES_DATABASE_URL or DATABASE_URL to a postgres:// URL.');
}

export const pgPool = new pg.Pool({ connectionString: databaseUrl });
export const db = drizzle(pgPool, { schema });

const maintenance = await runStartupMaintenance(db);
const repairedRows = Object.values(maintenance).reduce((sum, count) => sum + count, 0);
if (repairedRows > 0) {
  console.warn(`[db] Startup maintenance repaired ${repairedRows} row(s)`, maintenance);
}

export { schema };

export function runTx<T>(
  cb: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(cb);
}

/**
 * Retry transient database failures with jittered exponential backoff.
 * PostgreSQL can report serialization/deadlock/lock contention as SQLSTATEs.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  const retryableCodes = new Set(['40001', '40P01', '55P03']);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      const code = (error as { code?: string; cause?: { code?: string } })?.code
        ?? (error as { cause?: { code?: string } })?.cause?.code;
      if (code && retryableCodes.has(code) && attempt < retries - 1) {
        const delay = Math.min(100 * 2 ** attempt, 5_000) + Math.random() * 200;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error('withDbRetry: unreachable');
}
