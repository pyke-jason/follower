import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pgPool } from './client.js';

async function main() {
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');
  await pgPool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
