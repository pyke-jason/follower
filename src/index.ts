import 'dotenv/config';
import { startIngestion, closeBrowser } from './ingestion/ingest.js';
import { startTaskRunner, stopTaskRunner } from './tasks/runner.js';
import { createTaskFromMessage } from './tasks/factory.js';
import { classifyMessage } from './parsing/classify.js';
import { db, schema } from './db/client.js';
import { eq } from 'drizzle-orm';

async function main() {
  console.log('═'.repeat(60));
  console.log('  TRADE FOLLOWER v0');
  console.log('═'.repeat(60));

  // Start the task runner (polls for pending tasks)
  startTaskRunner();

  // Start message ingestion (Playwright + SignalR)
  await startIngestion(async (msg) => {
    // After message is stored, try to create a task
    const stored = await db.select()
      .from(schema.messages)
      .where(eq(schema.messages.id, msg.Id))
      .limit(1);

    if (stored[0]) {
      await createTaskFromMessage(stored[0]);
    }
  });

  console.log('\n Trade Follower is running.');
  console.log('  Messages → Parse → Task → Agent → Trade');
  console.log('  Press Ctrl+C to stop.\n');
}

async function shutdown() {
  console.log('\nShutting down...');
  stopTaskRunner();
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
