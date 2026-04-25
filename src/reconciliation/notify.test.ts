import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { stopPushoverQueue } from '../lib/alert.js';
import { sendDiscordAlert } from './notify.js';

async function readQueueLength(queueFile: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await readFile(queueFile, 'utf-8'));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

describe('reconciliation notifications', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let queueFile: string;

  beforeEach(() => {
    vi.useFakeTimers();
    queueFile = join(tmpdir(), `trade-follower-recon-pushover-${randomUUID()}.json`);
    fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ALERTS_DISCORD_ENABLED', '1');
    vi.stubEnv('ALERTS_PUSHOVER_ENABLED', '1');
    vi.stubEnv('DISCORD_WEBHOOK_URL', 'https://discord.example/webhook');
    vi.stubEnv('PUSHOVER_APP_TOKEN', 'app-token');
    vi.stubEnv('PUSHOVER_USER_KEY', 'user-key');
    vi.stubEnv('PUSHOVER_QUEUE_FILE', queueFile);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    stopPushoverQueue();
    await rm(queueFile, { force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('sends Discord outside the buffered market window', async () => {
    vi.setSystemTime(new Date('2026-01-06T17:01:00-05:00'));

    await sendDiscordAlert([{
      type: 'DB_ONLY',
      symbol: 'AAPL',
      tradeId: 'trade-1',
      expected: { quantity: 1 },
      actual: null,
    }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.example/webhook',
      expect.objectContaining({ method: 'POST' }),
    );
    await expect(readQueueLength(queueFile)).resolves.toBe(1);
  });
});
