import { defineConfig } from 'drizzle-kit';
import { resolve } from 'node:path';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: (process.env.DATABASE_URL?.replace(/^file:/, '') ?? resolve(import.meta.dirname ?? '.', 'data/trade-follower.db')),
  },
});
