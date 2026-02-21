import { loadSecrets } from './lib/secrets/index.js';
await loadSecrets();

import { startIngestion, closeBrowser } from './ingestion/ingest.js';
import { startTaskRunner, stopTaskRunner, awaitCurrentTask } from './tasks/runner.js';
import { createTaskFromMessage } from './tasks/factory.js';
import { classifyMessage } from './parsing/classify.js';
import { db, schema } from './db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { captureStartingBalance, ReconciliationScheduler, FillSweep } from './reconciliation/index.js';
import { enrichTradeWithFill } from './tasks/recorder.js';
import { liveService } from './broker/tradestation.js';
import type { TradeMetadata } from './db/schema.js';
import { launchBrowser, attemptLogin, waitForAuth, getAuthState } from './ingestion/browser.js';
import { fetchHistorical } from './ingestion/historical.js';
import { acquireLock, releaseLock } from './lib/pidlock.js';
import { startHealthcheck, stopHealthcheck } from './lib/healthcheck.js';
import { PATHS } from './lib/paths.js';
import { sendSystemAlert } from './lib/alert.js';

const LOCK_PATH = PATHS.lockFile;

let reconScheduler: ReconciliationScheduler | null = null;
let fillSweep: FillSweep | null = null;

/**
 * onFill callback for OrderManager — enriches the corresponding trade
 * with broker fill data when a working order gets filled.
 */
async function handleOrderFill(order: import('./broker/types.js').FilledWorkingOrder): Promise<void> {
  try {
    // Find the trade that references this broker order ID
    const trades = await db.select()
      .from(schema.trades)
      .where(and(
        eq(schema.trades.isBacktest, false),
        sql`json_extract(metadata, '$.brokerOrderId') = ${order.orderId}`,
      ))
      .limit(1);

    if (trades[0]) {
      await enrichTradeWithFill(trades[0].id, {
        orderId: order.orderId,
        status: 'FILLED',
        filledPrice: order.filledPrice,
        filledQuantity: order.filledQuantity,
        commission: order.commission,
        fillTimestamp: order.fillTimestamp,
        legFills: order.legFills,
      });
    }
  } catch (err) {
    console.warn('Failed to enrich trade on fill:', err);
  }
}

async function main() {
  const lock = acquireLock(LOCK_PATH);
  if (!lock.acquired) {
    console.error(`\n[pidlock] Backend already running (PID ${lock.existingPid}). Exiting.\n`);
    process.exit(1);
  }
  console.log(`[pidlock] Backend lock acquired (PID ${process.pid})`);

  console.log('═'.repeat(60));
  console.log('  TRADE FOLLOWER v0');
  console.log('═'.repeat(60));

  // Capture daily starting balance (non-fatal)
  try {
    await captureStartingBalance(liveService);
  } catch (err) {
    console.warn('Failed to capture starting balance:', err);
  }

  // Start reconciliation scheduler
  reconScheduler = new ReconciliationScheduler(liveService);
  reconScheduler.start();

  // Start fill sweep (enriches trades with broker fill data)
  fillSweep = new FillSweep(liveService);
  fillSweep.start();

  // Start the task runner (polls for pending tasks)
  startTaskRunner();

  // Start message ingestion (Playwright + SignalR)
  if (process.env.LIVE_INGESTION_ENABLED === '0') {
    console.log('[Ingest] Live ingestion disabled via LIVE_INGESTION_ENABLED=0, skipping browser launch');
  } else {
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
  }

  // Start healthcheck pinger (dead-man's-switch for uptime monitoring)
  startHealthcheck();

  console.log('\n Trade Follower is running.');
  console.log('  Messages → Parse → Task → Agent → Trade');
  console.log('  Press Ctrl+C to stop.\n');
}

async function shutdown() {
  console.log('\nShutting down...');
  stopTaskRunner();               // sets running = false, stops polling
  stopHealthcheck();

  // Wait for in-flight task (the critical window: placeOrder → recordTrade)
  try {
    await Promise.race([
      awaitCurrentTask(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
    ]);
    console.log('[Shutdown] In-flight task completed');
  } catch {
    console.error('[Shutdown] Timed out waiting for in-flight task');
    sendSystemAlert({
      title: 'Ungraceful shutdown',
      message: 'In-flight task did not complete within 30s. Check for orphaned orders.',
      severity: 'critical',
    });
  }

  // Drain background services
  await reconScheduler?.stop();
  await fillSweep?.stop();
  await closeBrowser();
  releaseLock(LOCK_PATH);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── CLI: Historical Fetch Mode ─────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

const flags = parseArgs();

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  releaseLock(LOCK_PATH);
  process.exit(1);
});

if (flags['fetch-historical']) {
  const since = flags['since'];
  const until = flags['until'];

  if (!since || !until || typeof since !== 'string' || typeof until !== 'string') {
    console.error('Usage: tsx src/index.ts --fetch-historical --since YYYY-MM-DD --until YYYY-MM-DD');
    process.exit(1);
  }

  (async () => {
    const lock = acquireLock(LOCK_PATH);
    if (!lock.acquired) {
      console.error(`\n[pidlock] Backend already running (PID ${lock.existingPid}). Exiting.\n`);
      process.exit(1);
    }
    console.log(`[pidlock] Backend lock acquired (PID ${process.pid})`);

    console.log('═'.repeat(60));
    console.log('  HISTORICAL FETCH');
    console.log('═'.repeat(60));

    const page = await launchBrowser();
    if (getAuthState() !== 'authenticated') {
      console.log('[Historical] Not authenticated, attempting login...');
      const success = await attemptLogin();
      if (!success) {
        console.log('[Historical] Auto-login failed. Waiting for manual login...');
        await waitForAuth();
      }
    }

    await fetchHistorical({ since, until });
    await closeBrowser();
    releaseLock(LOCK_PATH);
    process.exit(0);
  })().catch((err) => {
    console.error('Fatal error:', err);
    releaseLock(LOCK_PATH);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error('Fatal error:', err);
    releaseLock(LOCK_PATH);
    process.exit(1);
  });
}
