import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sendPushover,
  sendSystemAlert,
  stopPushoverQueue,
} from './alert.js';

async function readQueueLength(queueFile: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await readFile(queueFile, 'utf-8'));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

describe('alert transport behavior', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let queueFile: string;

  beforeEach(() => {
    vi.useFakeTimers();
    queueFile = join(tmpdir(), `trade-follower-pushover-${randomUUID()}.json`);
    fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ALERTS_DISCORD_ENABLED', '1');
    vi.stubEnv('ALERTS_PUSHOVER_ENABLED', '1');
    vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://discord.example/webhook');
    vi.stubEnv('PUSHOVER_APP_TOKEN', 'app-token');
    vi.stubEnv('PUSHOVER_USER_KEY', 'user-key');
    vi.stubEnv('PUSHOVER_QUEUE_FILE', queueFile);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    stopPushoverQueue();
    await rm(queueFile, { force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('sends Discord and Pushover inside the buffered market window', async () => {
    vi.setSystemTime(new Date('2026-01-06T08:30:00-05:00'));

    await sendSystemAlert({
      title: 'Broker disconnected',
      message: 'IBKR health check failed',
      severity: 'critical',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://discord.example/webhook',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.pushover.net/1/messages.json',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('sends Discord but queues Pushover pages outside the buffered window', async () => {
    vi.setSystemTime(new Date('2026-01-06T17:01:00-05:00'));

    await sendSystemAlert({
      title: 'Broker disconnected',
      message: 'IBKR health check failed',
      severity: 'critical',
    });

    expect(consoleError).toHaveBeenCalledWith(
      '[Alert:CRITICAL] Broker disconnected: IBKR health check failed',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.example/webhook',
      expect.objectContaining({ method: 'POST' }),
    );
    await expect(readQueueLength(queueFile)).resolves.toBe(1);
  });

  test('queues critical Pushover pages even when Discord is disabled', async () => {
    vi.setSystemTime(new Date('2026-01-06T17:01:00-05:00'));
    vi.stubEnv('ALERTS_DISCORD_ENABLED', '0');

    await sendSystemAlert({
      title: 'Broker disconnected',
      message: 'IBKR health check failed',
      severity: 'critical',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readQueueLength(queueFile)).resolves.toBe(1);
  });

  test('flushes queued Pushover pages when the next buffered window opens', async () => {
    vi.setSystemTime(new Date('2026-01-06T17:01:00-05:00'));

    await sendPushover('Reconciliation: DB_ONLY', 'Position drift detected');

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readQueueLength(queueFile)).resolves.toBe(1);

    await vi.advanceTimersByTimeAsync(15 * 60 * 60 * 1000 + 29 * 60 * 1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.pushover.net/1/messages.json',
      expect.objectContaining({ method: 'POST' }),
    );
    await expect(readQueueLength(queueFile)).resolves.toBe(0);
  });
});
