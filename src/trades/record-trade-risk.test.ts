import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { CREATE_TRADE_EVENTS_SQL, CREATE_TRADES_SQL } from '../backtest/test-fixtures.js';
import type { TradeLeg } from '../db/schema.js';

vi.mock('../db/client.js', async () => {
  const { createPgTestClient } = await import('../test/pg-test-client.js');
  return createPgTestClient('record_trade_risk');
});

import { db, schema } from '../db/client.js';
import { recordTrade } from './record-trade.js';

const CHANNEL_ID = 'bt:risk-lifecycle';

function callLeg(strike: number, action: 'BUY' | 'SELL'): TradeLeg {
  return {
    symbol: 'SPY',
    strike,
    expiry: '2026-06-19',
    type: 'CALL',
    action,
    quantity: 1,
    fillPrice: action === 'BUY' ? 2 : 1,
  };
}

beforeAll(async () => {
  await db.execute(CREATE_TRADES_SQL);
  await db.execute(CREATE_TRADE_EVENTS_SQL);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM trade_events`);
  await db.execute(sql`DELETE FROM trades`);
});

async function getTrade(id: string) {
  const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, id));
  if (!trade) throw new Error(`missing trade ${id}`);
  return trade;
}

describe('recordTrade risk snapshots', () => {
  test('stores finite risk on open and preserves peak across add, trim, and close', async () => {
    const open = await recordTrade({
      action: 'OPEN',
      symbol: 'SPY',
      trader: 'tester',
      direction: 'LONG',
      strategy: 'CALL',
      entryPrice: 2,
      quantity: 1,
      legs: [callLeg(500, 'BUY')],
      openedAt: '2026-04-20T14:00:00.000Z',
      channelId: CHANNEL_ID,
    });
    expect(open?.trade.metadata.risk?.peakRisk).toBe(200);

    await recordTrade({
      action: 'ADD',
      tradeId: open?.tradeId,
      symbol: 'SPY',
      trader: 'tester',
      entryPrice: 4,
      quantity: 1,
      openedAt: '2026-04-20T14:05:00.000Z',
      channelId: CHANNEL_ID,
    });
    expect((await getTrade(open!.tradeId)).metadata.risk).toMatchObject({
      currentRisk: 600,
      peakRisk: 600,
    });

    await recordTrade({
      action: 'TRIM',
      tradeId: open?.tradeId,
      symbol: 'SPY',
      trader: 'tester',
      exitPrice: 5,
      closeQuantity: 1,
      closedAt: '2026-04-20T14:30:00.000Z',
      channelId: CHANNEL_ID,
    });
    expect((await getTrade(open!.tradeId)).metadata.risk).toMatchObject({
      currentRisk: 300,
      peakRisk: 600,
    });

    await recordTrade({
      action: 'CLOSE',
      tradeId: open?.tradeId,
      symbol: 'SPY',
      trader: 'tester',
      exitPrice: 6,
      closedAt: '2026-04-20T15:00:00.000Z',
      closeMessageId: 'close-msg',
      channelId: CHANNEL_ID,
    });

    const closed = await getTrade(open!.tradeId);
    expect(closed.status).toBe('CLOSED');
    expect(closed.metadata.risk?.peakRisk).toBe(600);
  });

  test('leg-off into kept-long freezes peak risk and flags topology change', async () => {
    const lower = callLeg(100, 'BUY');
    const higher = callLeg(105, 'SELL');
    const open = await recordTrade({
      action: 'OPEN',
      symbol: 'SPY',
      trader: 'tester',
      direction: 'LONG',
      strategy: 'CDS',
      entryPrice: 2,
      quantity: 1,
      legs: [lower, higher],
      openedAt: '2026-04-20T14:00:00.000Z',
      channelId: CHANNEL_ID,
    });
    expect(open?.trade.metadata.risk?.peakRisk).toBe(200);

    await recordTrade({
      action: 'LEG_OFF',
      tradeId: open?.tradeId,
      symbol: 'SPY',
      trader: 'tester',
      exitPrice: 0.5,
      legs: [{ ...higher, action: 'BUY' }],
      closedAt: '2026-04-20T14:20:00.000Z',
      channelId: CHANNEL_ID,
    });

    const trade = await getTrade(open!.tradeId);
    expect(trade.strategy).toBe('CALL');
    expect(trade.metadata.risk).toMatchObject({
      currentRisk: 250,
      peakRisk: 200,
      basis: 'premium_paid',
      riskTopologyChanged: true,
    });
  });

  test('leg-off into kept-short clears peak risk because position is now unbounded', async () => {
    const lower = callLeg(100, 'BUY');
    const higher = callLeg(105, 'SELL');
    const open = await recordTrade({
      action: 'OPEN',
      symbol: 'SPY',
      trader: 'tester',
      direction: 'LONG',
      strategy: 'CDS',
      entryPrice: 2,
      quantity: 1,
      legs: [lower, higher],
      openedAt: '2026-04-20T14:00:00.000Z',
      channelId: CHANNEL_ID,
    });
    expect(open?.trade.metadata.risk?.peakRisk).toBe(200);

    // Leg off the long K=100 leg, leaving the short K=105 leg (naked short call).
    await recordTrade({
      action: 'LEG_OFF',
      tradeId: open?.tradeId,
      symbol: 'SPY',
      trader: 'tester',
      exitPrice: 1,
      legs: [{ ...lower, action: 'SELL' }],
      closedAt: '2026-04-20T14:20:00.000Z',
      channelId: CHANNEL_ID,
    });

    const trade = await getTrade(open!.tradeId);
    expect(trade.strategy).toBe('CALL');
    expect(trade.direction).toBe('SHORT');
    expect(trade.metadata.risk?.basis).toBe('unbounded');
    expect(trade.metadata.risk?.currentRisk).toBeNull();
    expect(trade.metadata.risk?.peakRisk).toBeNull();
    expect(trade.metadata.risk?.riskTopologyChanged).toBe(true);
  });

  test('open populates plannedExitDate from MIN(legs.expiry); leg-off recomputes from kept leg', async () => {
    const lower = { ...callLeg(100, 'BUY'), expiry: '2026-06-19' };
    const higher = { ...callLeg(105, 'SELL'), expiry: '2026-05-15' };
    const open = await recordTrade({
      action: 'OPEN',
      symbol: 'SPY',
      trader: 'tester',
      direction: 'LONG',
      strategy: 'CDS',
      entryPrice: 2,
      quantity: 1,
      legs: [lower, higher],
      openedAt: '2026-04-20T14:00:00.000Z',
      channelId: CHANNEL_ID,
    });
    expect(open?.trade.plannedExitDate).toBe('2026-05-15');

    await recordTrade({
      action: 'LEG_OFF',
      tradeId: open?.tradeId,
      symbol: 'SPY',
      trader: 'tester',
      exitPrice: 0.5,
      legs: [{ ...higher, action: 'BUY' }],
      closedAt: '2026-04-20T14:20:00.000Z',
      channelId: CHANNEL_ID,
    });

    const trade = await getTrade(open!.tradeId);
    expect(trade.plannedExitDate).toBe('2026-06-19');
  });

  test('leg-off topology flag is preserved through subsequent close', async () => {
    const lower = callLeg(100, 'BUY');
    const higher = callLeg(105, 'SELL');
    const open = await recordTrade({
      action: 'OPEN',
      symbol: 'SPY',
      trader: 'tester',
      direction: 'LONG',
      strategy: 'CDS',
      entryPrice: 2,
      quantity: 1,
      legs: [lower, higher],
      openedAt: '2026-04-20T14:00:00.000Z',
      channelId: CHANNEL_ID,
    });

    await recordTrade({
      action: 'LEG_OFF',
      tradeId: open?.tradeId,
      symbol: 'SPY',
      trader: 'tester',
      exitPrice: 0.5,
      legs: [{ ...higher, action: 'BUY' }],
      closedAt: '2026-04-20T14:20:00.000Z',
      channelId: CHANNEL_ID,
    });

    await recordTrade({
      action: 'CLOSE',
      tradeId: open?.tradeId,
      symbol: 'SPY',
      trader: 'tester',
      exitPrice: 4,
      closedAt: '2026-04-20T15:00:00.000Z',
      closeMessageId: 'close-msg',
      channelId: CHANNEL_ID,
    });

    const closed = await getTrade(open!.tradeId);
    expect(closed.status).toBe('CLOSED');
    expect(closed.metadata.risk?.peakRisk).toBe(200);
    expect(closed.metadata.risk?.riskTopologyChanged).toBe(true);
  });
});
