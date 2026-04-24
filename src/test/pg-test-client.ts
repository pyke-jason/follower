import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../db/schema.js';

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function withSearchPath(url: string, schemaName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', `-csearch_path=${schemaName}`);
  return parsed.toString();
}

export async function createPgTestPool(name: string): Promise<{ pool: pg.Pool; schemaName: string }> {
  const baseUrl = process.env.TEST_POSTGRES_DATABASE_URL
    ?? process.env.POSTGRES_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? 'postgres://jason@127.0.0.1:5432/trade_follower_test';

  if (baseUrl.startsWith('file:')) {
    throw new Error('Tests require TEST_POSTGRES_DATABASE_URL or a postgres:// database URL.');
  }

  const safeName = name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  const schemaName = `test_${safeName}_${process.pid}_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: baseUrl, allowExitOnIdle: true });
  await admin.query(`CREATE SCHEMA ${quoteIdent(schemaName)}`);
  await admin.end();

  const pool = new pg.Pool({
    connectionString: withSearchPath(baseUrl, schemaName),
    allowExitOnIdle: true,
  });
  return { pool, schemaName };
}

export async function createPgTestClient(name: string) {
  const { pool } = await createPgTestPool(name);
  const db = drizzle(pool, { schema });
  return {
    db,
    schema,
    pgPool: pool,
    runTx: <T>(cb: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => db.transaction(cb),
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
  };
}
