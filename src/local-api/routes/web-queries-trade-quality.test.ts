import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { CREATE_TRADES_SQL } from '@/backtest/test-fixtures.js';

vi.mock('@/db/client.js', async () => {
  const { createPgTestClient } = await import('@/test/pg-test-client.js');
  return createPgTestClient('web_queries_trade_quality');
});

import { db, schema } from '@/db/client.js';
import app from './web-queries.js';

const CHANNEL_ID = 'bt:quality-route';

beforeAll(async () => {
  await db.execute(CREATE_TRADES_SQL);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM trades`);
});

describe('GET /trade-quality', () => {
  test('returns quality coverage and bucket summaries for scoped closed trades', async () => {
    await db.insert(schema.trades).values([
      {
        id: 'winner',
        trader: 'tester',
        symbol: 'SPY',
        direction: 'LONG',
        strategy: 'CALL',
        legs: [],
        status: 'CLOSED',
        entryPrice: '1',
        exitPrice: '3',
        quantity: 1,
        pnl: '200',
        openedAt: '2026-04-20T14:00:00.000Z',
        closedAt: '2026-04-20T15:00:00.000Z',
        channelId: CHANNEL_ID,
        metadata: {
          flags: ['slippage'],
          risk: {
            currentRisk: 100,
            peakRisk: 100,
            basis: 'premium_paid',
            confidence: 'exact',
            multiplier: 100,
            notes: [],
          },
        },
      },
      {
        id: 'stock',
        trader: 'tester',
        symbol: 'AAPL',
        direction: 'LONG',
        strategy: 'STOCK',
        legs: [],
        status: 'CLOSED',
        entryPrice: '100',
        exitPrice: '101',
        quantity: 1,
        pnl: '1',
        openedAt: '2026-04-20T14:00:00.000Z',
        closedAt: '2026-04-20T15:00:00.000Z',
        channelId: CHANNEL_ID,
        metadata: {},
      },
      {
        id: 'other-channel',
        trader: 'tester',
        symbol: 'MSFT',
        direction: 'LONG',
        strategy: 'CALL',
        legs: [],
        status: 'CLOSED',
        entryPrice: '1',
        exitPrice: '3',
        quantity: 1,
        pnl: '200',
        openedAt: '2026-04-20T14:00:00.000Z',
        closedAt: '2026-04-20T15:00:00.000Z',
        channelId: 'bt:other',
        metadata: {},
      },
    ]);

    const res = await app.request(`/trade-quality?channel=${CHANNEL_ID}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.coverage).toMatchObject({
      closedTrades: 2,
      withFiniteRisk: 1,
      excluded: 1,
      medianFiniteRisk: 100,
    });
    expect(body.rBuckets.find((bucket: { label: string }) => bucket.label === '+1..+2')?.count).toBe(1);
    expect(body.flagCounts).toEqual([{ flag: 'slippage', count: 1 }]);
  });
});
