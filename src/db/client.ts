import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { PATHS } from '../lib/paths.js';

const dbPath = process.env.DATABASE_URL ?? `file:${PATHS.db}`;

const client = createClient({ url: dbPath });
client.executeMultiple(
  'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;',
);
export const db = drizzle(client, { schema });
export { schema };
export { client as sqliteClient };
