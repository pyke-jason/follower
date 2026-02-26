import { db, schema } from '../db/client.js';

export async function recordDecision(values: typeof schema.runDecisions.$inferInsert): Promise<void> {
  await db.insert(schema.runDecisions).values(values);
}
