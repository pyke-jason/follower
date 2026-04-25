import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { BrokerService } from '@/broker/interface.js';
import { CREATE_TRADE_EVENTS_SQL, CREATE_TRADES_SQL } from '@/backtest/test-fixtures.js';

vi.mock('../../db/client.js', async () => {
  const { createPgTestClient } = await import('../../test/pg-test-client.js');
  return createPgTestClient('web_orders');
});

import { db, schema } from '../../db/client.js';
import { createWebOrdersRouter } from './web-orders.js';

const CHANNEL_ID = 'ibkr:paper:test-account';

beforeAll(async () => {
  await db.execute(CREATE_TRADES_SQL);
  await db.execute(CREATE_TRADE_EVENTS_SQL);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM trade_events`);
  await db.execute(sql`DELETE FROM trades`);
});

function makeBroker(fillPrice: number, filledQuantity: number): BrokerService {
  const fillTimestamp = '2026-04-22T18:03:00.000Z';
  return {
    getQuote: vi.fn(async (symbol: string) => ({
      symbol,
      bid: fillPrice - 0.05,
      ask: fillPrice + 0.05,
      last: fillPrice,
      volume: 100,
      timestamp: fillTimestamp,
    })),
    placeOrder: vi.fn(async () => ({
      orderId: crypto.randomUUID(),
      status: 'FILLED' as const,
      filledPrice: fillPrice,
      filledQuantity,
      fillTimestamp,
    })),
    modifyOrder: vi.fn(async () => ({ orderId: crypto.randomUUID(), status: 'OPEN' as const })),
    cancelOrder: vi.fn(async () => ({ orderId: crypto.randomUUID(), status: 'CANCELLED' as const })),
    cancelAllOrders: vi.fn(async () => {}),
    getOrderStatus: vi.fn(async () => ({ orderId: crypto.randomUUID(), status: 'OPEN' as const })),
    getPositions: vi.fn(async () => []),
    getAccountBalance: vi.fn(async () => ({
      accountId: 'paper',
      cashBalance: 0,
      buyingPower: 0,
      equity: 0,
      marketValue: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      timestamp: fillTimestamp,
    })),
    isHealthy: vi.fn(async () => true),
    placeStopOrder: vi.fn(async () => ({ orderId: 'stop-order-id', status: 'OPEN' as const })),
  };
}

async function insertOpenStockTrade(quantity: number, entryPrice: number) {
  const tradeId = crypto.randomUUID();
  await db.insert(schema.trades).values({
    id: tradeId,
    trader: 'Chinospikes_35',
    symbol: 'AMD',
    direction: 'LONG',
    strategy: 'STOCK',
    legs: [{ symbol: 'AMD', type: 'STOCK', action: 'BUY', quantity, expiry: '2026-12-31', strike: 0 }],
    status: 'OPEN',
    entryPrice: String(entryPrice),
    quantity,
    channelId: CHANNEL_ID,
    openedAt: '2026-04-22T16:39:00.000Z',
    metadata: {},
  });
  return tradeId;
}

async function placeExitOrder(app: ReturnType<typeof createWebOrdersRouter>, tradeId: string, quantity: number) {
  return app.request('/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tradeId,
      channelId: CHANNEL_ID,
      orderType: 'MARKET',
      quantity,
    }),
  });
}

describe('createWebOrdersRouter manual exits', () => {
  test('filled full-size exit records CLOSE instead of ADD', async () => {
    const tradeId = await insertOpenStockTrade(10, 100);
    const app = createWebOrdersRouter(new Map([[CHANNEL_ID, makeBroker(110, 10)]]));

    const res = await placeExitOrder(app, tradeId, 10);

    expect(res.status).toBe(200);

    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, tradeId));
    const events = await db.select().from(schema.tradeEvents).where(eq(schema.tradeEvents.tradeId, tradeId));

    expect(trade.status).toBe('CLOSED');
    expect(trade.exitPrice).toBe('110');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('CLOSE');
  });

  test('filled partial exit records TRIM instead of ADD', async () => {
    const tradeId = await insertOpenStockTrade(10, 100);
    const app = createWebOrdersRouter(new Map([[CHANNEL_ID, makeBroker(110, 4)]]));

    const res = await placeExitOrder(app, tradeId, 4);

    expect(res.status).toBe(200);

    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, tradeId));
    const events = await db.select().from(schema.tradeEvents).where(eq(schema.tradeEvents.tradeId, tradeId));

    expect(trade.status).toBe('OPEN');
    expect(trade.quantity).toBe(6);
    expect(trade.realizedPnl).toBe('40');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('TRIM');
    expect(events[0]?.quantity).toBe(4);
  });
});
