import { loadSecrets } from './lib/secrets/index.js';
await loadSecrets();

import { installProcessErrorHandlers } from './lib/log-safety.js';
import { startIngestion, stopIngestion, closeBrowser } from './ingestion/ingest.js';
import { initRunner, submitTask, stopRunner, awaitDrain, destroyOrderManager } from './live/runner.js';
import { createTasksFromMessage } from './live/factory.js';
import { pgPool } from './db/client.js';
import { captureStartingBalance, ReconciliationScheduler, FillSweep, reconcileStops } from './reconciliation/index.js';
import { launchBrowser, attemptLogin, waitForAuth, getAuthState } from './ingestion/browser.js';
import { fetchHistorical } from './ingestion/historical.js';
import { acquireLock, releaseLock } from './lib/pidlock.js';
import { startHealthcheck, stopHealthcheck } from './lib/healthcheck.js';
import { startMetrics, stopMetrics } from './lib/process-metrics.js';
import { PATHS } from './lib/paths.js';
import { sendSystemAlert, startPushoverQueue, stopPushoverQueue } from './lib/alert.js';
import { getRuntimeChannelDefinitions } from './lib/runtime-channels.js';
import { checkDiskSpace } from './lib/disk-check.js';
import { isHalted, readHaltState } from './lib/halt-state.js';

const LOCK_PATH = PATHS.lockFile;

installProcessErrorHandlers({
  onFatal: () => {
    try { releaseLock(LOCK_PATH); } catch { /* best effort */ }
  },
});

let reconSchedulers: ReconciliationScheduler[] = [];
let fillSweeps: FillSweep[] = [];

async function main() {
  await checkDiskSpace();

  const lock = acquireLock(LOCK_PATH);
  if (!lock.acquired) {
    console.error(`\n[pidlock] Backend already running (PID ${lock.existingPid}). Exiting.\n`);
    process.exit(1);
  }
  console.log(`[pidlock] Backend lock acquired (PID ${process.pid})`);
  await startPushoverQueue();

  // Live-mode startup gate: require LIVE_TRADING_CONFIRMED=YYYY-MM-DD (UTC) to match today.
  // Prevents accidental live execution when re-running a stale shell or after a date rollover.
  const channelDefs = getRuntimeChannelDefinitions();
  const hasLive = channelDefs.some((c) => c.mode === 'live');
  if (hasLive) {
    const today = new Date().toISOString().slice(0, 10);
    const confirmed = process.env.LIVE_TRADING_CONFIRMED;
    if (confirmed !== today) {
      console.error(`
╔══════════════════════════════════════════════════════════════╗
║                    LIVE TRADING BLOCKED                      ║
╠══════════════════════════════════════════════════════════════╣
║  A live IBKR channel is configured but live trading has      ║
║  not been confirmed for today (${today} UTC).       ║
║                                                              ║
║  To start in live mode, set this env var and restart:        ║
║    LIVE_TRADING_CONFIRMED=${today}                  ║
║                                                              ║
║  This confirmation must be renewed each calendar day.        ║
╚══════════════════════════════════════════════════════════════╝
`);
      process.exit(1);
    }
    console.log(`[LiveGate] Live trading confirmed for ${today}`);
  }

  const { channels } = await initRunner();
  const runtimeChannelIds = channels.map((c) => c.channelId);

  console.log('═'.repeat(60));
  console.log('  TRADE FOLLOWER v0');
  console.log('═'.repeat(60));

  // Kill switch check — warn loudly but continue running so orders can resume once cleared
  if (isHalted()) {
    const haltState = readHaltState();
    const msg = `Kill switch is ACTIVE (reason: ${haltState?.reason ?? 'unknown'}, set at ${haltState?.haltedAt ?? 'unknown'}). No orders will be placed until you run: pnpm resume`;
    console.error(`\n${'!'.repeat(60)}`);
    console.error('  WARNING: TRADING IS HALTED');
    console.error(`  ${msg}`);
    console.error(`${'!'.repeat(60)}\n`);
    void sendSystemAlert({ title: 'Bot started while halted', message: msg, severity: 'warning' });
  }

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

  // Start reconciliation scheduler and fill sweep per channel.
  // Live channels use a 2-minute cycle; paper keeps the default 5-minute cycle.
  reconSchedulers = channels.map((channel) => {
    const intervalMs = channel.mode === 'live' ? 2 * 60 * 1000 : undefined;
    const scheduler = new ReconciliationScheduler(channel.broker, channel.channelId, intervalMs);
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
    startIngestion(async (message) => {
      const tasks = await createTasksFromMessage(message, runtimeChannelIds);
      for (const task of tasks) {
        submitTask(task);
      }
    });
  }

  // Start healthcheck pinger (dead-man's-switch for uptime monitoring)
  startHealthcheck();
  startMetrics();

  console.log('\n Trade Follower is running.');
  console.log('  Messages → Parse → Task → Agent → Trade');
  console.log('  Press Ctrl+C to stop.\n');
}

async function shutdown() {
  console.log('\nShutting down...');
  stopIngestion();                // stops supervision loop + watchdog + auth monitor
  stopRunner();                   // stops accepting new tasks
  stopHealthcheck();
  stopPushoverQueue();
  stopMetrics();

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
  await pgPool.end();
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
