import { launchBrowser, attemptLogin, waitForAuth, getAuthState, closeBrowser, startAuthMonitor, stopAuthMonitor } from './browser.js';
import { injectSignalRListener, compactReactions, type SignalRMessage, type ReactionUpdate } from './signalr.js';
import { classifyMessage } from '../parsing/classify.js';
import { db, schema } from '../db/client.js';
import { sendSystemAlert } from '../lib/alert.js';
import { isMarketHours, isoToDateKey } from '../lib/et-date.js';
import { and, eq, gte } from 'drizzle-orm';
import { normalizeForDedup, computeContentHash } from './dedup.js';
import { fetchHistorical } from './historical.js';

// ─── Message Watchdog ────────────────────────────────
// Detects silent SignalR death: connection alive but no messages arriving.

let lastMessageReceivedAt: Date | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogAlertFired = false;

const WATCHDOG_CHECK_INTERVAL_MS = 60_000; // check every minute
const WATCHDOG_SILENCE_THRESHOLD_MS = 5 * 60_000; // alert after 5 min silence

const WATCHDOG_FORCE_RESTART_MS = 10 * 60_000; // force restart after 10 min silence

function startMessageWatchdog(): void {
  watchdogTimer = setInterval(() => {
    if (!isMarketHours(new Date())) {
      watchdogAlertFired = false; // reset so it can fire again next session
      return;
    }
    if (!lastMessageReceivedAt) return; // haven't received any messages yet

    const silenceMs = Date.now() - lastMessageReceivedAt.getTime();

    // After 10 min silence: force browser restart (supervision loop will reconnect + gap-fill)
    if (silenceMs >= WATCHDOG_FORCE_RESTART_MS) {
      const silenceMin = Math.round(silenceMs / 60_000);
      console.warn(`[Watchdog] ${silenceMin}min silence during market hours — forcing browser restart`);
      sendSystemAlert({
        title: 'Watchdog: forcing browser restart',
        message: `No messages for ${silenceMin} minutes. Killing browser to trigger reconnect + gap-fill.`,
        severity: 'critical',
      });
      watchdogAlertFired = false;
      // Close browser — the supervision loop's `await crashed` will resolve and restart
      closeBrowser().catch(() => {});
      return;
    }

    // After 5 min silence: alert (but don't restart yet)
    if (silenceMs >= WATCHDOG_SILENCE_THRESHOLD_MS && !watchdogAlertFired) {
      watchdogAlertFired = true;
      const silenceMin = Math.round(silenceMs / 60_000);
      sendSystemAlert({
        title: 'Message watchdog: no messages received',
        message: `No SignalR messages received for ${silenceMin} minutes during market hours. Will force restart at 10min mark.`,
        severity: 'warning',
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

// ─── Gap-Fill on Reconnect ───────────────────────────
// After browser restart, fetch today's messages from the REST API to fill
// any gap from downtime. Dedup (onConflictDoNothing) prevents duplicates.

async function gapFill(): Promise<void> {
  try {
    const today = isoToDateKey(new Date().toISOString());
    console.log(`[Ingest] Gap-fill: fetching historical for ${today}`);
    await fetchHistorical({ since: today, until: today });
    console.log('[Ingest] Gap-fill complete');
  } catch (err) {
    // Non-fatal — SignalR will catch new messages going forward
    console.warn('[Ingest] Gap-fill failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

// ─── Supervision Loop ────────────────────────────────

const RETRY_DELAYS = [10_000, 20_000, 40_000, 60_000]; // cap at 60s
let shouldRun = true;

export function startIngestion(onMessage?: (msg: SignalRMessage) => void | Promise<void>): void {
  shouldRun = true;
  superviseIngestion(onMessage).catch(err => {
    console.error('[Ingest] Supervisor crashed unexpectedly:', err);
  });
}

export function stopIngestion(): void {
  shouldRun = false;
  stopMessageWatchdog();
  stopAuthMonitor();
}

async function superviseIngestion(onMessage?: (msg: SignalRMessage) => void | Promise<void>): Promise<void> {
  let consecutiveFailures = 0;
  let isFirstBoot = true;

  while (shouldRun) {
    try {
      // Clean slate — close previous browser process before relaunching
      await closeBrowser();
      stopMessageWatchdog();
      lastMessageReceivedAt = null;
      watchdogAlertFired = false;

      const { page, crashed } = await launchBrowser();

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

      // Wire up SignalR + monitors
      await injectSignalRListener(page, async (msg) => {
        lastMessageReceivedAt = new Date();
        try {
          await processMessage(msg);
          await onMessage?.(msg);
        } catch (err) {
          console.error('[Ingest] Error processing message:', err);
          sendSystemAlert({
            title: 'Ingestion error',
            message: `Failed to process message from ${msg.User?.Name ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
            severity: 'critical',
          });
        }
      }, async (update) => {
        try {
          await processReactionUpdate(update);
        } catch (err) {
          console.error('[Ingest] Error processing reaction update:', err);
        }
      });

      startAuthMonitor();
      startMessageWatchdog();

      // Gap-fill: fetch any messages missed during downtime (non-blocking)
      if (!isFirstBoot) {
        gapFill().catch(() => {}); // errors already logged inside
      }
      isFirstBoot = false;

      consecutiveFailures = 0;

      sendSystemAlert({
        title: 'Chat room connected',
        message: 'Authenticated and listening for messages',
        severity: 'info',
      });

      console.log('[Ingest] Listening for messages...');

      // Park here until browser dies
      await crashed;

      console.log('[Ingest] Browser closed — will restart');
      sendSystemAlert({
        title: 'Browser closed',
        message: 'Ingestion browser was closed. Restarting automatically.',
        severity: 'warning',
      });
    } catch (err) {
      consecutiveFailures++;
      const delay = RETRY_DELAYS[Math.min(consecutiveFailures - 1, RETRY_DELAYS.length - 1)];

      console.error(`[Ingest] Failed (attempt ${consecutiveFailures}):`, err);

      if (consecutiveFailures >= 5) {
        sendSystemAlert({
          title: 'Ingestion repeatedly failing',
          message: `${consecutiveFailures} consecutive failures. Last: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'critical',
        });
      }

      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─── Dedup Helpers ───────────────────────────────────

const DEDUP_WINDOW_MS = 60_000; // 60-second window for near-duplicate detection

// ─── Message Processing ──────────────────────────────

async function processMessage(msg: SignalRMessage): Promise<void> {
  if (typeof msg.MessageText !== 'string' || !msg.MessageText) {
    console.warn('[Ingest] Message with empty/missing text from', msg.User?.Name ?? 'unknown', '— dropped');
    return;
  }
  const classification = classifyMessage(msg.MessageText);

  const normalizedText = normalizeForDedup(classification.cleanText);
  const contentHash = computeContentHash(normalizedText);
  const author = msg.User.Name;
  const timestamp = msg.PostTime || new Date().toISOString();
  const windowStart = new Date(new Date(timestamp).getTime() - DEDUP_WINDOW_MS).toISOString();

  // Near-duplicate check: same author + same content hash within 60-second window
  const existing = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(
      eq(schema.messages.author, author),
      eq(schema.messages.contentHash, contentHash),
      gte(schema.messages.timestamp, windowStart),
    ))
    .limit(1);

  if (existing.length > 0) {
    console.log(`[Ingest] Near-duplicate suppressed for ${author} (hash ${contentHash.substring(0, 8)}…, existing msg ${existing[0].id})`);
    return;
  }

  const reactions = compactReactions(msg.Reactions);

  await db.insert(schema.messages).values({
    id: msg.Id,
    author,
    timestamp,
    rawHtml: msg.MessageText,
    cleanText: classification.cleanText,
    badges: classification.badges,
    symbols: classification.symbols,
    actionHint: classification.actionHint,
    directionHint: classification.directionHint,
    detectedStrategies: classification.detectedStrategies,
    isPaperTrade: classification.isPaperTrade,
    confidence: classification.confidence != null ? String(classification.confidence) : null,
    contentHash,
    reactions,
  }).onConflictDoNothing();

  const badge = classification.badges.length > 0 ? `[${classification.badges.join(',')}]` : '';
  console.log(`[Ingest] ${author} ${badge}: ${classification.cleanText.substring(0, 80)}`);
}

// ─── Reaction Updates ───────────────────────────────

async function processReactionUpdate(update: ReactionUpdate): Promise<void> {
  const result = await db.update(schema.messages)
    .set({ reactions: update.reactions })
    .where(eq(schema.messages.id, update.messageId));

  if (result.changes > 0) {
    console.log(`[Ingest] Reactions updated for msg ${update.messageId}: ${update.reactions.map(r => `${r.Type}:${r.Count}`).join(', ')}`);
  }
}

export { closeBrowser } from './browser.js';
