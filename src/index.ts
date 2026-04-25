import { loadSecrets } from './lib/secrets/index.js';
await loadSecrets();

import { installProcessErrorHandlers } from './lib/log-safety.js';
import { startIngestion, stopIngestion, closeBrowser } from './ingestion/ingest.js';
import { initRunner, submitTask, stopRunner, awaitDrain, destroyOrderManager } from './live/runner.js';
import { createTasksFromMessage } from './live/factory.js';
import { db, schema } from './db/client.js';
import { eq } from 'drizzle-orm';
import { captureStartingBalance, ReconciliationScheduler, FillSweep, reconcileStops } from './reconciliation/index.js';
import { launchBrowser, attemptLogin, waitForAuth, getAuthState } from './ingestion/browser.js';
import { fetchHistorical } from './ingestion/historical.js';
import { acquireLock, releaseLock } from './lib/pidlock.js';
import { startHealthcheck, stopHealthcheck } from './lib/healthcheck.js';
import { PATHS } from './lib/paths.js';
import { sendSystemAlert } from './lib/alert.js';

const LOCK_PATH = PATHS.lockFile;

installProcessErrorHandlers({
  onFatal: () => {
    try { releaseLock(LOCK_PATH); } catch { /* best effort */ }
  },
});

let reconSchedulers: ReconciliationScheduler[] = [];
let fillSweeps: FillSweep[] = [];

async function main() {
  const lock = acquireLock(LOCK_PATH);
  if (!lock.acquired) {
    console.error(`\n[pidlock] Backend already running (PID ${lock.existingPid}). Exiting.\n`);
    process.exit(1);
  }
  console.log(`[pidlock] Backend lock acquired (PID ${process.pid})`);

  const { channels } = await initRunner();
  const runtimeChannelIds = channels.map((c) => c.channelId);

  console.log('═'.repeat(60));
  console.log('  TRADE FOLLOWER v0');
  console.log('═'.repeat(60));

  // Capture daily starting balance per channel (non-fatal)
  for (const channel of channels) {
    try {
      await captureStartingBalance(channel.broker, channel.channelId);
    } catch (err) {
      console.warn(`[Balance ${channel.channelId}] Failed to capture starting balance:`, err);
    }
  }

  // One-shot: ensure all open positions have a live server-side stop at IBKR
  for (const channel of channels) {
    try {
      await reconcileStops(channel.broker, channel.channelId);
    } catch (err) {
      console.warn(`[StopRecon ${channel.channelId}] Failed:`, err);
    }
  }

  // Start reconciliation scheduler and fill sweep per channel
  reconSchedulers = channels.map((channel) => {
    const scheduler = new ReconciliationScheduler(channel.broker, channel.channelId);
    scheduler.start();
    return scheduler;
  });
  fillSweeps = channels.map((channel) => {
    const sweep = new FillSweep(channel.broker, channel.channelId);
    sweep.start();
    return sweep;
  });

  // Start message ingestion (Playwright + SignalR) — self-supervising, fire-and-forget
  if (process.env.LIVE_INGESTION_ENABLED === '0') {
    console.log('[Ingest] Live ingestion disabled via LIVE_INGESTION_ENABLED=0, skipping browser launch');
  } else {
    startIngestion(async (msg) => {
      try {
        const stored = await db.select()
          .from(schema.messages)
          .where(eq(schema.messages.id, msg.Id))
          .limit(1);

        if (stored[0]) {
          const tasks = await createTasksFromMessage(stored[0], runtimeChannelIds);
          for (const task of tasks) {
            submitTask(task);
          }
        }
      } catch (err) {
        console.error('[Ingest] Task creation failed:', err);
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
  stopIngestion();                // stops supervision loop + watchdog + auth monitor
  stopRunner();                   // stops accepting new tasks
  stopHealthcheck();

  // Wait for in-flight task (the critical window: placeOrder → recordTrade)
  try {
    await Promise.race([
      awaitDrain(),
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
  destroyOrderManager();
  for (const scheduler of reconSchedulers) {
    await scheduler.stop();
  }
  for (const sweep of fillSweeps) {
    await sweep.stop();
  }
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

    const { page } = await launchBrowser();
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
