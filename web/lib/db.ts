import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { resolve } from 'node:path';
import * as schema from '../../src/db/schema';

const dbPath = process.env.DATABASE_URL ?? `file:${resolve(process.cwd(), '../data/trade-follower.db')}`;

const client = createClient({ url: dbPath });
export const db = drizzle(client, { schema });
export { schema };
