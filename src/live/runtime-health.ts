import { db, schema } from '../db/client.js';
import { sql } from 'drizzle-orm';

export function upsertRuntimeHealth(channelId: string, fields: {
  brokerHealthy: boolean;
  circuitOpen: boolean;
  lastError?: string | null;
}): void {
  const now = new Date().toISOString();
  // Fire-and-forget — health writes must never block task processing
  db.insert(schema.runtimeHealth)
    .values({
      channelId,
      brokerHealthy: fields.brokerHealthy,
      circuitOpen: fields.circuitOpen,
      lastError: fields.lastError ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.runtimeHealth.channelId,
      set: {
        brokerHealthy: sql`excluded.broker_healthy`,
        circuitOpen: sql`excluded.circuit_open`,
        lastError: sql`excluded.last_error`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .run();
}
