import 'dotenv/config';
import { db, schema, sqliteClient } from './client.js';

async function seed() {
  console.log('Seeding tracked traders...');

  await db.insert(schema.trackedTraders).values([
    {
      name: 'Arethra',
      enabled: true,
      strategies: ['CDS', 'PDS', 'CALL', 'PUT', 'STOCK'],
      maxAllocation: '5000',
      maxDailyAlloc: '10000',
      notes: 'Primary trader to follow',
    },
    {
      name: 'Pete',
      enabled: true,
      strategies: ['CDS', 'PDS', 'CALL', 'PUT', 'STOCK'],
      maxAllocation: '3000',
      maxDailyAlloc: '6000',
      notes: 'Secondary trader',
    },
  ]).onConflictDoNothing();

  console.log('Seed complete.');
  sqliteClient.close();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
