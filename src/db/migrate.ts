import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { migrate } from 'drizzle-orm/libsql/migrator';
import { db, sqliteClient } from './client.js';

async function main() {
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');
  sqliteClient.close();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
