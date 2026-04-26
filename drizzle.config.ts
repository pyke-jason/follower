import { defineConfig } from 'drizzle-kit';

const DEFAULT_DATABASE_URL = `postgres://${process.env.USER ?? 'postgres'}@127.0.0.1:5432/trade_follower`;
const databaseUrl = process.env.POSTGRES_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

if (databaseUrl.startsWith('file:')) {
  throw new Error('Postgres is required. Set POSTGRES_DATABASE_URL or DATABASE_URL to a postgres:// URL.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
});
