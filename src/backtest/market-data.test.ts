import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { QuoteTick } from './databento-tape.js';
import { DependencyUnavailableError } from '../lib/errors.js';
import type { TickCacheStore } from './tick-cache-store.js';

const mocks = vi.hoisted(() => ({
  fetchTickWindow: vi.fn(),
  readCachedRanges: vi.fn(),
  readCachedTicks: vi.fn(),
  writeCachedTicks: vi.fn(),
  loadCachedChain: vi.fn(),
  saveCachedChain: vi.fn(),
}));

vi.mock('./databento-tape.js', async () => {
  const actual = await vi.importActual<typeof import('./databento-tape.js')>('./databento-tape.js');
  return {
    ...actual,
    fetchTickWindow: mocks.fetchTickWindow,
  };
});

import { DatabentoMarketDataProvider } from './market-data.js';

function makeTick(symbol: string, iso: string, bid = 10, ask = 10.2): QuoteTick {
  return {
    symbol,
    bid,
    ask,
    timestamp: new Date(iso),
  };
}

const mockTickCacheStore: TickCacheStore = {
  readCachedRanges: (dataset, dbnSchema, symbol) => mocks.readCachedRanges(dataset, dbnSchema, symbol),
  readCachedTicks: (symbol, dbnSchema) => mocks.readCachedTicks(symbol, dbnSchema),
  writeCachedTicks: (dataset, dbnSchema, symbol, ticks, range) =>
    mocks.writeCachedTicks(dataset, dbnSchema, symbol, ticks, range),
  loadCachedChain: (dataset, parentSymbol, day) => mocks.loadCachedChain(dataset, parentSymbol, day),
  saveCachedChain: (dataset, parentSymbol, day, defs) =>
    mocks.saveCachedChain(dataset, parentSymbol, day, defs),
};

describe('DatabentoMarketDataProvider cache behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeCachedTicks.mockResolvedValue(true);
  });

  test('refreshes an existing in-memory symbol from the persistent cache before refetching', async () => {
    const provider = new DatabentoMarketDataProvider(
      'test-key',
      mockTickCacheStore,
      'DBEQ.BASIC',
      false,
      'OPRA.PILLAR',
    );

    const at = new Date('2025-09-03T14:47:00.000Z');
    const startMs = Date.UTC(2025, 8, 3, 14, 46, 0);
    const endMs = Date.UTC(2025, 8, 3, 14, 48, 0);
    const cachedTick = makeTick('ADBE', '2025-09-03T14:47:00.000Z', 344, 344.4);

    ((provider as unknown) as { tickCache: Map<string, { ranges: [number, number][]; ticks: QuoteTick[] }> }).tickCache.set('ADBE', {
      ranges: [[Date.UTC(2025, 8, 3, 14, 30, 0), Date.UTC(2025, 8, 3, 14, 31, 0)]],
      ticks: [makeTick('ADBE', '2025-09-03T14:30:30.000Z', 340, 340.4)],
    });

    mocks.readCachedRanges.mockResolvedValue([[startMs, endMs]]);
    mocks.readCachedTicks.mockResolvedValue([cachedTick]);
    mocks.fetchTickWindow.mockResolvedValue([]);

    await provider.prefetch(['ADBE'], at);

    expect(mocks.fetchTickWindow).not.toHaveBeenCalled();
    expect(provider.getPriceSnapshot(['ADBE']).ADBE).toBe(344.2);
  });

  test('getExpiryDates uses cached ohlcv-1d probe windows instead of hitting the network', async () => {
    const provider = new DatabentoMarketDataProvider(
      'test-key',
      mockTickCacheStore,
      'DBEQ.BASIC',
      false,
      'OPRA.PILLAR',
    );

    const at = new Date('2025-09-03T14:47:00.000Z');
    const dayStartMs = Date.UTC(2025, 8, 3, 0, 0, 0);
    const dayEndMs = dayStartMs + 2 * 24 * 60 * 60 * 1000;

    mocks.readCachedRanges.mockImplementation(async (dataset, schema, symbol) => {
      if (dataset === 'DBEQ.BASIC' && schema === 'ohlcv-1m' && symbol === 'AAPL') {
        return [[Date.UTC(2025, 8, 3, 14, 46, 0), Date.UTC(2025, 8, 3, 14, 48, 0)]];
      }
      if (dataset === 'OPRA.PILLAR' && schema === 'ohlcv-1d') {
        return [[dayStartMs, dayEndMs]];
      }
      return [];
    });

    mocks.readCachedTicks.mockImplementation(async (symbol, schema) => {
      if (schema === 'ohlcv-1m' && symbol === 'AAPL') {
        return [makeTick('AAPL', '2025-09-03T14:47:00.000Z', 200, 200.2)];
      }
      if (schema === 'ohlcv-1d') {
        return [makeTick(symbol, '2025-09-04T00:00:00.000Z', 1, 1.2)];
      }
      return [];
    });

    mocks.fetchTickWindow.mockResolvedValue([]);

    const expiries = await provider.getExpiryDates('AAPL', at);

    expect(mocks.fetchTickWindow).not.toHaveBeenCalled();
    expect(expiries.length).toBeGreaterThan(0);
  });

  test('pauses and retries when a batch fetch loses quote connectivity', async () => {
    const onDependencyUnavailable = vi.fn(async () => {});
    const provider = new DatabentoMarketDataProvider(
      'test-key',
      mockTickCacheStore,
      'DBEQ.BASIC',
      false,
      'OPRA.PILLAR',
      onDependencyUnavailable,
    );

    const at = new Date('2025-09-03T14:47:00.000Z');
    mocks.readCachedRanges.mockResolvedValue([]);
    mocks.readCachedTicks.mockResolvedValue([]);
    mocks.fetchTickWindow
      .mockRejectedValueOnce(new DependencyUnavailableError('quotes', 'quote network offline'))
      .mockResolvedValueOnce([makeTick('AAPL', '2025-09-03T14:47:00.000Z', 200, 200.2)]);

    await provider.prefetch(['AAPL'], at);

    expect(onDependencyUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.fetchTickWindow).toHaveBeenCalledTimes(2);
    expect(provider.getPriceSnapshot(['AAPL']).AAPL).toBe(200.1);
  });

  test('continues when the persistent tick cache stays busy', async () => {
    const provider = new DatabentoMarketDataProvider(
      'test-key',
      mockTickCacheStore,
      'DBEQ.BASIC',
      false,
      'OPRA.PILLAR',
    );

    const at = new Date('2025-09-03T14:47:00.000Z');
    mocks.readCachedRanges.mockResolvedValue([]);
    mocks.readCachedTicks.mockResolvedValue([]);
    mocks.fetchTickWindow.mockResolvedValue([makeTick('AAPL', '2025-09-03T14:47:00.000Z', 200, 200.2)]);
    mocks.writeCachedTicks.mockResolvedValue(false);

    await expect(provider.prefetch(['AAPL'], at)).resolves.toBeUndefined();

    expect(mocks.writeCachedTicks).toHaveBeenCalledTimes(1);
    expect(provider.getPriceSnapshot(['AAPL']).AAPL).toBe(200.1);
  });
});
