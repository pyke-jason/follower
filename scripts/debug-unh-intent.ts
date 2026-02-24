import { db } from '../src/db/client.ts';
import * as schema from '../src/db/schema.ts';
import { eq, like } from 'drizzle-orm';

const rows = await db.select()
  .from(schema.messageIntents)
  .innerJoin(schema.messages, eq(schema.messages.id, schema.messageIntents.messageId))
  .where(like(schema.messages.content, '%Exit Long UNH%'))
  .limit(5);

for (const row of rows) {
  console.log('message:', row.messages.content);
  console.log('signals:', JSON.stringify(row.message_intents.signals, null, 2));
  console.log('skip:', row.message_intents.skipReason);
  console.log('---');
}
