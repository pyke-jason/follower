/**
 * Property-based tests for SimBroker's DB-touching methods.
 *
 * Uses an in-memory SQLite database (same engine as production) so we get
 * real SQL execution without touching disk or needing a repository pattern.
 *
 * Covers: getAccountBalance, closePositionAtPrice, getOpenPositionCount,
 *         forceCloseAll, getUnrealizedPnl, markToMarket, sweepExpired,
 *         getPositions, getOpenTrades, and multi-leg option strategies.
 */

import { describe, test, expect, vi, beforeAll } from 'vitest';
import fc from 'fast-check';
import { sql } from 'drizzle-orm';

// Mock db/client with a real in-memory SQLite + drizzle instance.
vi.mock('../db/client.js', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const schema = await import('../db/schema.js');
  const client = createClient({ url: ':memory:' });
  const db = drizzle(client, { schema });
  return { db, schema, sqliteClient: client };
});

import { db, schema } from '../db/client.js';
import { SimBroker } from './sim-broker.js';
import { SimClock } from './clock.js';
import { computeTradePnl } from '../lib/pnl.js';
import { roundCents } from '../lib/numbers.js';

import {
  arbDirection,
  arbEntryPrice,
  arbMarkPrice,
  arbQuantity,
  arbEquity,
  stubMarketData,
  makeDbHelpers,
  CREATE_TRADES_SQL,
} from './test-fixtures.js';

// ── DB setup ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await db.run(CREATE_TRADES_SQL);
});

const RUN_ID = 'test-run';

const {
  resetDb,
  insertOpenTrade,
  insertClosedTrade,
  insertOpenOptionTrade,
} = makeDbHelpers(db, schema, RUN_ID);

function makeBroker(prices: Record<string, number> | number, startingEquity = 100_000) {
  return new SimBroker(stubMarketData(prices), new SimClock(), RUN_ID, 'midpoint', startingEquity);
}

// ── 1. getAccountBalance ─────────────────────────────────────────────

describe('getAccountBalance invariants', () => {
  test('empty account: equity = startingEquity, zero PnL', async () => {
    await fc.assert(
      fc.asyncProperty(arbEquity, async (startingEquity) => {
        await resetDb();
        const broker = makeBroker(100, startingEquity);
        const bal = await broker.getAccountBalance();
        expect(bal.equity).toBeCloseTo(startingEquity);
        expect(bal.realizedPnl).toBeCloseTo(0);
        expect(bal.unrealizedPnl).toBeCloseTo(0);
        expect(bal.cashBalance).toBeCloseTo(startingEquity);
      }),
    );
  });

  test('cashBalance = startingEquity + realizedPnl (always)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEquity,
        arbEntryPrice,
        arbEntryPrice,
        arbDirection,
        arbQuantity,
        async (startingEquity, entry, exit, direction, quantity) => {
          await resetDb();
          const pnl = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy: 'STOCK', quantity });
          await insertClosedTrade({ direction, strategy: 'STOCK', entryPrice: entry, exitPrice: exit, quantity, pnl });

          const broker = makeBroker(100, startingEquity);
          const bal = await broker.getAccountBalance();
          expect(bal.cashBalance).toBeCloseTo(startingEquity + bal.realizedPnl, 1);
        },
      ),
      { numRuns: 200 },
    );
  });

  test('equity = cashBalance + unrealizedPnl (always)', async () => {
    await fc.assert(
      fc.asyncProperty(arbEntryPrice, arbMarkPrice, arbDirection, arbQuantity, async (entry, mark, direction, quantity) => {
        await resetDb();
        await insertOpenTrade({ direction, strategy: 'STOCK', entryPrice: entry, quantity });

        const broker = makeBroker(mark);
        const bal = await broker.getAccountBalance();
        expect(bal.equity).toBeCloseTo(bal.cashBalance + bal.unrealizedPnl, 1);
      }),
      { numRuns: 200 },
    );
  });

  test('multiple closed trades: realizedPnl = sum of individual PnLs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            entry: arbEntryPrice,
            exit: arbEntryPrice,
            direction: arbDirection,
            quantity: arbQuantity,
          }),
          { minLength: 1, maxLength: 5 },
        ),
        async (trades) => {
          await resetDb();
          let expectedPnl = 0;
          for (const t of trades) {
            const pnl = computeTradePnl({ entryPrice: t.entry, exitPrice: t.exit, direction: t.direction, strategy: 'STOCK', quantity: t.quantity });
            expectedPnl += pnl;
            await insertClosedTrade({ direction: t.direction, strategy: 'STOCK', entryPrice: t.entry, exitPrice: t.exit, quantity: t.quantity, pnl });
          }
          const broker = makeBroker(100);
          const bal = await broker.getAccountBalance();
          expect(bal.realizedPnl).toBeCloseTo(roundCents(expectedPnl), 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('other run trades do not affect this run balance', async () => {
    await fc.assert(
      fc.asyncProperty(arbEquity, arbEntryPrice, async (startingEquity, exit) => {
        await resetDb();
        // Insert a big winning trade on a different run
        await insertClosedTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 1, exitPrice: exit, quantity: 100, pnl: 999999, runId: 'other-run' });

        const broker = makeBroker(100, startingEquity);
        const bal = await broker.getAccountBalance();
        expect(bal.realizedPnl).toBeCloseTo(0);
        expect(bal.equity).toBeCloseTo(startingEquity);
      }),
    );
  });
});

// ── 2. closePositionAtPrice ──────────────────────────────────────────

describe('closePositionAtPrice invariants', () => {
  test('PnL matches computeTradePnl for STOCK', async () => {
    await fc.assert(
      fc.asyncProperty(arbEntryPrice, arbMarkPrice, arbDirection, arbQuantity, async (entry, exit, direction, quantity) => {
        await resetDb();
        const tradeId = await insertOpenTrade({ direction, strategy: 'STOCK', entryPrice: entry, quantity });

        const broker = makeBroker(exit);
        const { pnl } = await broker.closePositionAtPrice(tradeId, exit, new Date().toISOString());

        const expected = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy: 'STOCK', quantity });
        expect(pnl).toBeCloseTo(expected, 2);
      }),
      { numRuns: 300 },
    );
  });

  test('PnL matches computeTradePnl for options (100x multiplier)', async () => {
    await fc.assert(
      fc.asyncProperty(arbEntryPrice, arbMarkPrice, arbDirection, arbQuantity, async (entry, exit, direction, quantity) => {
        await resetDb();
        const tradeId = await insertOpenOptionTrade({
          direction,
          strategy: 'CALL_SPREAD',
          entryPrice: entry,
          quantity,
          legs: [
            { strike: 100, expiry: '2026-06-20', type: 'CALL', action: 'BUY', quantity },
            { strike: 110, expiry: '2026-06-20', type: 'CALL', action: 'SELL', quantity },
          ],
        });

        const broker = makeBroker(exit);
        const { pnl } = await broker.closePositionAtPrice(tradeId, exit, new Date().toISOString());

        const expected = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy: 'CALL_SPREAD', quantity });
        expect(pnl).toBeCloseTo(expected, 2);
      }),
      { numRuns: 200 },
    );
  });

  test('closed trade has status CLOSED and correct exitPrice in DB', async () => {
    await fc.assert(
      fc.asyncProperty(arbEntryPrice, arbMarkPrice, arbDirection, async (entry, exit, direction) => {
        await resetDb();
        const tradeId = await insertOpenTrade({ direction, strategy: 'STOCK', entryPrice: entry, quantity: 1 });

        const broker = makeBroker(exit);
        await broker.closePositionAtPrice(tradeId, exit, new Date().toISOString());

        const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
        expect(row.status).toBe('CLOSED');
        expect(row.exitPrice).toBe(String(exit));
        expect(row.closedAt).toBeDefined();
        expect(Number(row.pnl)).toBeDefined();
      }),
      { numRuns: 200 },
    );
  });

  test('closing non-existent trade throws', async () => {
    await resetDb();
    const broker = makeBroker(100);
    await expect(broker.closePositionAtPrice('bogus-id', 100, new Date().toISOString()))
      .rejects.toThrow('Trade bogus-id not found');
  });
});

// ── 3. getOpenPositionCount ──────────────────────────────────────────

describe('getOpenPositionCount invariants', () => {
  test('count matches number of inserted open trades', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 10 }), async (n) => {
        await resetDb();
        for (let i = 0; i < n; i++) {
          await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
        }
        const broker = makeBroker(100);
        const count = await broker.getOpenPositionCount();
        expect(count).toBe(n);
      }),
      { numRuns: 50 },
    );
  });

  test('closed trades are not counted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        async (openCount, closedCount) => {
          await resetDb();
          for (let i = 0; i < openCount; i++) {
            await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
          }
          for (let i = 0; i < closedCount; i++) {
            await insertClosedTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, exitPrice: 105, quantity: 1, pnl: 5 });
          }
          const broker = makeBroker(100);
          const count = await broker.getOpenPositionCount();
          expect(count).toBe(openCount);
        },
      ),
      { numRuns: 50 },
    );
  });

  test('trades from other runs are not counted', async () => {
    await resetDb();
    await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1, runId: 'other-run' });
    await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });

    const broker = makeBroker(100);
    const count = await broker.getOpenPositionCount();
    expect(count).toBe(1);
  });
});

// ── 4. forceCloseAll ─────────────────────────────────────────────────

describe('forceCloseAll invariants', () => {
  test('after forceCloseAll, open position count is 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        arbMarkPrice,
        async (n, mark) => {
          await resetDb();
          for (let i = 0; i < n; i++) {
            await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
          }

          const broker = makeBroker(mark);
          await broker.forceCloseAll(new Date());

          const count = await broker.getOpenPositionCount();
          expect(count).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  test('forceCloseAll on empty book returns 0 PnL', async () => {
    await fc.assert(
      fc.asyncProperty(arbMarkPrice, async (mark) => {
        await resetDb();
        const broker = makeBroker(mark);
        const pnl = await broker.forceCloseAll(new Date());
        expect(pnl).toBeCloseTo(0);
      }),
    );
  });

  test('forceCloseAll PnL equals sum of individual close PnLs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            entry: arbEntryPrice,
            direction: arbDirection,
            quantity: arbQuantity,
          }),
          { minLength: 1, maxLength: 5 },
        ),
        arbMarkPrice,
        async (trades, mark) => {
          await resetDb();
          let expectedPnl = 0;
          for (const t of trades) {
            await insertOpenTrade({ direction: t.direction, strategy: 'STOCK', entryPrice: t.entry, quantity: t.quantity });
            // mark price is what forceCloseAll will use (midpoint of bid/ask from stub)
            expectedPnl += computeTradePnl({
              entryPrice: t.entry,
              exitPrice: mark,
              direction: t.direction,
              strategy: 'STOCK',
              quantity: t.quantity,
            });
          }

          const broker = makeBroker(mark);
          const totalPnl = await broker.forceCloseAll(new Date());
          expect(totalPnl).toBeCloseTo(roundCents(expectedPnl), 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('forceCloseAll sets all trades to CLOSED status', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (n) => {
        await resetDb();
        for (let i = 0; i < n; i++) {
          await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
        }

        const broker = makeBroker(105);
        await broker.forceCloseAll(new Date());

        const rows = await db.select().from(schema.trades).where(sql`backtest_run_id = ${RUN_ID}`);
        for (const row of rows) {
          expect(row.status).toBe('CLOSED');
          expect(row.exitPrice).toBeDefined();
          expect(row.pnl).toBeDefined();
          expect(row.closedAt).toBeDefined();
        }
      }),
      { numRuns: 30 },
    );
  });
});

// ── 5. getUnrealizedPnl ─────────────────────────────────────────────

describe('getUnrealizedPnl invariants', () => {
  test('unrealizedPnl sums correctly across N positions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            entry: arbEntryPrice,
            direction: arbDirection,
            quantity: arbQuantity,
          }),
          { minLength: 1, maxLength: 5 },
        ),
        arbMarkPrice,
        async (trades, mark) => {
          await resetDb();
          let expectedTotal = 0;
          for (const t of trades) {
            await insertOpenTrade({ direction: t.direction, strategy: 'STOCK', entryPrice: t.entry, quantity: t.quantity });
            expectedTotal += computeTradePnl({
              entryPrice: t.entry,
              exitPrice: mark,
              direction: t.direction,
              strategy: 'STOCK',
              quantity: t.quantity,
            });
          }
          expectedTotal = roundCents(expectedTotal);

          const broker = makeBroker(mark);
          const actual = await broker.getUnrealizedPnl();
          expect(actual).toBeCloseTo(expectedTotal, 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('no open positions → unrealizedPnl is 0', async () => {
    await fc.assert(
      fc.asyncProperty(arbMarkPrice, async (mark) => {
        await resetDb();
        const broker = makeBroker(mark);
        const pnl = await broker.getUnrealizedPnl();
        expect(pnl).toBeCloseTo(0);
      }),
    );
  });

  test('closed trades do not contribute to unrealizedPnl', async () => {
    await resetDb();
    await insertClosedTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, exitPrice: 200, quantity: 10, pnl: 1000 });

    const broker = makeBroker(300);
    const unrealized = await broker.getUnrealizedPnl();
    expect(unrealized).toBeCloseTo(0);
  });

  test('option unrealizedPnl uses OCC requote (100x multiplier)', async () => {
    await fc.assert(
      fc.asyncProperty(arbMarkPrice, arbQuantity, async (underlyingPrice, quantity) => {
        await resetDb();
        const strike = 200;
        const entry = 5;
        await insertOpenOptionTrade({
          direction: 'LONG',
          strategy: 'CALL',
          entryPrice: entry,
          quantity,
          legs: [{ strike, expiry: '2027-06-20', type: 'CALL', action: 'BUY', quantity }],
        });

        // Mark via OCC: mid = intrinsic + 0.50
        const intrinsic = Math.max(0, underlyingPrice - strike);
        const mark = intrinsic + 0.50;
        const expected = computeTradePnl({ entryPrice: entry, exitPrice: mark, direction: 'LONG', strategy: 'CALL', quantity });

        const broker = makeBroker({ SPY: underlyingPrice });
        const actual = await broker.getUnrealizedPnl();
        expect(actual).toBeCloseTo(expected, 1);
      }),
      { numRuns: 100 },
    );
  });
});

// ── 6. markToMarket ──────────────────────────────────────────────────

describe('markToMarket invariants', () => {
  test('returns a map entry for each open trade', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), arbMarkPrice, async (n, mark) => {
        await resetDb();
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          ids.push(await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 }));
        }

        const broker = makeBroker(mark);
        const marks = await broker.markToMarket();

        expect(marks.size).toBe(n);
        for (const id of ids) {
          expect(marks.has(id)).toBe(true);
          expect(marks.get(id)).toBeGreaterThan(0);
        }
      }),
      { numRuns: 30 },
    );
  });

  test('mark prices reflect the stub mid price', async () => {
    await fc.assert(
      fc.asyncProperty(arbMarkPrice, async (mark) => {
        await resetDb();
        await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });

        const broker = makeBroker(mark);
        const marks = await broker.markToMarket();
        const [price] = marks.values();
        // Stub returns bid=mark-0.05, ask=mark+0.05, so mid = mark
        expect(price).toBeCloseTo(mark, 2);
      }),
      { numRuns: 50 },
    );
  });

  test('closed trades are not marked', async () => {
    await resetDb();
    await insertClosedTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, exitPrice: 110, quantity: 1, pnl: 10 });

    const broker = makeBroker(200);
    const marks = await broker.markToMarket();
    expect(marks.size).toBe(0);
  });

  test('trades with missing quotes are excluded (not errored)', async () => {
    await resetDb();
    await insertOpenTrade({ symbol: 'MISSING', direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
    await insertOpenTrade({ symbol: 'SPY', direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });

    // Only SPY has a price in the stub — MISSING will throw
    const broker = makeBroker({ SPY: 200 });
    const marks = await broker.markToMarket();
    expect(marks.size).toBe(1);
  });

  test('option trades are marked via OCC requote (not underlying price)', async () => {
    await fc.assert(
      fc.asyncProperty(arbMarkPrice, async (underlyingPrice) => {
        await resetDb();
        const strike = 200;
        const id = await insertOpenOptionTrade({
          direction: 'LONG',
          strategy: 'CALL',
          entryPrice: 5,
          quantity: 1,
          legs: [{ strike, expiry: '2027-06-20', type: 'CALL', action: 'BUY', quantity: 1 }],
        });

        const broker = makeBroker({ SPY: underlyingPrice });
        const marks = await broker.markToMarket();
        expect(marks.size).toBe(1);

        // getOptionSpreadQuote normalises to positive bid/ask.
        // Our stub: single BUY leg → bid = intrinsic + 0.40, ask = intrinsic + 0.60
        // mid = intrinsic + 0.50
        const intrinsic = Math.max(0, underlyingPrice - strike);
        const expectedMid = intrinsic + 0.50;
        expect(marks.get(id)).toBeCloseTo(expectedMid, 2);
      }),
      { numRuns: 50 },
    );
  });

  test('multi-leg spread marked via net OCC requote', async () => {
    await resetDb();
    // Bull call spread: BUY 200C + SELL 210C, SPY at 205
    const id = await insertOpenOptionTrade({
      direction: 'LONG',
      strategy: 'CDS',
      entryPrice: 3,
      quantity: 1,
      legs: [
        { strike: 200, expiry: '2027-06-20', type: 'CALL', action: 'BUY', quantity: 1 },
        { strike: 210, expiry: '2027-06-20', type: 'CALL', action: 'SELL', quantity: 1 },
      ],
    });

    const broker = makeBroker({ SPY: 205 });
    const marks = await broker.markToMarket();
    expect(marks.size).toBe(1);

    // BUY 200C: intrinsic=5, mid=5.50, bid=5.40, ask=5.60
    // SELL 210C: intrinsic=0, mid=0.50, bid=0.40, ask=0.60
    // Net: bid = 5.40 - 0.60 = 4.80, ask = 5.60 - 0.40 = 5.20
    // getOptionSpreadQuote normalises: absBid=4.80, absAsk=5.20 → mid = 5.00
    const mark = marks.get(id)!;
    expect(mark).toBeCloseTo(5.0, 1);
  });
});

// ── 7. sweepExpired ──────────────────────────────────────────────────

describe('sweepExpired invariants', () => {
  test('stock trades are never swept', async () => {
    await resetDb();
    await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });

    const broker = makeBroker(200);
    const closed = await broker.sweepExpired('2099-12-31');
    expect(closed).toBe(0);

    const count = await broker.getOpenPositionCount();
    expect(count).toBe(1);
  });

  test('non-expired options are not swept', async () => {
    await resetDb();
    await insertOpenOptionTrade({
      direction: 'LONG',
      strategy: 'CALL',
      entryPrice: 5,
      quantity: 1,
      legs: [{ strike: 200, expiry: '2027-06-20', type: 'CALL', action: 'BUY', quantity: 1 }],
    });

    const broker = makeBroker(250);
    const closed = await broker.sweepExpired('2026-03-01');
    expect(closed).toBe(0);
  });

  test('expired ITM call closes at intrinsic value', async () => {
    await resetDb();
    const strike = 200;
    const underlyingPrice = 250;
    const tradeId = await insertOpenOptionTrade({
      direction: 'LONG',
      strategy: 'CALL',
      entryPrice: 10,
      quantity: 1,
      legs: [{ strike, expiry: '2026-03-20', type: 'CALL', action: 'BUY', quantity: 1 }],
    });

    const broker = makeBroker({ SPY: underlyingPrice });
    const closed = await broker.sweepExpired('2026-03-20');
    expect(closed).toBe(1);

    const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(row.status).toBe('CLOSED');
    // Intrinsic for LONG call: max(0, underlying - strike) = 50
    expect(Number(row.exitPrice)).toBeCloseTo(underlyingPrice - strike, 1);
  });

  test('expired OTM call closes at $0', async () => {
    await resetDb();
    const strike = 300;
    const underlyingPrice = 250;
    const tradeId = await insertOpenOptionTrade({
      direction: 'LONG',
      strategy: 'CALL',
      entryPrice: 5,
      quantity: 1,
      legs: [{ strike, expiry: '2026-03-20', type: 'CALL', action: 'BUY', quantity: 1 }],
    });

    const broker = makeBroker({ SPY: underlyingPrice });
    const closed = await broker.sweepExpired('2026-03-20');
    expect(closed).toBe(1);

    const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(row.status).toBe('CLOSED');
    expect(Number(row.exitPrice)).toBe(0);
  });

  test('expired ITM put closes at intrinsic value', async () => {
    await resetDb();
    const strike = 300;
    const underlyingPrice = 250;
    const tradeId = await insertOpenOptionTrade({
      direction: 'LONG',
      strategy: 'PUT',
      entryPrice: 10,
      quantity: 1,
      legs: [{ strike, expiry: '2026-03-20', type: 'PUT', action: 'BUY', quantity: 1 }],
    });

    const broker = makeBroker({ SPY: underlyingPrice });
    const closed = await broker.sweepExpired('2026-03-20');
    expect(closed).toBe(1);

    const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(row.status).toBe('CLOSED');
    expect(Number(row.exitPrice)).toBeCloseTo(strike - underlyingPrice, 1);
  });

  test('expired OTM put closes at $0', async () => {
    await resetDb();
    const strike = 200;
    const underlyingPrice = 250;
    const tradeId = await insertOpenOptionTrade({
      direction: 'LONG',
      strategy: 'PUT',
      entryPrice: 5,
      quantity: 1,
      legs: [{ strike, expiry: '2026-03-20', type: 'PUT', action: 'BUY', quantity: 1 }],
    });

    const broker = makeBroker({ SPY: underlyingPrice });
    const closed = await broker.sweepExpired('2026-03-20');
    expect(closed).toBe(1);

    const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(Number(row.exitPrice)).toBe(0);
  });

  test('after sweep, no expired options remain open', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        async (expiredCount, liveCount) => {
          await resetDb();
          for (let i = 0; i < expiredCount; i++) {
            await insertOpenOptionTrade({
              direction: 'LONG',
              strategy: 'CALL',
              entryPrice: 5,
              quantity: 1,
              legs: [{ strike: 200, expiry: '2026-03-20', type: 'CALL', action: 'BUY', quantity: 1 }],
            });
          }
          for (let i = 0; i < liveCount; i++) {
            await insertOpenOptionTrade({
              direction: 'LONG',
              strategy: 'CALL',
              entryPrice: 5,
              quantity: 1,
              legs: [{ strike: 200, expiry: '2027-12-31', type: 'CALL', action: 'BUY', quantity: 1 }],
            });
          }
          // Also some stock trades that should never be swept
          await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });

          const broker = makeBroker({ SPY: 250 });
          const closed = await broker.sweepExpired('2026-03-20');
          expect(closed).toBe(expiredCount);

          const remaining = await broker.getOpenPositionCount();
          expect(remaining).toBe(liveCount + 1); // live options + 1 stock
        },
      ),
      { numRuns: 30 },
    );
  });

  test('multi-leg spread: net intrinsic computed from all expired legs', async () => {
    await resetDb();
    // Bull call spread: buy 200C, sell 210C — SPY at 205
    // BUY 200C: intrinsic = max(0, 205-200) = 5
    // SELL 210C: intrinsic = -max(0, 205-210) = 0
    // Net intrinsic = 5
    const tradeId = await insertOpenOptionTrade({
      direction: 'LONG',
      strategy: 'CDS',
      entryPrice: 3,
      quantity: 1,
      legs: [
        { strike: 200, expiry: '2026-03-20', type: 'CALL', action: 'BUY', quantity: 1 },
        { strike: 210, expiry: '2026-03-20', type: 'CALL', action: 'SELL', quantity: 1 },
      ],
    });

    const broker = makeBroker({ SPY: 205 });
    await broker.sweepExpired('2026-03-20');

    const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(row.status).toBe('CLOSED');
    expect(Number(row.exitPrice)).toBeCloseTo(5, 1);
  });

  test('multi-leg spread: both legs OTM → exit at $0', async () => {
    await resetDb();
    // Bull call spread: buy 200C, sell 210C — SPY at 190 (both OTM)
    const tradeId = await insertOpenOptionTrade({
      direction: 'LONG',
      strategy: 'CDS',
      entryPrice: 3,
      quantity: 1,
      legs: [
        { strike: 200, expiry: '2026-03-20', type: 'CALL', action: 'BUY', quantity: 1 },
        { strike: 210, expiry: '2026-03-20', type: 'CALL', action: 'SELL', quantity: 1 },
      ],
    });

    const broker = makeBroker({ SPY: 190 });
    await broker.sweepExpired('2026-03-20');

    const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(Number(row.exitPrice)).toBe(0);
  });

  test('credit spread (net short): exit at absolute net intrinsic (loss)', async () => {
    await resetDb();
    // Bear call credit spread: sell 200C, buy 210C — SPY at 205
    // SELL 200C: intrinsic = -max(0, 205-200) = -5
    // BUY 210C: intrinsic = max(0, 205-210) = 0
    // Net = -5, exitPrice = abs(-5) = 5 (costs $5 to settle)
    const tradeId = await insertOpenOptionTrade({
      direction: 'SHORT',
      strategy: 'CDS',
      entryPrice: 3,
      quantity: 1,
      legs: [
        { strike: 200, expiry: '2026-03-20', type: 'CALL', action: 'SELL', quantity: 1 },
        { strike: 210, expiry: '2026-03-20', type: 'CALL', action: 'BUY', quantity: 1 },
      ],
    });

    const broker = makeBroker({ SPY: 205 });
    await broker.sweepExpired('2026-03-20');

    const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    // Sold for $3, costs $5 to settle → PnL = (5-3)*(-1)*100 = -$200 loss
    expect(Number(row.exitPrice)).toBe(5);
    expect(Number(row.pnl)).toBeCloseTo(-200, 1);
  });

  test('credit spread: exit price = absolute net intrinsic (never zero-clamped)', async () => {
    // Property: when short leg goes ITM, exit price should be the true
    // settlement cost (abs of net intrinsic), not clamped to $0.
    // The OLD buggy code used Math.max(0, net) which turned losses into $0.
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 201, max: 300, noNaN: true, noDefaultInfinity: true }), // underlying above short strike
        fc.double({ min: 0.5, max: 10, noNaN: true, noDefaultInfinity: true }),   // entry credit
        async (underlyingPrice, entryCredit) => {
          await resetDb();
          const tradeId = await insertOpenOptionTrade({
            direction: 'SHORT',
            strategy: 'CDS',
            entryPrice: entryCredit,
            quantity: 1,
            legs: [
              { strike: 200, expiry: '2026-03-20', type: 'CALL', action: 'SELL', quantity: 1 },
              { strike: 210, expiry: '2026-03-20', type: 'CALL', action: 'BUY', quantity: 1 },
            ],
          });

          const broker = makeBroker({ SPY: underlyingPrice });
          await broker.sweepExpired('2026-03-20');

          const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);

          // Net intrinsic for credit spread where short leg is ITM:
          // SELL 200C: -max(0, underlying-200), BUY 210C: max(0, underlying-210)
          const shortIntrinsic = Math.max(0, underlyingPrice - 200);
          const longIntrinsic = Math.max(0, underlyingPrice - 210);
          const netIntrinsic = longIntrinsic - shortIntrinsic; // negative when short side is breached
          const expectedExit = Math.abs(netIntrinsic);

          expect(Number(row.exitPrice)).toBeCloseTo(expectedExit, 1);
          expect(Number(row.exitPrice)).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('iron condor: net intrinsic computed from all 4 legs', async () => {
    await resetDb();
    // Iron condor on SPY at 400:
    //   Sell 390P, Buy 380P (bull put spread)
    //   Sell 410C, Buy 420C (bear call spread)
    // SPY at 400 → all OTM → net intrinsic = 0
    const tradeId = await insertOpenOptionTrade({
      direction: 'SHORT',
      strategy: 'IRON_CONDOR',
      entryPrice: 4,
      quantity: 1,
      legs: [
        { strike: 390, expiry: '2026-03-20', type: 'PUT', action: 'SELL', quantity: 1 },
        { strike: 380, expiry: '2026-03-20', type: 'PUT', action: 'BUY', quantity: 1 },
        { strike: 410, expiry: '2026-03-20', type: 'CALL', action: 'SELL', quantity: 1 },
        { strike: 420, expiry: '2026-03-20', type: 'CALL', action: 'BUY', quantity: 1 },
      ],
    });

    const broker = makeBroker({ SPY: 400 });
    await broker.sweepExpired('2026-03-20');

    const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    expect(row.status).toBe('CLOSED');
    expect(Number(row.exitPrice)).toBe(0);
  });

  test('iron condor: breached side computes correct net intrinsic', async () => {
    await resetDb();
    // Same iron condor but SPY at 415 (call side breached)
    // Sell 410C: -max(0, 415-410) = -5
    // Buy 420C: max(0, 415-420) = 0
    // Sell 390P: -max(0, 390-415) = 0
    // Buy 380P: max(0, 380-415) = 0
    // Net = -5, exitPrice = abs(-5) = 5 (costs $5 to settle)
    const tradeId = await insertOpenOptionTrade({
      direction: 'SHORT',
      strategy: 'IRON_CONDOR',
      entryPrice: 4,
      quantity: 1,
      legs: [
        { strike: 390, expiry: '2026-03-20', type: 'PUT', action: 'SELL', quantity: 1 },
        { strike: 380, expiry: '2026-03-20', type: 'PUT', action: 'BUY', quantity: 1 },
        { strike: 410, expiry: '2026-03-20', type: 'CALL', action: 'SELL', quantity: 1 },
        { strike: 420, expiry: '2026-03-20', type: 'CALL', action: 'BUY', quantity: 1 },
      ],
    });

    const broker = makeBroker({ SPY: 415 });
    await broker.sweepExpired('2026-03-20');

    const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
    // Sold for $4, costs $5 to settle → PnL = (5-4)*(-1)*100 = -$100 loss
    expect(Number(row.exitPrice)).toBe(5);
    expect(Number(row.pnl)).toBeCloseTo(-100, 1);
  });
});

// ── 8. getPositions ──────────────────────────────────────────────────

describe('getPositions invariants', () => {
  test('returns one BrokerPosition per open trade', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 8 }), async (n) => {
        await resetDb();
        for (let i = 0; i < n; i++) {
          await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
        }

        const broker = makeBroker(105);
        const positions = await broker.getPositions();
        expect(positions.length).toBe(n);
      }),
      { numRuns: 30 },
    );
  });

  test('unrealizedPnl in position matches computeTradePnl', async () => {
    await fc.assert(
      fc.asyncProperty(arbEntryPrice, arbMarkPrice, arbDirection, arbQuantity, async (entry, mark, direction, quantity) => {
        await resetDb();
        await insertOpenTrade({ direction, strategy: 'STOCK', entryPrice: entry, quantity });

        const broker = makeBroker(mark);
        const positions = await broker.getPositions();
        expect(positions.length).toBe(1);

        const expected = computeTradePnl({ entryPrice: entry, exitPrice: mark, direction, strategy: 'STOCK', quantity });
        expect(positions[0].unrealizedPnl).toBeCloseTo(expected, 1);
      }),
      { numRuns: 100 },
    );
  });

  test('stock assetType = EQ, option assetType = OP', async () => {
    await resetDb();
    await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
    await insertOpenOptionTrade({
      direction: 'LONG',
      strategy: 'CALL',
      entryPrice: 5,
      quantity: 1,
      legs: [{ strike: 200, expiry: '2027-06-20', type: 'CALL', action: 'BUY', quantity: 1 }],
    });

    const broker = makeBroker(200);
    const positions = await broker.getPositions();
    const types = positions.map(p => p.assetType).sort();
    expect(types).toEqual(['EQ', 'OP']);
  });

  test('averageCost = entryPrice', async () => {
    await fc.assert(
      fc.asyncProperty(arbEntryPrice, async (entry) => {
        await resetDb();
        await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: entry, quantity: 1 });

        const broker = makeBroker(100);
        const [pos] = await broker.getPositions();
        expect(pos.averageCost).toBeCloseTo(entry, 2);
      }),
    );
  });

  test('marketValue = markPrice * quantity for STOCK', async () => {
    await fc.assert(
      fc.asyncProperty(arbMarkPrice, arbQuantity, async (mark, quantity) => {
        await resetDb();
        await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity });

        const broker = makeBroker(mark);
        const [pos] = await broker.getPositions();
        expect(pos.marketValue).toBeCloseTo(roundCents(mark * quantity), 1);
      }),
      { numRuns: 100 },
    );
  });

  test('marketValue = requoted spread mid * quantity * 100 for options', async () => {
    await fc.assert(
      fc.asyncProperty(arbMarkPrice, arbQuantity, async (underlyingPrice, quantity) => {
        await resetDb();
        const strike = 200;
        await insertOpenOptionTrade({
          direction: 'LONG',
          strategy: 'CALL',
          entryPrice: 5,
          quantity,
          legs: [{ strike, expiry: '2027-06-20', type: 'CALL', action: 'BUY', quantity }],
        });

        // getPositions re-quotes via getOptionSpreadQuote → getQuote(OCC)
        // Our stub returns intrinsic + 0.50 ± 0.10, so mid = intrinsic + 0.50
        const intrinsic = Math.max(0, underlyingPrice - strike);
        const expectedMid = intrinsic + 0.50;
        const expectedMarketValue = roundCents(expectedMid * quantity * 100);

        const broker = makeBroker({ SPY: underlyingPrice });
        const [pos] = await broker.getPositions();
        expect(pos.marketValue).toBeCloseTo(expectedMarketValue, 1);
      }),
      { numRuns: 100 },
    );
  });

  test('closed trades are excluded', async () => {
    await resetDb();
    await insertClosedTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, exitPrice: 110, quantity: 1, pnl: 10 });
    await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });

    const broker = makeBroker(105);
    const positions = await broker.getPositions();
    expect(positions.length).toBe(1);
  });
});

// ── 9. getOpenTrades ─────────────────────────────────────────────────

describe('getOpenTrades invariants', () => {
  test('returns only open trades for this run', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        async (openCount, closedCount) => {
          await resetDb();
          for (let i = 0; i < openCount; i++) {
            await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
          }
          for (let i = 0; i < closedCount; i++) {
            await insertClosedTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, exitPrice: 105, quantity: 1, pnl: 5 });
          }

          const broker = makeBroker(100);
          const trades = await broker.getOpenTrades();
          expect(trades.length).toBe(openCount);
          for (const t of trades) {
            expect(['OPEN', 'PARTIAL']).toContain(t.status);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  test('trader filter works', async () => {
    await resetDb();
    await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1, trader: 'alice' });
    await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1, trader: 'alice' });
    await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1, trader: 'bob' });

    const broker = makeBroker(100);
    const aliceTrades = await broker.getOpenTrades({ trader: 'alice' });
    expect(aliceTrades.length).toBe(2);
    for (const t of aliceTrades) {
      expect(t.trader).toBe('alice');
    }
  });

  test('symbol filter works', async () => {
    await resetDb();
    await insertOpenTrade({ symbol: 'SPY', direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
    await insertOpenTrade({ symbol: 'QQQ', direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });

    const broker = makeBroker({ SPY: 100, QQQ: 100 });
    const spyTrades = await broker.getOpenTrades({ symbol: 'SPY' });
    expect(spyTrades.length).toBe(1);
    expect(spyTrades[0].symbol).toBe('SPY');
  });
});

// ── 10. Equity conservation (open → close cycle) ────────────────────

describe('equity conservation', () => {
  test('open + close cycle: cashBalance recovers to startingEquity + realized', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEquity,
        arbEntryPrice,
        arbMarkPrice,
        arbDirection,
        arbQuantity,
        async (startingEquity, entry, exit, direction, quantity) => {
          await resetDb();
          const tradeId = await insertOpenTrade({ direction, strategy: 'STOCK', entryPrice: entry, quantity });

          const broker = makeBroker(exit, startingEquity);
          await broker.closePositionAtPrice(tradeId, exit, new Date().toISOString());

          const bal = await broker.getAccountBalance();
          // After closing: unrealized = 0, equity = cash = startingEquity + realized
          expect(bal.unrealizedPnl).toBeCloseTo(0);
          expect(bal.equity).toBeCloseTo(bal.cashBalance, 1);
          expect(bal.equity).toBeCloseTo(startingEquity + bal.realizedPnl, 1);
        },
      ),
      { numRuns: 200 },
    );
  });
});
