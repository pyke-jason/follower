import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchTickWindow } from './databento-tape.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchTickWindow', () => {
  test('wraps Databento stream timeouts as quote dependency outages', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          '{"symbol":"AAPL","high":"200.20","low":"200.00","ts_event":"2025-09-03T14:47:00.000Z"}\n',
        ));
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        controller.error(err);
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));

    await expect(fetchTickWindow({
      apiKey: 'test-key',
      dataset: 'DBEQ.BASIC',
      symbols: ['AAPL'],
      start: new Date('2025-09-03T14:46:00.000Z'),
      end: new Date('2025-09-03T14:48:00.000Z'),
    })).rejects.toMatchObject({
      name: 'DependencyUnavailableError',
      dependency: 'quotes',
    });
  });
});
