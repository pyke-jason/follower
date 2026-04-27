import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { runTx, schema } from '../db/client.js';
import { isMarketHoursWithBuffer, nextMarketOpenWithBufferUTC } from './et-date.js';
import { PATHS } from './paths.js';

type Severity = 'critical' | 'warning' | 'info';

type AlertField = { name: string; value: string; inline?: boolean };

type SystemAlertParams = {
  title: string;
  message: string;
  severity: Severity;
  fields?: AlertField[];
  /**
   * If provided, suppress the Pushover page when another page with the same
   * key was sent within PUSHOVER_COOLDOWN_SECONDS (default 1800). Survives
   * backend restarts via the pushover_cooldowns table.
   */
  cooldownKey?: string;
};

type SendPushoverOptions = {
  /** See SystemAlertParams.cooldownKey. */
  cooldownKey?: string;
  severity?: Severity;
};

const DEFAULT_PUSHOVER_COOLDOWN_SECONDS = 1800;

function pushoverCooldownSeconds(): number {
  const raw = process.env.PUSHOVER_COOLDOWN_SECONDS;
  if (!raw) return DEFAULT_PUSHOVER_COOLDOWN_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PUSHOVER_COOLDOWN_SECONDS;
}

/**
 * Atomic check-and-set against pushover_cooldowns. Returns true if the page
 * should proceed (no recent entry, or window elapsed) and updates the row to
 * "now". Returns false if a recent page was already sent within the window.
 *
 * Never throws — alerting must not crash callers. On DB error we err on the
 * side of paging (return true) so we don't silently drop critical alerts.
 */
async function shouldSendPushover(
  cooldownKey: string,
  title: string,
  severity: Severity | undefined,
): Promise<boolean> {
  const cooldownMs = pushoverCooldownSeconds() * 1000;
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    return await runTx(async (tx) => {
      const existing = await tx
        .select({ lastPagedAt: schema.pushoverCooldowns.lastPagedAt })
        .from(schema.pushoverCooldowns)
        .where(eq(schema.pushoverCooldowns.alertKey, cooldownKey))
        .limit(1);

      const row = existing[0];
      if (row) {
        const last = Date.parse(row.lastPagedAt);
        if (Number.isFinite(last) && now.getTime() - last < cooldownMs) {
          return false;
        }
      }

      await tx
        .insert(schema.pushoverCooldowns)
        .values({
          alertKey: cooldownKey,
          lastPagedAt: nowIso,
          severity: severity ?? null,
          title,
        })
        .onConflictDoUpdate({
          target: schema.pushoverCooldowns.alertKey,
          set: {
            lastPagedAt: nowIso,
            severity: severity ?? null,
            title,
          },
        });
      return true;
    });
  } catch (err) {
    console.warn('[Alert] Pushover cooldown check failed; sending anyway:', err);
    return true;
  }
}

const COLORS: Record<Severity, number> = {
  critical: 0xff0000, // Red
  warning: 0xffaa00,  // Yellow
  info: 0x0099ff,     // Blue
};

const PUSHOVER_QUEUE_RETRY_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

const pushoverPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  message: z.string(),
  queuedAt: z.string(),
});

type PushoverPage = z.infer<typeof pushoverPageSchema>;

const pushoverQueueSchema = z.array(pushoverPageSchema);

let pushoverQueue: PushoverPage[] | null = null;
let pushoverQueuePathLoaded: string | null = null;
let pushoverQueueLock: Promise<void> = Promise.resolve();
let pushoverQueueTimer: ReturnType<typeof setTimeout> | null = null;

function pushoverQueuePath(): string {
  return process.env.PUSHOVER_QUEUE_FILE ?? join(PATHS.data, 'pushover-queue.json');
}

async function runWithPushoverQueue<T>(fn: () => Promise<T>): Promise<T> {
  const previous = pushoverQueueLock;
  let release: () => void = () => {};
  pushoverQueueLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function loadPushoverQueue(): Promise<PushoverPage[]> {
  const queuePath = pushoverQueuePath();
  if (pushoverQueue && pushoverQueuePathLoaded === queuePath) return pushoverQueue;

  try {
    const raw = await readFile(queuePath, 'utf-8');
    pushoverQueue = pushoverQueueSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code !== 'ENOENT') {
      console.warn('[Alert] Failed to load Pushover queue:', err);
    }
    pushoverQueue = [];
  }

  pushoverQueuePathLoaded = queuePath;
  return pushoverQueue;
}

async function savePushoverQueue(queue: PushoverPage[]): Promise<void> {
  const queuePath = pushoverQueuePath();
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
  pushoverQueue = queue;
  pushoverQueuePathLoaded = queuePath;
}

async function enqueuePushoverPage(title: string, message: string): Promise<void> {
  await runWithPushoverQueue(async () => {
    const queue = await loadPushoverQueue();
    queue.push({ id: randomUUID(), title, message, queuedAt: new Date().toISOString() });
    await savePushoverQueue(queue);
  });
}

async function deliverPushoverPage(page: PushoverPage): Promise<boolean> {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) {
    console.warn('[Alert] Pushover credentials are not set; queued page retained');
    return false;
  }

  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        user,
        title: page.title,
        message: page.message,
        priority: 2,
        retry: 60,
        expire: 600,
        sound: 'siren',
      }),
    });
    if (!res.ok) {
      console.warn(`[Alert] Pushover responded ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Alert] Pushover request failed:', err);
    return false;
  }
}

function schedulePushoverQueueFlush(delayMs: number): void {
  if (pushoverQueueTimer) return;
  const boundedDelay = Math.min(Math.max(delayMs, 0), MAX_TIMEOUT_MS);
  pushoverQueueTimer = setTimeout(() => {
    pushoverQueueTimer = null;
    void flushQueuedPushoverPages();
  }, boundedDelay);
  pushoverQueueTimer.unref?.();
}

function scheduleNextPushoverQueueFlush(now: Date): void {
  const nextOpen = nextMarketOpenWithBufferUTC(now);
  if (!nextOpen) return;
  schedulePushoverQueueFlush(nextOpen.getTime() - now.getTime());
}

async function flushQueuedPushoverPages(): Promise<void> {
  if (process.env.ALERTS_PUSHOVER_ENABLED === '0') return;

  await runWithPushoverQueue(async () => {
    const queue = await loadPushoverQueue();
    if (queue.length === 0) return;

    const now = new Date();
    if (!isMarketHoursWithBuffer(now)) {
      scheduleNextPushoverQueueFlush(now);
      return;
    }

    while (queue.length > 0) {
      const delivered = await deliverPushoverPage(queue[0]);
      if (!delivered) {
        schedulePushoverQueueFlush(PUSHOVER_QUEUE_RETRY_MS);
        return;
      }
      queue.shift();
      await savePushoverQueue(queue);
    }
  });
}

export async function startPushoverQueue(): Promise<void> {
  await flushQueuedPushoverPages();
}

export function stopPushoverQueue(): void {
  if (!pushoverQueueTimer) return;
  clearTimeout(pushoverQueueTimer);
  pushoverQueueTimer = null;
}

/**
 * Send an emergency push notification via Pushover.
 * Never throws — alerting must not crash callers.
 * Queues outside buffered market hours and flushes once paging is allowed.
 *
 * When `options.cooldownKey` is provided, the page is gated by the
 * pushover_cooldowns table (cross-restart dedupe) using
 * PUSHOVER_COOLDOWN_SECONDS (default 1800). Without a cooldownKey the
 * behavior is unchanged — every call enqueues.
 */
export async function sendPushover(
  title: string,
  message: string,
  options: SendPushoverOptions = {},
): Promise<void> {
  if (process.env.ALERTS_PUSHOVER_ENABLED === '0') return;

  if (options.cooldownKey) {
    const proceed = await shouldSendPushover(options.cooldownKey, title, options.severity);
    if (!proceed) return;
  }

  try {
    await enqueuePushoverPage(title, message);
    await flushQueuedPushoverPages();
  } catch (err) {
    console.warn('[Alert] Failed to queue Pushover page:', err);
  }
}

/**
 * Send a system alert to Discord and console.
 * Never throws — alerting must not crash callers.
 */
export async function sendSystemAlert(params: SystemAlertParams): Promise<void> {
  const { title, message, severity, fields, cooldownKey } = params;

  // Always log to console first (survives Discord outages)
  const logFn = severity === 'critical' ? console.error : severity === 'warning' ? console.warn : console.log;
  logFn(`[Alert:${severity.toUpperCase()}] ${title}: ${message}`);

  if (process.env.ALERTS_DISCORD_ENABLED !== '0') {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        const embed: Record<string, unknown> = {
          title: `[${severity.toUpperCase()}] ${title}`,
          description: message,
          color: COLORS[severity],
          timestamp: new Date().toISOString(),
        };
        if (fields?.length) {
          embed.fields = fields;
        }

        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'Trade Follower',
            embeds: [embed],
          }),
        });
        if (!res.ok) {
          console.warn(`[Alert] Discord webhook responded ${res.status}`);
        }
      } catch (err) {
        console.warn('[Alert] Discord webhook request failed:', err);
      }
    }
  }

  if (severity === 'critical') {
    await sendPushover(title, message, { cooldownKey, severity });
  }
}
