import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { occToIBKR, normalizeIbkrTicker, resolveContract, resolveStockContract, clearContractCache } from './symbology.js';

// ── occToIBKR ───────────────────────────────────────────────────────

describe('occToIBKR', () => {
  test('parses a standard 4-char CALL', () => {
    // AAPL  260221C00250000 = AAPL Feb 21 2026 $250 Call
    const result = occToIBKR('AAPL  260221C00250000');
    expect(result).toEqual({
      symbol: 'AAPL',
      secType: 'OPT',
      expiry: '20260221',
      strike: 250,
      right: 'C',
    });
  });

  test('parses a 3-char SPY PUT', () => {
    // SPY   260117P00600000 = SPY Jan 17 2026 $600 Put
    const result = occToIBKR('SPY   260117P00600000');
    expect(result).toEqual({
      symbol: 'SPY',
      secType: 'OPT',
      expiry: '20260117',
      strike: 600,
      right: 'P',
    });
  });

  test('parses a fractional strike ($37.50)', () => {
    // NVDA  260221C00037500 = NVDA $37.50 Call
    const result = occToIBKR('NVDA  260221C00037500');
    expect(result?.strike).toBe(37.5);
  });

  test('returns null for a plain stock ticker', () => {
    expect(occToIBKR('AAPL')).toBeNull();
  });

  test('returns null for a 20-char string (whitespace-collapsed OCC — broken format)', () => {
    // "AAPL 260221C00250000" — single space instead of double, 20 chars total
    expect(occToIBKR('AAPL 260221C00250000')).toBeNull();
  });
});

// ── normalizeIbkrTicker ─────────────────────────────────────────────

describe('normalizeIbkrTicker', () => {
  test('converts dot to space for BRK.B', () => {
    expect(normalizeIbkrTicker('BRK.B')).toBe('BRK B');
  });

  test('converts dot to space for BF.B', () => {
    expect(normalizeIbkrTicker('BF.B')).toBe('BF B');
  });

  test('leaves plain tickers unchanged', () => {
    expect(normalizeIbkrTicker('AAPL')).toBe('AAPL');
    expect(normalizeIbkrTicker('NVDA')).toBe('NVDA');
    expect(normalizeIbkrTicker('SPY')).toBe('SPY');
  });

  test('handles multiple dots (edge case)', () => {
    expect(normalizeIbkrTicker('A.B.C')).toBe('A B C');
  });
});

// ── resolveContract — multiplier validation ─────────────────────────

describe('resolveContract multiplier validation', () => {
  beforeEach(() => {
    clearContractCache();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockSidecarResponse(body: object, status = 200) {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response);
  }

  test('resolves successfully when multiplier is "100"', async () => {
    mockSidecarResponse({
      conId: 12345,
      localSymbol: 'AAPL  260221C00250000',
      multiplier: '100',
      exchange: 'CBOE',
      minTick: 0.01,
    });

    const result = await resolveContract('AAPL  260221C00250000', 'http://localhost:8090/api');
    expect(result).toEqual({ conId: 12345, minTick: 0.01 });
  });

  test('throws when multiplier is "10" (mini-option)', async () => {
    mockSidecarResponse({
      conId: 99999,
      localSymbol: 'AAPL  260221C00250000',
      multiplier: '10',
      exchange: 'CBOE',
      minTick: 0.01,
    });

    await expect(resolveContract('AAPL  260221C00250000', 'http://localhost:8090/api'))
      .rejects.toThrow(/unexpected multiplier "10"/);
  });

  test('throws when multiplier is "1" (non-standard)', async () => {
    mockSidecarResponse({
      conId: 88888,
      localSymbol: 'AAPL  260221C00250000',
      multiplier: '1',
      exchange: 'CBOE',
      minTick: 0.01,
    });

    await expect(resolveContract('AAPL  260221C00250000', 'http://localhost:8090/api'))
      .rejects.toThrow(/unexpected multiplier "1"/);
  });

  test('does not cache on multiplier error (allows retry after fix)', async () => {
    mockSidecarResponse({
      conId: 77777,
      localSymbol: 'AAPL  260221C00250000',
      multiplier: '10',
      exchange: 'CBOE',
      minTick: 0.01,
    });

    await expect(resolveContract('AAPL  260221C00250000', 'http://localhost:8090/api')).rejects.toThrow();

    // Second call should hit the sidecar again (not serve from cache)
    mockSidecarResponse({
      conId: 77777,
      localSymbol: 'AAPL  260221C00250000',
      multiplier: '100',
      exchange: 'CBOE',
      minTick: 0.01,
    });

    const result = await resolveContract('AAPL  260221C00250000', 'http://localhost:8090/api');
    expect(result.conId).toBe(77777);
  });

  test('caches successful resolution and avoids second fetch', async () => {
    mockSidecarResponse({
      conId: 12345,
      localSymbol: 'AAPL  260221C00250000',
      multiplier: '100',
      exchange: 'CBOE',
      minTick: 0.01,
    });

    await resolveContract('AAPL  260221C00250000', 'http://localhost:8090/api');
    // Second call — no mock registered, would throw if fetch was called
    const result = await resolveContract('AAPL  260221C00250000', 'http://localhost:8090/api');
    expect(result.conId).toBe(12345);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ── resolveStockContract — ticker normalization + TTL cache ─────────

describe('resolveStockContract', () => {
  beforeEach(() => {
    clearContractCache();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockSidecarResponse(body: object, status = 200) {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response);
  }

  function stockResponse(conId: number) {
    return {
      conId,
      localSymbol: 'BRK B',
      multiplier: '1',
      exchange: 'NYSE',
      minTick: 0.01,
    };
  }

  test('normalizes BRK.B to BRK B in sidecar request body', async () => {
    mockSidecarResponse(stockResponse(55555));

    await resolveStockContract('BRK.B', 'http://localhost:8090/api');

    const [, options] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.symbol).toBe('BRK B');
  });

  test('normalizes BF.B to BF B in sidecar request body', async () => {
    mockSidecarResponse(stockResponse(44444));

    await resolveStockContract('BF.B', 'http://localhost:8090/api');

    const [, options] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.symbol).toBe('BF B');
  });

  test('plain ticker is sent unchanged', async () => {
    mockSidecarResponse({ conId: 11111, localSymbol: 'AAPL', multiplier: '1', exchange: 'NASDAQ', minTick: 0.01 });

    await resolveStockContract('AAPL', 'http://localhost:8090/api');

    const [, options] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.symbol).toBe('AAPL');
  });

  test('serves from cache within 24h TTL', async () => {
    vi.useFakeTimers();
    mockSidecarResponse(stockResponse(55555));

    await resolveStockContract('BRK.B', 'http://localhost:8090/api');

    vi.advanceTimersByTime(23 * 60 * 60 * 1000); // 23h
    const result = await resolveStockContract('BRK.B', 'http://localhost:8090/api');
    expect(result.conId).toBe(55555);
    expect(fetch).toHaveBeenCalledTimes(1); // no second fetch

    vi.useRealTimers();
  });

  test('re-fetches after 24h TTL expires', async () => {
    vi.useFakeTimers();
    mockSidecarResponse(stockResponse(55555));
    await resolveStockContract('BRK.B', 'http://localhost:8090/api');

    vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25h

    mockSidecarResponse(stockResponse(66666)); // new conId after ticker reuse
    const result = await resolveStockContract('BRK.B', 'http://localhost:8090/api');
    expect(result.conId).toBe(66666);
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  test('BRK.B and BRK B hit the same cache entry', async () => {
    mockSidecarResponse(stockResponse(55555));

    await resolveStockContract('BRK.B', 'http://localhost:8090/api');
    // Second call with already-normalized symbol — should serve from cache
    const result = await resolveStockContract('BRK B', 'http://localhost:8090/api');
    expect(result.conId).toBe(55555);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
