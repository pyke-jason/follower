import { launchBrowser, attemptLogin, waitForAuth, getAuthState, getPage, closeBrowser, startAuthMonitor, stopAuthMonitor } from './browser.js';
import { injectSignalRListener, type SignalRMessage } from './signalr.js';
import { classifyMessage } from '../parsing/classify.js';
import { db, schema } from '../db/client.js';
import { sendSystemAlert } from '../lib/alert.js';
import { isMarketHours } from '../lib/et-date.js';

// ─── Message Watchdog ────────────────────────────────
// Detects silent SignalR death: connection alive but no messages arriving.

let lastMessageReceivedAt: Date | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogAlertFired = false;

const WATCHDOG_CHECK_INTERVAL_MS = 60_000; // check every minute
const WATCHDOG_SILENCE_THRESHOLD_MS = 5 * 60_000; // alert after 5 min silence

function startMessageWatchdog(): void {
  watchdogTimer = setInterval(() => {
    if (!isMarketHours(new Date())) {
      watchdogAlertFired = false; // reset so it can fire again next session
      return;
    }
    if (!lastMessageReceivedAt) return; // haven't received any messages yet

    const silenceMs = Date.now() - lastMessageReceivedAt.getTime();
    if (silenceMs >= WATCHDOG_SILENCE_THRESHOLD_MS && !watchdogAlertFired) {
      watchdogAlertFired = true;
      const silenceMin = Math.round(silenceMs / 60_000);
      sendSystemAlert({
        title: 'Message watchdog: no messages received',
        message: `No SignalR messages received for ${silenceMin} minutes during market hours. Connection may be silently dead.`,
        severity: 'critical',
      });
    }
    if (silenceMs < WATCHDOG_SILENCE_THRESHOLD_MS) {
      watchdogAlertFired = false; // reset once messages resume
    }
  }, WATCHDOG_CHECK_INTERVAL_MS);
}

export function stopMessageWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// ─── Ingestion ───────────────────────────────────────

export async function startIngestion(onMessage?: (msg: SignalRMessage) => void): Promise<void> {
  const page = await launchBrowser();

  // Handle auth
  if (getAuthState() !== 'authenticated') {
    console.log('[Ingest] Not authenticated, attempting login...');
    const success = await attemptLogin();
    if (!success) {
      sendSystemAlert({
        title: 'Auto-login failed',
        message: 'Automatic login failed — waiting for manual login',
        severity: 'critical',
      });
      await waitForAuth();
    }
  }

  sendSystemAlert({
    title: 'Chat room connected',
    message: 'Authenticated and listening for messages',
    severity: 'info',
  });

  startAuthMonitor();
  startMessageWatchdog();

  // Inject SignalR listener
  await injectSignalRListener(page, async (msg) => {
    lastMessageReceivedAt = new Date();
    try {
      await processMessage(msg);
      onMessage?.(msg);
    } catch (err) {
      console.error('[Ingest] Error processing message:', err);
      sendSystemAlert({
        title: 'Ingestion error',
        message: `Failed to process message from ${msg.User?.Name ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'critical',
      });
    }
  });

  console.log('[Ingest] Listening for messages...');
}

async function processMessage(msg: SignalRMessage): Promise<void> {
  const classification = classifyMessage(msg.MessageText);

  await db.insert(schema.messages).values({
    id: msg.Id,
    author: msg.User.Name,
    timestamp: msg.PostTime || new Date().toISOString(),
    rawHtml: msg.MessageText,
    cleanText: classification.cleanText,
    badges: classification.badges,
    symbols: classification.symbols,
    actionHint: classification.actionHint,
    directionHint: classification.directionHint,
    detectedStrategies: classification.detectedStrategies,
    isPaperTrade: classification.isPaperTrade,
    hasMultipleTrades: classification.hasMultipleTrades,
    confidence: classification.confidence != null ? String(classification.confidence) : null,
  }).onConflictDoNothing();

  const badge = classification.badges.length > 0 ? `[${classification.badges.join(',')}]` : '';
  console.log(`[Ingest] ${msg.User.Name} ${badge}: ${classification.cleanText.substring(0, 80)}`);
}

export { closeBrowser } from './browser.js';
