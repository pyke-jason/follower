import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { db, schema, sqliteClient } from './client.js';

async function seed() {
  console.log('Seeding tracked traders...');

  await db.insert(schema.trackedTraders).values([
    {
      name: 'Dave W',
      enabled: true,
      strategies: ['CDS', 'PDS', 'CALL', 'PUT', 'STOCK'],
      notes: '',
      positionSizingConfig: { strategy: 'atr', riskPercent: 0.02, atrMultiplier: 2.0 },
    },
    {
      name: 'Hariseldon',
      enabled: true,
      strategies: ['CDS', 'PDS', 'CALL', 'PUT', 'STOCK'],
      notes: '',
      positionSizingConfig: { strategy: 'atr', riskPercent: 0.02, atrMultiplier: 2.0 },
    },
    {
      name: 'Pete',
      enabled: true,
      strategies: ['CDS', 'PDS', 'CALL', 'PUT', 'STOCK'],
      notes: '',
      positionSizingConfig: { strategy: 'atr', riskPercent: 0.02, atrMultiplier: 2.0 },
    },
  ]).onConflictDoNothing();

  console.log('Seed complete.');
  sqliteClient.close();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
