import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqliteClient } from './client.js';

async function main() {
  console.log('Running migrations...');
  migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');
  sqliteClient.close();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
