import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';

const dbPath = process.env.DATABASE_URL ?? 'file:data/trade-follower.db';

const client = createClient({ url: dbPath });
export const db = drizzle(client, { schema });
export { schema };
export { client as sqliteClient };
