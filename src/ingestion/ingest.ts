import { launchBrowser, attemptLogin, waitForAuth, getAuthState, closeBrowser, startAuthMonitor, stopAuthMonitor, shouldRotateProactively, clearProactiveRotationFlag, CHAT_URL } from './browser.js';
import { rotateAccount } from './account-rotation.js';
import { injectSignalRListener, isSignalRSubscriptionReady, compactReactions, type SignalRMessage, type ReactionUpdate } from './signalr.js';
import type { Page } from 'playwright';
import { classifyMessage } from '../parsing/classify.js';
import { db, schema } from '../db/client.js';
import type { Message } from '../db/schema.js';
import { sendSystemAlert } from '../lib/alert.js';
import { isMarketHours, isoToDateKey } from '../lib/et-date.js';
import { and, asc, eq, gte } from 'drizzle-orm';
import { normalizeForDedup, computeContentHash } from './dedup.js';
import { fetchHistorical, syncHistoricalDay, type HistoricalDaySyncResult } from './historical.js';
import { shouldSendRecoveryAlert, staleRecoveredMessages } from './recovery.js';

// ─── Message Watchdog ────────────────────────────────
// Detects silent SignalR death: connection alive but no messages arriving.

let lastMessageReceivedAt: Date | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogAlertFired = false;
let restSafetyNetTimer: ReturnType<typeof setInterval> | null = null;
let restSyncInFlight = false;
let restPollingFailures = 0;
let restSafetyNetFailures = 0;
let lastRecoveryAlertAt: Date | null = null;
let lastRestFailureAlertAt: Date | null = null;

const WATCHDOG_CHECK_INTERVAL_MS = 60_000; // check every minute
const WATCHDOG_SILENCE_THRESHOLD_MS = 5 * 60_000; // alert after 5 min silence

const WATCHDOG_FORCE_RESTART_MS = 10 * 60_000; // force restart after 10 min silence
const SUBSCRIPTION_RECOVERY_DELAY_MS = 60_000; // wait 60s between page-reload retries
const SUBSCRIPTION_RECOVERY_MAX_ATTEMPTS = 5; // after this many reloads, restart browser
const REST_SAFETY_NET_INTERVAL_MS = 60_000;
const REST_RECOVERY_GRACE_MS = 45_000;
const REST_RECOVERY_ALERT_COOLDOWN_MS = 5 * 60_000;
const REST_SYNC_ALERT_FAILURES = 3;

type StoredMessageHandler = (message: Message) => void | Promise<void>;

function startMessageWatchdog(): void {
  lastMessageReceivedAt ??= new Date();

  watchdogTimer = setInterval(() => {
    if (!isMarketHours(new Date())) {
      watchdogAlertFired = false; // reset so it can fire again next session
      return;
    }
    if (!lastMessageReceivedAt) return;

    const silenceMs = Date.now() - lastMessageReceivedAt.getTime();

    // After 10 min silence: force browser restart (supervision loop will reconnect + gap-fill)
    if (silenceMs >= WATCHDOG_FORCE_RESTART_MS) {
      const silenceMin = Math.round(silenceMs / 60_000);
      console.warn(`[Watchdog] ${silenceMin}min silence during market hours — forcing browser restart`);
      sendSystemAlert({
        title: 'Watchdog: forcing browser restart',
        message: `No messages for ${silenceMin} minutes. Killing browser to trigger reconnect + gap-fill.`,
        severity: 'warning',
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

function stopMessageWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function startRestSafetyNet(onStoredMessage?: StoredMessageHandler): void {
  if (restSafetyNetTimer) return;
  console.log(`[RestSafetyNet] Starting REST message audit (every ${REST_SAFETY_NET_INTERVAL_MS / 1000}s)`);
  restSafetyNetTimer = setInterval(() => {
    if (!isMarketHours(new Date())) {
      restSafetyNetFailures = 0;
      return;
    }

    syncTodayFromRest('safety-net', onStoredMessage).catch((err) => {
      handleRestSyncFailure('safety-net', err);
    });
  }, REST_SAFETY_NET_INTERVAL_MS);
}

function stopRestSafetyNet(): void {
  if (!restSafetyNetTimer) return;
  clearInterval(restSafetyNetTimer);
  restSafetyNetTimer = null;
  console.log('[RestSafetyNet] Stopped');
}

// ─── Gap-Fill ────────────────────────────────────────
// Startup: fetch last N days (default 30) so the UI has same-day/week/month
// context on first boot. Reconnect: fetch today only. Prior-run chunk cache
// in historical.ts makes the wide startup window cheap — only today plus any
// gap days actually hit the API.

const INITIAL_BACKFILL_DAYS = Math.max(0, Number(process.env.INITIAL_BACKFILL_DAYS ?? '30'));

async function gapFill(
  daysBack: number,
  onStoredMessage?: StoredMessageHandler,
  includeToday = true,
): Promise<void> {
  try {
    const now = new Date();
    const untilDate = new Date(now);
    if (!includeToday) {
      untilDate.setUTCDate(untilDate.getUTCDate() - 1);
    }

    const sinceDate = new Date(now);
    sinceDate.setUTCDate(sinceDate.getUTCDate() - daysBack);
    if (sinceDate > untilDate) {
      console.log('[Ingest] Gap-fill skipped: no historical days in range');
      return;
    }

    const until = isoToDateKey(untilDate.toISOString());
    const since = isoToDateKey(sinceDate.toISOString());
    console.log(`[Ingest] Gap-fill: fetching historical ${since} to ${until}`);
    await fetchHistorical({
      since,
      until,
      onSavedMessage: onStoredMessage
        ? (message) => handleStoredMessage(message, onStoredMessage)
        : undefined,
    });
    console.log('[Ingest] Gap-fill complete');
  } catch (err) {
    // Non-fatal — SignalR will catch new messages going forward
    console.warn('[Ingest] Gap-fill failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

// ─── Supervision Loop ────────────────────────────────

const RETRY_DELAYS = [10_000, 20_000, 40_000, 60_000]; // cap at 60s
let shouldRun = true;

export function startIngestion(onStoredMessage?: StoredMessageHandler): void {
  shouldRun = true;
  superviseIngestion(onStoredMessage).catch(err => {
    console.error('[Ingest] Supervisor crashed unexpectedly:', err);
  });
}

export function stopIngestion(): void {
  shouldRun = false;
  stopMessageWatchdog();
  stopRestSafetyNet();
  stopPollingFallback();
  cancelSubscriptionRecovery();
  stopAuthMonitor();
}

// ─── Subscription Recovery (in-place page reload) ─────
// When SignalR's addMessage is connected but the page's chatHub proxy is
// missing, reactions can't be observed but live messages still flow. Instead
// of tearing the browser down, reload the page so its app code re-creates the
// chatHub proxy, then re-attach our hooks. REST polling stays on as a safety
// net. Falls back to a full browser restart only after several reload attempts.

let subscriptionRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let subscriptionRecoveryAttempts = 0;
let subscriptionRecoveryInFlight = false;

function cancelSubscriptionRecovery(): void {
  if (subscriptionRecoveryTimer) {
    clearTimeout(subscriptionRecoveryTimer);
    subscriptionRecoveryTimer = null;
  }
  subscriptionRecoveryAttempts = 0;
  subscriptionRecoveryInFlight = false;
}

function scheduleSubscriptionRecovery(
  page: Page,
  onMessage: (msg: SignalRMessage) => Promise<void>,
  onReaction: (update: ReactionUpdate) => Promise<void>,
): void {
  if (subscriptionRecoveryTimer || subscriptionRecoveryInFlight) return;
  if (subscriptionRecoveryAttempts >= SUBSCRIPTION_RECOVERY_MAX_ATTEMPTS) {
    console.warn(`[Ingest] Subscription recovery exhausted ${SUBSCRIPTION_RECOVERY_MAX_ATTEMPTS} reload attempts — restarting browser`);
    sendSystemAlert({
      title: 'Chat room subscription unrecoverable',
      message: `${SUBSCRIPTION_RECOVERY_MAX_ATTEMPTS} page reloads did not restore the chat room proxy. Restarting browser as a last resort.`,
      severity: 'warning',
    });
    subscriptionRecoveryAttempts = 0;
    closeBrowser().catch(() => {});
    return;
  }

  subscriptionRecoveryTimer = setTimeout(() => {
    subscriptionRecoveryTimer = null;
    runSubscriptionRecovery(page, onMessage, onReaction).catch((err) => {
      console.warn('[Ingest] Subscription recovery error:', err instanceof Error ? err.message : err);
      scheduleSubscriptionRecovery(page, onMessage, onReaction);
    });
  }, SUBSCRIPTION_RECOVERY_DELAY_MS);
  subscriptionRecoveryTimer.unref?.();
}

async function runSubscriptionRecovery(
  page: Page,
  onMessage: (msg: SignalRMessage) => Promise<void>,
  onReaction: (update: ReactionUpdate) => Promise<void>,
): Promise<void> {
  if (page.isClosed()) return;
  subscriptionRecoveryInFlight = true;
  subscriptionRecoveryAttempts++;
  try {
    console.log(`[Ingest] Subscription recovery: reloading page (attempt ${subscriptionRecoveryAttempts}/${SUBSCRIPTION_RECOVERY_MAX_ATTEMPTS})`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });

    // Re-accept policies if the gate reappears after reload
    const policiesCheckbox = page.locator('#understand');
    if (await policiesCheckbox.count() > 0) {
      try {
        await policiesCheckbox.check();
        await page.locator('#continue').click();
        await page.waitForLoadState('domcontentloaded');
      } catch {
        // Ignore — reload retry will catch any persistent issue
      }
    }

    // Bridge functions persist across reloads in Playwright; only re-run the
    // page-evaluate that wires up the hub proxies.
    const newStatus = await injectSignalRListener(page, onMessage, onReaction, { skipBridgeExpose: true });
    if (isSignalRSubscriptionReady(newStatus)) {
      console.log('[Ingest] Subscription recovered after page reload');
      stopPollingFallback();
      subscriptionRecoveryAttempts = 0;
    } else {
      console.warn('[Ingest] Subscription still degraded after reload:', newStatus.details);
      scheduleSubscriptionRecovery(page, onMessage, onReaction);
    }
  } finally {
    subscriptionRecoveryInFlight = false;
  }
}

async function superviseIngestion(onStoredMessage?: StoredMessageHandler): Promise<void> {
  let consecutiveFailures = 0;
  let isFirstBoot = true;

  while (shouldRun) {
    try {
      // Clean slate — close previous browser process before relaunching
      await closeBrowser();
      stopMessageWatchdog();
      stopRestSafetyNet();
      stopPollingFallback();
      cancelSubscriptionRecovery();
      lastMessageReceivedAt = null;
      watchdogAlertFired = false;

      // Proactive rotation: trial monitor detected expiry approaching
      if (shouldRotateProactively()) {
        console.log('[Ingest] Proactive rotation triggered — trial expiring soon');
        clearProactiveRotationFlag();
        const newEmail = await rotateAccount();
        if (newEmail) {
          sendSystemAlert({
            title: 'Proactive account rotation complete',
            message: `New OneOption account: ${newEmail} — trial was about to expire`,
            severity: 'info',
          });
          continue; // restart loop with new credentials
        }
        console.warn('[Ingest] Proactive rotation failed — continuing with current account');
      }

      const { page, crashed } = await launchBrowser();

      // Handle auth
      if (getAuthState() !== 'authenticated') {
        console.log('[Ingest] Not authenticated, attempting login...');
        const success = await attemptLogin();
        if (!success) {
          // Try automatic account rotation before falling back to manual
          console.log('[Ingest] Login failed — attempting account rotation...');
          const newEmail = await rotateAccount();
          if (newEmail) {
            sendSystemAlert({
              title: 'Account rotated',
              message: `New OneOption account: ${newEmail} — restarting browser`,
              severity: 'info',
            });
            await closeBrowser();
            continue; // restart supervision loop with new credentials
          }
          // Rotation failed — fall through to manual
          sendSystemAlert({
            title: 'Login and rotation both failed',
            message: 'Automatic login and account rotation both failed — waiting for manual login',
            severity: 'critical',
          });
          await waitForAuth();
        }
      }

      // Ensure we're on the chat page (login may redirect to membership/dashboard)
      if (!page.url().includes('/chat')) {
        // Dismiss referral/welcome modal if present (required to unlock chat access)
        const referralModal = page.locator('#referral-prompt');
        if (await referralModal.count() > 0 && await referralModal.isVisible()) {
          console.log('[Ingest] Dismissing welcome modal...');
          const select = page.locator('#referral-prompt select');
          if (await select.count() > 0) {
            await select.selectOption('Reddit');
          }
          const submit = page.locator('#referral-prompt button.btn-primary');
          if (await submit.count() > 0) {
            await submit.click();
            await page.waitForTimeout(2000);
          }
        }

        console.log('[Ingest] Not on chat page, navigating...');
        await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        console.log(`[Ingest] Landed on: ${page.url()}`);

        // Accept chat room policies if shown
        const policiesCheckbox = page.locator('#understand');
        if (await policiesCheckbox.count() > 0) {
          console.log('[Ingest] Accepting chat room policies...');
          await policiesCheckbox.check();
          await page.locator('#continue').click();
          await page.waitForLoadState('domcontentloaded');
          console.log(`[Ingest] After policies: ${page.url()}`);
        }
      }

      // If still not on /chat after login + onboarding, the account likely
      // can't access chat (expired trial, locked out, etc). Try rotation.
      if (!page.url().includes('/chat')) {
        console.log(`[Ingest] Still not on chat page (${page.url()}) — account may be expired`);
        const newEmail = await rotateAccount();
        if (newEmail) {
          sendSystemAlert({
            title: 'Account rotated',
            message: `New OneOption account: ${newEmail} — restarting browser`,
            severity: 'info',
          });
          await closeBrowser();
          continue;
        }
        // Rotation failed — continue anyway, polling fallback may partially work
        console.warn('[Ingest] Account rotation failed — continuing with degraded access');
      }

      // Wire up SignalR + monitors
      const onSignalRMessage = async (msg: SignalRMessage) => {
        lastMessageReceivedAt = new Date();
        try {
          const stored = await processMessage(msg);
          if (stored) {
            await handleStoredMessage(stored, onStoredMessage);
          }
        } catch (err) {
          console.error('[Ingest] Error processing message:', err);
          sendSystemAlert({
            title: 'Ingestion error',
            message: `Failed to process message from ${msg.User?.Name ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
            severity: 'critical',
          });
        }
      };
      const onSignalRReaction = async (update: ReactionUpdate) => {
        try {
          await processReactionUpdate(update);
        } catch (err) {
          console.error('[Ingest] Error processing reaction update:', err);
        }
      };
      const signalRStatus = await injectSignalRListener(page, onSignalRMessage, onSignalRReaction);

      startAuthMonitor();

      const onChatPage = page.url().includes('/chat');
      const subscriptionReady = isSignalRSubscriptionReady(signalRStatus);

      // Gap-fill: wide window on first boot, today-only on reconnect (non-blocking)
      const initialBoot = isFirstBoot;
      const daysBack = isFirstBoot ? INITIAL_BACKFILL_DAYS : 0;
      gapFill(
        daysBack,
        initialBoot ? undefined : onStoredMessage,
        !initialBoot,
      ).catch(() => {}); // errors already logged inside
      isFirstBoot = false;

      consecutiveFailures = 0;

      if (onChatPage && signalRStatus.addMessageConnected) {
        startMessageWatchdog();
        if (subscriptionReady) {
          sendSystemAlert({
            title: 'Chat room connected',
            message: 'Authenticated and listening for messages via SignalR',
            severity: 'info',
          });
          console.log('[Ingest] Listening for messages (SignalR)...');
          startRestSafetyNet(onStoredMessage);
          if (initialBoot) {
            syncTodayFromRest('startup', onStoredMessage).catch((err) => {
              handleRestSyncFailure('startup', err);
            });
            replayTodayStoredMessages(onStoredMessage).catch((err) => {
              console.warn('[Ingest] Today task replay failed:', err instanceof Error ? err.message : String(err));
            });
          }
        } else {
          // addMessage IS connected (broadcast via Clients.All), so live messages
          // still flow — only reactions are degraded. Rather than tearing the
          // browser down, soft-reload the page so its app code re-creates the
          // chatHub proxy. REST polling stays on as a safety net for reactions.
          console.warn('[Ingest] SignalR subscription degraded (reactions only):', signalRStatus);
          startPollingFallback(onStoredMessage);
          scheduleSubscriptionRecovery(page, onSignalRMessage, onSignalRReaction);
        }
      } else {
        // Fallback: poll REST API when browser can't reach the chat page or SignalR did not attach.
        sendSystemAlert({
          title: 'Chat room connected (polling mode)',
          message: onChatPage
            ? `${signalRStatus.details} — polling REST API every 15s`
            : 'Browser not on chat page — polling REST API every 15s',
          severity: onChatPage ? 'critical' : 'warning',
        });
        console.log('[Ingest] Using REST API polling fallback');
        startPollingFallback(onStoredMessage);
        if (initialBoot) {
          replayTodayStoredMessages(onStoredMessage).catch((err) => {
            console.warn('[Ingest] Today task replay failed:', err instanceof Error ? err.message : String(err));
          });
        }
        if (onChatPage) {
          scheduleSubscriptionRecovery(page, onSignalRMessage, onSignalRReaction);
        }
      }

      // Park here until browser dies
      await crashed;
      stopPollingFallback();
      stopRestSafetyNet();
      cancelSubscriptionRecovery();

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

// ─── REST API Polling Fallback ────────────────────────
// When the browser can't reach the chat page (SignalR unavailable),
// poll the REST search API every 15 seconds to pick up new messages.

let pollingTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 15_000;

function startPollingFallback(onStoredMessage?: StoredMessageHandler): void {
  if (pollingTimer) return;
  console.log('[Poll] Starting REST API polling (every 15s)');
  // Run immediately, then on interval
  syncTodayFromRest('polling', onStoredMessage).catch((err) => {
    handleRestSyncFailure('polling', err);
  });
  pollingTimer = setInterval(() => {
    syncTodayFromRest('polling', onStoredMessage).catch((err) => {
      handleRestSyncFailure('polling', err);
    });
  }, POLL_INTERVAL_MS);
}

function stopPollingFallback(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    console.log('[Poll] Stopped REST API polling');
  }
}

type RestSyncSource = 'polling' | 'safety-net' | 'startup';

async function syncTodayFromRest(
  source: RestSyncSource,
  onStoredMessage?: StoredMessageHandler,
): Promise<HistoricalDaySyncResult> {
  if (restSyncInFlight) {
    console.log(`[RestSync] Skipping ${source}: previous REST sync still running`);
    return { fetched: 0, saved: 0, savedMessages: [] };
  }

  restSyncInFlight = true;
  const today = isoToDateKey(new Date().toISOString());
  try {
    const result = await syncHistoricalDay(
      today,
      onStoredMessage
        ? (message) => handleStoredMessage(message, onStoredMessage)
        : undefined,
    );
    restPollingFailures = source === 'polling' ? 0 : restPollingFailures;
    restSafetyNetFailures = source !== 'polling' ? 0 : restSafetyNetFailures;

    if (source !== 'polling' && result.savedMessages.length > 0) {
      await handleRestRecoveredMessages(result.savedMessages, source);
    }

    return result;
  } finally {
    restSyncInFlight = false;
  }
}

function handleRestSyncFailure(source: RestSyncSource, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (source === 'polling') {
    restPollingFailures++;
  } else {
    restSafetyNetFailures++;
  }

  const failures = source === 'polling' ? restPollingFailures : restSafetyNetFailures;
  console.warn(`[RestSync] ${source} failed (${failures}): ${message}`);
  if (failures < REST_SYNC_ALERT_FAILURES) return;

  const now = new Date();
  if (!shouldSendRecoveryAlert(lastRestFailureAlertAt, now, REST_RECOVERY_ALERT_COOLDOWN_MS)) return;
  lastRestFailureAlertAt = now;
  sendSystemAlert({
    title: source === 'polling'
      ? 'REST polling fallback failing'
      : source === 'startup'
        ? 'REST startup catch-up failing'
        : 'REST message safety net failing',
    message: `${failures} consecutive REST sync failures. Last error: ${message}`,
    severity: 'critical',
  });
}

async function handleRestRecoveredMessages(
  messages: Message[],
  source: Extract<RestSyncSource, 'safety-net' | 'startup'>,
): Promise<void> {
  const now = new Date();
  const stale = staleRecoveredMessages(messages, now, REST_RECOVERY_GRACE_MS);
  if (stale.length === 0) return;

  const sample = stale
    .slice(0, 3)
    .map((message) => `${message.author} ${message.timestamp}: ${message.cleanText.slice(0, 80)}`)
    .join('\n');

  const restartBrowser = source === 'safety-net';
  console.error(`[RestSafetyNet] Recovered ${stale.length} missed message(s) via ${source}${restartBrowser ? '; restarting browser' : ''}`);
  if (shouldSendRecoveryAlert(lastRecoveryAlertAt, now, REST_RECOVERY_ALERT_COOLDOWN_MS)) {
    lastRecoveryAlertAt = now;
    await sendSystemAlert({
      title: source === 'startup' ? 'Recovered startup chat gap' : 'Recovered missed chat messages',
      message: source === 'startup'
        ? `REST startup catch-up found ${stale.length} same-day message(s) older than ${Math.round(REST_RECOVERY_GRACE_MS / 1000)}s that were not in the database. Tasks were created.\n\n${sample}`
        : `REST safety net found ${stale.length} message(s) older than ${Math.round(REST_RECOVERY_GRACE_MS / 1000)}s that SignalR had not processed. Tasks were created and the browser is restarting.\n\n${sample}`,
      severity: 'critical',
    });
  }

  if (restartBrowser) {
    closeBrowser().catch(() => {});
  }
}

async function replayTodayStoredMessages(onStoredMessage?: StoredMessageHandler): Promise<void> {
  if (!onStoredMessage) return;

  const today = isoToDateKey(new Date().toISOString());
  const start = new Date(`${today}T00:00:00.000Z`).toISOString();
  const rows = await db
    .select()
    .from(schema.messages)
    .where(gte(schema.messages.timestamp, start))
    .orderBy(asc(schema.messages.timestamp));

  if (rows.length === 0) return;
  console.log(`[Ingest] Replaying ${rows.length} stored same-day message(s) through task creation`);
  for (const message of rows) {
    await handleStoredMessage(message, onStoredMessage);
  }
}

async function handleStoredMessage(
  message: Message,
  onStoredMessage?: StoredMessageHandler,
): Promise<void> {
  if (!onStoredMessage) return;
  try {
    await onStoredMessage(message);
  } catch (err) {
    console.error('[Ingest] Stored message handler failed:', err);
    sendSystemAlert({
      title: 'Live task creation failed',
      message: `Message ${message.id} was stored but did not enter the live task pipeline: ${err instanceof Error ? err.message : String(err)}`,
      severity: 'critical',
    });
  }
}

// ─── Dedup Helpers ───────────────────────────────────

const DEDUP_WINDOW_MS = 60_000; // 60-second window for near-duplicate detection

// ─── Message Processing ──────────────────────────────

async function processMessage(msg: SignalRMessage): Promise<Message | null> {
  if (typeof msg.MessageText !== 'string' || !msg.MessageText) {
    console.warn('[Ingest] Message with empty/missing text from', msg.User?.Name ?? 'unknown', '— dropped');
    return null;
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
    return null;
  }

  const reactions = compactReactions(msg.Reactions);

  const [inserted] = await db.insert(schema.messages).values({
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
  }).onConflictDoNothing().returning();

  const badge = classification.badges.length > 0 ? `[${classification.badges.join(',')}]` : '';
  console.log(`[Ingest] ${author} ${badge}: ${classification.cleanText.substring(0, 80)}`);
  return inserted ?? null;
}

// ─── Reaction Updates ───────────────────────────────

async function processReactionUpdate(update: ReactionUpdate): Promise<void> {
  const [row] = await db.update(schema.messages)
    .set({ reactions: update.reactions })
    .where(eq(schema.messages.id, update.messageId))
    .returning({ id: schema.messages.id });

  if (row) {
    console.log(`[Ingest] Reactions updated for msg ${update.messageId}: ${update.reactions.map(r => `${r.Type}:${r.Count}`).join(', ')}`);
  }
}

export { closeBrowser } from './browser.js';
