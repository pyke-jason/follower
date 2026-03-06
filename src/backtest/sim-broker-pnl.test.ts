/**
 * Integration tests for P&L accuracy through the full SimBroker → recordTrade → DB flow.
 *
 * Unlike sim-broker-db.test.ts which inserts trades directly, these tests exercise
 * the actual placeOrder → fill → recordTrade → DB path to verify P&L correctness
 * end-to-end.
 *
 * Fill model: all tests use 'midpoint'. stubMarketData({SPY: 100}) produces
 * bid=99.95, ask=100.05 → midpoint fill = 100.00 exactly. Exit prices are
 * hardcoded integers. computeTradePnl rounds to cents. Therefore all P&L
 * values are exact — no tolerance needed.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';

// Mock db/client with a real in-memory SQLite + drizzle instance.
vi.mock('../db/client.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../db/schema.js');
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  return {
    db, schema, sqliteClient: sqlite,
    runTx: (cb: any) => db.transaction(cb),
    withBusyRetry: (fn: any) => fn(),
  };
});

import { db, schema } from '../db/client.js';
import { btChannel } from '../lib/channel.js';
import { SimBroker } from './sim-broker.js';
import { SimClock } from './clock.js';
import { recordTrade } from '../trades/record-trade.js';
import { computeTradePnl } from '../lib/pnl.js';
import { roundCents, safeParseFloat } from '../lib/numbers.js';

import {
  stubMarketData,
  makeStockBuyOrder,
  makeStockSellOrder,
  makeDbHelpers,
  CREATE_TRADES_SQL,
  CREATE_TRADE_EVENTS_SQL,
} from './test-fixtures.js';

// ── DB setup ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await db.run(CREATE_TRADES_SQL);
  await db.run(CREATE_TRADE_EVENTS_SQL);
});

const RUN_ID = 'pnl-test-run';
const TRADER = 'test-trader';
const CLOCK_TIME = new Date('2026-03-15T14:30:00Z');

const { resetDb } = makeDbHelpers(db, schema, RUN_ID);

function makeBroker(prices: Record<string, number> | number, startingEquity = 100_000) {
  return new SimBroker(stubMarketData(prices), new SimClock(CLOCK_TIME), btChannel(RUN_ID), 'midpoint', startingEquity);
}

/**
 * Place a MARKET order via SimBroker and record the OPEN trade via recordTrade.
 * Returns the trade ID and the fill price.
 */
async function openPosition(
  broker: SimBroker,
  opts: {
    symbol?: string;
    direction: 'LONG' | 'SHORT';
    quantity?: number;
  },
): Promise<{ tradeId: string; fillPrice: number }> {
  const symbol = opts.symbol ?? 'SPY';
  const quantity = opts.quantity ?? 1;
  const isLong = opts.direction === 'LONG';

  const orderParams = isLong
    ? makeStockBuyOrder({ symbol, legs: [{ symbol, strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity }] })
    : makeStockSellOrder({ symbol, legs: [{ symbol, strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'SELL', quantity }] });

  const result = await broker.placeOrder(orderParams);
  expect(result.status).toBe('FILLED');
  const fillPrice = result.filledPrice!;

  const recorded = await recordTrade({
    action: 'OPEN',
    symbol,
    trader: TRADER,
    direction: opts.direction,
    strategy: 'STOCK',
    entryPrice: fillPrice,
    quantity,
    legs: orderParams.legs,
    openedAt: CLOCK_TIME.toISOString(),
    channelId: btChannel(RUN_ID),
  });

  expect(recorded).not.toBeNull();
  return { tradeId: recorded!.tradeId, fillPrice };
}

// ── 1. STOCK LONG round-trip ─────────────────────────────────────────

describe('STOCK LONG round-trip', () => {
  beforeEach(async () => { await resetDb(); });

  test('BUY at 100, SELL at 110 → PnL = $10 exactly', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, { direction: 'LONG' });

    // midpoint fill: (99.95 + 100.05) / 2 = 100.00
    expect(entryPrice).toBe(100);

    // Verify the open trade is in the DB
    const [openTrade] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(openTrade.status).toBe('OPEN');
    expect(Number(openTrade.entryPrice)).toBe(100);

    // Close at 110 using SimBroker's closePositionAtPrice (calls recordTrade internally)
    const exitPrice = 110;
    const { pnl } = await broker.closePositionAtPrice(tradeId, exitPrice, CLOCK_TIME.toISOString());

    // LONG: (110 - 100) * 1 * 1 = $10
    const expectedPnl = 10;
    expect(pnl).toBe(expectedPnl);

    // Cross-check with computeTradePnl
    expect(computeTradePnl({
      entryPrice, exitPrice, direction: 'LONG', strategy: 'STOCK', quantity: 1,
    })).toBe(expectedPnl);

    // Verify DB state
    const [closedTrade] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(closedTrade.status).toBe('CLOSED');
    expect(Number(closedTrade.pnl)).toBe(expectedPnl);
    expect(Number(closedTrade.exitPrice)).toBe(exitPrice);
  });

  test('larger quantity: BUY 10 shares at 100, SELL at 110 → PnL = $100', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, {
      direction: 'LONG',
      quantity: 10,
    });

    expect(entryPrice).toBe(100);

    const exitPrice = 110;
    const { pnl } = await broker.closePositionAtPrice(tradeId, exitPrice, CLOCK_TIME.toISOString());

    // LONG: (110 - 100) * 10 * 1 = $100
    const expectedPnl = 100;
    expect(pnl).toBe(expectedPnl);

    const [closedTrade] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(Number(closedTrade.pnl)).toBe(expectedPnl);
  });
});

// ── 2. STOCK SHORT round-trip ────────────────────────────────────────

describe('STOCK SHORT round-trip', () => {
  beforeEach(async () => { await resetDb(); });

  test('SELL at 100, BUY to close at 90 → PnL = $10', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, { direction: 'SHORT' });

    expect(entryPrice).toBe(100);

    const exitPrice = 90;
    const { pnl } = await broker.closePositionAtPrice(tradeId, exitPrice, CLOCK_TIME.toISOString());

    // SHORT: (90 - 100) * -1 * 1 * 1 = $10
    const expectedPnl = 10;
    expect(pnl).toBe(expectedPnl);

    const [closedTrade] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(closedTrade.status).toBe('CLOSED');
    expect(Number(closedTrade.pnl)).toBe(expectedPnl);
  });

  test('SHORT 5 shares at 100, BUY to close at 90 → PnL = $50', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, {
      direction: 'SHORT',
      quantity: 5,
    });

    expect(entryPrice).toBe(100);

    const exitPrice = 90;
    const { pnl } = await broker.closePositionAtPrice(tradeId, exitPrice, CLOCK_TIME.toISOString());

    // SHORT: (90 - 100) * -1 * 5 * 1 = $50
    const expectedPnl = 50;
    expect(pnl).toBe(expectedPnl);
  });
});

// ── 3. LOSING trade ─────────────────────────────────────────────────

describe('Losing trade', () => {
  beforeEach(async () => { await resetDb(); });

  test('LONG STOCK: buy at 100, sell at 90 → PnL = -$10', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, { direction: 'LONG' });

    const exitPrice = 90;
    const { pnl } = await broker.closePositionAtPrice(tradeId, exitPrice, CLOCK_TIME.toISOString());

    // LONG: (90 - 100) * 1 * 1 * 1 = -$10
    const expectedPnl = -10;
    expect(pnl).toBe(expectedPnl);

    const [closedTrade] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(closedTrade.status).toBe('CLOSED');
    expect(Number(closedTrade.pnl)).toBe(expectedPnl);
  });

  test('SHORT STOCK: sell at 100, buy to close at 115 → PnL = -$15', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, { direction: 'SHORT' });

    const exitPrice = 115;
    const { pnl } = await broker.closePositionAtPrice(tradeId, exitPrice, CLOCK_TIME.toISOString());

    // SHORT: (115 - 100) * -1 * 1 * 1 = -$15
    const expectedPnl = -15;
    expect(pnl).toBe(expectedPnl);

    const [closedTrade] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(Number(closedTrade.pnl)).toBe(expectedPnl);
  });
});

// ── 4. forceCloseAll ─────────────────────────────────────────────────

describe('forceCloseAll', () => {
  beforeEach(async () => { await resetDb(); });

  test('open at 100 → forceCloseAll at same price → PnL = $0', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, { direction: 'LONG' });

    // forceCloseAll uses mid of bid/ask: (99.95 + 100.05) / 2 = 100 = same as entry
    const totalPnl = await broker.forceCloseAll(CLOCK_TIME);
    expect(totalPnl).toBe(0);

    const [closedTrade] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(closedTrade.status).toBe('CLOSED');
    expect(Number(closedTrade.pnl)).toBe(0);
    expect(closedTrade.closedAt).toBeDefined();
    expect(closedTrade.exitPrice).toBeDefined();
  });

  test('open at 100 → forceCloseAll with new price 120 → PnL = $20', async () => {
    // Open at 100
    const brokerOpen = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(brokerOpen, { direction: 'LONG' });
    expect(entryPrice).toBe(100);

    // Create new broker with updated price at 120 — same RUN_ID, same DB
    const brokerClose = new SimBroker(
      stubMarketData({ SPY: 120 }),
      new SimClock(CLOCK_TIME),
      btChannel(RUN_ID),
      'midpoint',
      100_000,
    );

    const totalPnl = await brokerClose.forceCloseAll(CLOCK_TIME);

    // LONG: (120 - 100) * 1 * 1 = $20
    expect(totalPnl).toBe(20);

    const [closedTrade] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(closedTrade.status).toBe('CLOSED');
    expect(Number(closedTrade.pnl)).toBe(20);
  });

  test('forceCloseAll on empty book returns 0', async () => {
    const broker = makeBroker({ SPY: 100 });
    const pnl = await broker.forceCloseAll(CLOCK_TIME);
    expect(pnl).toBe(0);
  });
});

// ── 5. Multiple positions ────────────────────────────────────────────

describe('Multiple positions', () => {
  beforeEach(async () => { await resetDb(); });

  test('open 2 different positions → close both → each has correct independent pnl', async () => {
    const broker = makeBroker({ SPY: 100, QQQ: 200 });
    const spy = await openPosition(broker, { symbol: 'SPY', direction: 'LONG' });
    const qqq = await openPosition(broker, { symbol: 'QQQ', direction: 'LONG' });

    expect(spy.fillPrice).toBe(100);
    expect(qqq.fillPrice).toBe(200);

    // Close SPY at 110 → LONG profit: (110 - 100) * 1 = $10
    const { pnl: spyPnl } = await broker.closePositionAtPrice(
      spy.tradeId, 110, CLOCK_TIME.toISOString(),
    );
    expect(spyPnl).toBe(10);

    // Close QQQ at 180 → LONG loss: (180 - 200) * 1 = -$20
    const { pnl: qqqPnl } = await broker.closePositionAtPrice(
      qqq.tradeId, 180, CLOCK_TIME.toISOString(),
    );
    expect(qqqPnl).toBe(-20);

    // Verify DB
    const [spyRow] = await db.select().from(schema.trades).where(sql`id = ${spy.tradeId}`);
    const [qqqRow] = await db.select().from(schema.trades).where(sql`id = ${qqq.tradeId}`);

    expect(spyRow.status).toBe('CLOSED');
    expect(qqqRow.status).toBe('CLOSED');
    expect(Number(spyRow.pnl)).toBe(10);
    expect(Number(qqqRow.pnl)).toBe(-20);
  });

  test('LONG and SHORT positions → close both → correct independent pnl', async () => {
    const broker = makeBroker({ SPY: 100, QQQ: 200 });

    const spyLong = await openPosition(broker, { symbol: 'SPY', direction: 'LONG' });
    const qqqShort = await openPosition(broker, { symbol: 'QQQ', direction: 'SHORT' });

    // Close SPY at 105 → LONG profit: (105 - 100) * 1 = $5
    const { pnl: spyPnl } = await broker.closePositionAtPrice(
      spyLong.tradeId, 105, CLOCK_TIME.toISOString(),
    );
    expect(spyPnl).toBe(5);

    // Close QQQ at 190 → SHORT profit: (190 - 200) * -1 * 1 = $10
    const { pnl: qqqPnl } = await broker.closePositionAtPrice(
      qqqShort.tradeId, 190, CLOCK_TIME.toISOString(),
    );
    expect(qqqPnl).toBe(10);
  });

  test('forceCloseAll with multiple open positions → all closed with correct pnl', async () => {
    const broker = makeBroker({ SPY: 100, QQQ: 200 });

    const spy = await openPosition(broker, { symbol: 'SPY', direction: 'LONG', quantity: 5 });
    const qqq = await openPosition(broker, { symbol: 'QQQ', direction: 'SHORT', quantity: 3 });

    // New broker at SPY=110, QQQ=190
    const closeBroker = new SimBroker(
      stubMarketData({ SPY: 110, QQQ: 190 }),
      new SimClock(CLOCK_TIME),
      btChannel(RUN_ID),
      'midpoint',
      100_000,
    );

    const totalPnl = await closeBroker.forceCloseAll(CLOCK_TIME);

    // SPY LONG: (110 - 100) * 5 = $50
    // QQQ SHORT: (190 - 200) * -1 * 3 = $30
    // Total: $80
    expect(totalPnl).toBe(80);

    const openCount = await closeBroker.getOpenPositionCount();
    expect(openCount).toBe(0);

    const [spyRow] = await db.select().from(schema.trades).where(sql`id = ${spy.tradeId}`);
    const [qqqRow] = await db.select().from(schema.trades).where(sql`id = ${qqq.tradeId}`);

    expect(spyRow.status).toBe('CLOSED');
    expect(qqqRow.status).toBe('CLOSED');
    expect(Number(spyRow.pnl)).toBe(50);
    expect(Number(qqqRow.pnl)).toBe(30);
  });
});

// ── 6. P&L sign correctness ─────────────────────────────────────────

describe('P&L sign correctness', () => {
  beforeEach(async () => { await resetDb(); });

  test('LONG: exit > entry → positive PnL', async () => {
    const broker = makeBroker({ SPY: 50 });
    const { tradeId } = await openPosition(broker, { direction: 'LONG' });
    const { pnl } = await broker.closePositionAtPrice(tradeId, 80, CLOCK_TIME.toISOString());
    // LONG: (80 - 50) * 1 = $30
    expect(pnl).toBe(30);
  });

  test('LONG: exit < entry → negative PnL', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId } = await openPosition(broker, { direction: 'LONG' });
    const { pnl } = await broker.closePositionAtPrice(tradeId, 70, CLOCK_TIME.toISOString());
    // LONG: (70 - 100) * 1 = -$30
    expect(pnl).toBe(-30);
  });

  test('LONG: exit == entry → zero PnL', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice } = await openPosition(broker, { direction: 'LONG' });
    const { pnl } = await broker.closePositionAtPrice(tradeId, fillPrice, CLOCK_TIME.toISOString());
    expect(pnl).toBe(0);
  });

  test('SHORT: exit < entry → positive PnL', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId } = await openPosition(broker, { direction: 'SHORT' });
    const { pnl } = await broker.closePositionAtPrice(tradeId, 70, CLOCK_TIME.toISOString());
    // SHORT: (70 - 100) * -1 * 1 = $30
    expect(pnl).toBe(30);
  });

  test('SHORT: exit > entry → negative PnL', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId } = await openPosition(broker, { direction: 'SHORT' });
    const { pnl } = await broker.closePositionAtPrice(tradeId, 130, CLOCK_TIME.toISOString());
    // SHORT: (130 - 100) * -1 * 1 = -$30
    expect(pnl).toBe(-30);
  });

  test('SHORT: exit == entry → zero PnL', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice } = await openPosition(broker, { direction: 'SHORT' });
    const { pnl } = await broker.closePositionAtPrice(tradeId, fillPrice, CLOCK_TIME.toISOString());
    expect(pnl).toBe(0);
  });
});

// ── 7. Account balance after full round-trip ─────────────────────────

describe('Account balance after round-trip', () => {
  beforeEach(async () => { await resetDb(); });

  test('winning LONG trade: account balance reflects realized PnL', async () => {
    const startingEquity = 100_000;
    const broker = makeBroker({ SPY: 100 }, startingEquity);
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, { direction: 'LONG', quantity: 10 });

    expect(entryPrice).toBe(100);

    const exitPrice = 120;
    await broker.closePositionAtPrice(tradeId, exitPrice, CLOCK_TIME.toISOString());

    const bal = await broker.getAccountBalance();
    // LONG: (120 - 100) * 10 = $200
    const expectedPnl = 200;

    expect(bal.realizedPnl).toBe(expectedPnl);
    expect(bal.unrealizedPnl).toBe(0);
    // After close: no open positions, equity = cash = startingEquity + realizedPnl
    expect(bal.equity).toBe(startingEquity + expectedPnl);
    expect(bal.cashBalance).toBe(startingEquity + expectedPnl);
  });

  test('losing SHORT trade: account balance reflects realized loss', async () => {
    const startingEquity = 100_000;
    const broker = makeBroker({ SPY: 100 }, startingEquity);
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, { direction: 'SHORT', quantity: 5 });

    expect(entryPrice).toBe(100);

    const exitPrice = 120;
    await broker.closePositionAtPrice(tradeId, exitPrice, CLOCK_TIME.toISOString());

    const bal = await broker.getAccountBalance();
    // SHORT: (120 - 100) * -1 * 5 = -$100
    const expectedPnl = -100;

    expect(bal.realizedPnl).toBe(expectedPnl);
    expect(bal.equity).toBe(startingEquity + expectedPnl);
  });
});

// ── 8. TRIM → CLOSE lifecycle ────────────────────────────────────────

describe('TRIM → CLOSE lifecycle', () => {
  beforeEach(async () => { await resetDb(); });

  test('LONG: open 10 → TRIM 3 at profit → CLOSE remaining 7 → total PnL accumulates correctly', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, {
      direction: 'LONG',
      quantity: 10,
    });
    expect(entryPrice).toBe(100);

    // TRIM 3 shares at 115
    const trimResult = await recordTrade({
      action: 'TRIM',
      symbol: 'SPY',
      trader: TRADER,
      tradeId,
      exitPrice: 115,
      closeQuantity: 3,
      closedAt: CLOCK_TIME.toISOString(),
      channelId: btChannel(RUN_ID),
    });

    expect(trimResult).not.toBeNull();
    expect(trimResult!.action).toBe('TRIM');

    // Verify partial close state
    const [afterTrim] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(afterTrim.status).toBe('OPEN');
    expect(afterTrim.quantity).toBe(7); // 10 - 3

    // TRIM PnL: (115 - 100) * 1 * 3 * 1 = $45
    const trimPnl = computeTradePnl({
      entryPrice: 100, exitPrice: 115, direction: 'LONG', strategy: 'STOCK', quantity: 3,
    });
    expect(trimPnl).toBe(45);
    expect(safeParseFloat(afterTrim.realizedPnl)).toBe(45);

    // pnl column is NOT set until the position is fully closed
    expect(afterTrim.pnl).toBeNull();

    // CLOSE remaining 7 shares at 90 (loss on this portion)
    const { pnl: closePnl } = await broker.closePositionAtPrice(tradeId, 90, CLOCK_TIME.toISOString());

    // closePositionAtPrice returns the total PnL (close portion + accumulated realized)
    // Close portion: (90 - 100) * 1 * 7 = -$70
    // Total: -70 + 45 = -$25
    const closePortion = computeTradePnl({
      entryPrice: 100, exitPrice: 90, direction: 'LONG', strategy: 'STOCK', quantity: 7,
    });
    expect(closePortion).toBe(-70);
    const expectedTotalPnl = roundCents(closePortion + trimPnl); // -70 + 45 = -25
    expect(expectedTotalPnl).toBe(-25);

    expect(closePnl).toBe(expectedTotalPnl);

    // Verify DB final state
    const [final] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(final.status).toBe('CLOSED');
    expect(Number(final.pnl)).toBe(-25);
    expect(Number(final.exitPrice)).toBe(90);
  });

  test('SHORT: open 8 → TRIM 2 at profit → TRIM 3 more at loss → CLOSE remaining 3', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, {
      direction: 'SHORT',
      quantity: 8,
    });
    expect(entryPrice).toBe(100);

    // TRIM 1: 2 shares at 90 (profit for short)
    await recordTrade({
      action: 'TRIM',
      symbol: 'SPY',
      trader: TRADER,
      tradeId,
      exitPrice: 90,
      closeQuantity: 2,
      closedAt: CLOCK_TIME.toISOString(),
      channelId: btChannel(RUN_ID),
    });

    const [afterTrim1] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(afterTrim1.quantity).toBe(6);
    // SHORT: (90 - 100) * -1 * 2 = $20
    expect(safeParseFloat(afterTrim1.realizedPnl)).toBe(20);

    // TRIM 2: 3 shares at 110 (loss for short)
    await recordTrade({
      action: 'TRIM',
      symbol: 'SPY',
      trader: TRADER,
      tradeId,
      exitPrice: 110,
      closeQuantity: 3,
      closedAt: CLOCK_TIME.toISOString(),
      channelId: btChannel(RUN_ID),
    });

    const [afterTrim2] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(afterTrim2.quantity).toBe(3);
    // SHORT trim2: (110 - 100) * -1 * 3 = -$30
    // Accumulated: 20 + (-30) = -$10
    expect(safeParseFloat(afterTrim2.realizedPnl)).toBe(-10);

    // CLOSE remaining 3 shares at 95
    const { pnl: closePnl } = await broker.closePositionAtPrice(tradeId, 95, CLOCK_TIME.toISOString());

    // Close portion: (95 - 100) * -1 * 3 = $15
    // Total: 15 + (-10) = $5
    expect(closePnl).toBe(5);

    const [final] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(final.status).toBe('CLOSED');
    expect(Number(final.pnl)).toBe(5);
  });

  test('TRIM 100% of position → effectively closes it', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId } = await openPosition(broker, { direction: 'LONG', quantity: 5 });

    // TRIM all 5 shares
    const trimResult = await recordTrade({
      action: 'TRIM',
      symbol: 'SPY',
      trader: TRADER,
      tradeId,
      exitPrice: 120,
      closeQuantity: 5,
      closedAt: CLOCK_TIME.toISOString(),
      channelId: btChannel(RUN_ID),
    });

    expect(trimResult).not.toBeNull();

    const [final] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(final.status).toBe('CLOSED');
    expect(final.quantity).toBe(0);
    // LONG: (120 - 100) * 5 = $100
    expect(Number(final.pnl)).toBe(100);
  });
});

// ── 9. ADD → avgEntryPrice → CLOSE lifecycle ─────────────────────────

describe('ADD → CLOSE lifecycle', () => {
  beforeEach(async () => { await resetDb(); });

  test('LONG: open 5 at 100 → ADD 5 at 120 → avgEntry=110 → CLOSE at 130 → PnL uses avg', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, {
      direction: 'LONG',
      quantity: 5,
    });
    expect(entryPrice).toBe(100);

    // ADD 5 more shares at $120
    const addResult = await recordTrade({
      action: 'ADD',
      symbol: 'SPY',
      trader: TRADER,
      tradeId,
      entryPrice: 120,
      quantity: 5,
      openedAt: CLOCK_TIME.toISOString(),
      channelId: btChannel(RUN_ID),
    });

    expect(addResult).not.toBeNull();
    expect(addResult!.action).toBe('ADD');

    // Verify averaged entry price
    const [afterAdd] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(afterAdd.status).toBe('OPEN');
    expect(afterAdd.quantity).toBe(10); // 5 + 5
    // avgEntry = (100 * 5 + 120 * 5) / 10 = 1100 / 10 = $110
    expect(Number(afterAdd.entryPrice)).toBe(110);
    expect(Number(afterAdd.avgEntryPrice)).toBe(110);

    // CLOSE all 10 shares at $130
    const { pnl } = await broker.closePositionAtPrice(tradeId, 130, CLOCK_TIME.toISOString());

    // LONG: (130 - 110) * 10 = $200
    expect(pnl).toBe(200);

    const [final] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(final.status).toBe('CLOSED');
    expect(Number(final.pnl)).toBe(200);
    expect(Number(final.exitPrice)).toBe(130);
  });

  test('SHORT: open 4 at 200 → ADD 6 at 180 → avgEntry=188 → CLOSE at 170 → PnL uses avg', async () => {
    const broker = makeBroker({ SPY: 200 });
    const { tradeId, fillPrice: entryPrice } = await openPosition(broker, {
      symbol: 'SPY',
      direction: 'SHORT',
      quantity: 4,
    });
    expect(entryPrice).toBe(200);

    // ADD 6 more shares at $180
    await recordTrade({
      action: 'ADD',
      symbol: 'SPY',
      trader: TRADER,
      tradeId,
      entryPrice: 180,
      quantity: 6,
      openedAt: CLOCK_TIME.toISOString(),
      channelId: btChannel(RUN_ID),
    });

    const [afterAdd] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(afterAdd.quantity).toBe(10);
    // avgEntry = (200 * 4 + 180 * 6) / 10 = (800 + 1080) / 10 = $188
    expect(Number(afterAdd.entryPrice)).toBe(188);

    // CLOSE at $170 (profit for short)
    const { pnl } = await broker.closePositionAtPrice(tradeId, 170, CLOCK_TIME.toISOString());

    // SHORT: (170 - 188) * -1 * 10 = $180
    expect(pnl).toBe(180);

    const [final] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(final.status).toBe('CLOSED');
    expect(Number(final.pnl)).toBe(180);
  });

  test('ADD → TRIM → CLOSE: combined lifecycle', async () => {
    const broker = makeBroker({ SPY: 100 });
    const { tradeId } = await openPosition(broker, {
      direction: 'LONG',
      quantity: 4,
    });

    // ADD 6 more at $110 → total 10, avg = (100*4 + 110*6) / 10 = 1060/10 = $106
    await recordTrade({
      action: 'ADD',
      symbol: 'SPY',
      trader: TRADER,
      tradeId,
      entryPrice: 110,
      quantity: 6,
      openedAt: CLOCK_TIME.toISOString(),
      channelId: btChannel(RUN_ID),
    });

    const [afterAdd] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(afterAdd.quantity).toBe(10);
    expect(Number(afterAdd.entryPrice)).toBe(106);

    // TRIM 4 shares at $120 → trimPnl = (120 - 106) * 4 = $56
    await recordTrade({
      action: 'TRIM',
      symbol: 'SPY',
      trader: TRADER,
      tradeId,
      exitPrice: 120,
      closeQuantity: 4,
      closedAt: CLOCK_TIME.toISOString(),
      channelId: btChannel(RUN_ID),
    });

    const [afterTrim] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(afterTrim.quantity).toBe(6);
    expect(safeParseFloat(afterTrim.realizedPnl)).toBe(56);

    // CLOSE remaining 6 at $100 → closePortion = (100 - 106) * 6 = -$36
    // Total PnL = -36 + 56 = $20
    const { pnl } = await broker.closePositionAtPrice(tradeId, 100, CLOCK_TIME.toISOString());
    expect(pnl).toBe(20);

    const [final] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(final.status).toBe('CLOSED');
    expect(Number(final.pnl)).toBe(20);
  });
});
