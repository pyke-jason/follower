import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { db, schema, sqliteClient } from './client.js';

async function seed() {
  console.log('Seeding tracked traders...');

  await db.insert(schema.trackedTraders).values([
    {
      name: 'Dave W',
      enabled: true,
      strategies: ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'CCS', 'PCS'],
      notes: '',
      positionSizingConfig: { strategy: 'notional', maxNotionalPct: 0.05 },
    },
    {
      name: 'Hariseldon',
      enabled: true,
      strategies: ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'CCS', 'PCS'],
      notes: '',
      positionSizingConfig: { strategy: 'notional', maxNotionalPct: 0.05 },
    },
    {
      name: 'Pete',
      enabled: true,
      strategies: ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'CCS', 'PCS'],
      notes: '',
      positionSizingConfig: { strategy: 'notional', maxNotionalPct: 0.05 },
    },
  ]).onConflictDoNothing();

  console.log('Seed complete.');
  sqliteClient.close();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
