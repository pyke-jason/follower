/**
 * Property-based tests for SimBroker.
 *
 * Uses fast-check to generate random inputs and assert invariants
 * ("properties") that must hold for ALL inputs — not just hand-picked examples.
 *
 * Focuses on fill mechanics:
 *   - computeModelFillPrice (pure function)
 *   - placeOrder (MARKET + LIMIT), processQuoteTick, order lifecycle
 *   - computeTradePnl (pure function used by SimBroker)
 */

import { describe, test, expect, vi, beforeAll } from 'vitest';
import fc from 'fast-check';
import { sql } from 'drizzle-orm';

// In-memory SQLite — placeOrder's buying power gate needs a real DB.
vi.mock('../db/client.js', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const schema = await import('../db/schema.js');
  const client = createClient({ url: ':memory:' });
  const db = drizzle({ client, schema });
  return { db, schema, sqliteClient: client };
});

import { db } from '../db/client.js';
import { computeModelFillPrice, SimBroker } from './sim-broker.js';
import { SimClock } from './clock.js';
import { computeTradePnl } from '../lib/pnl.js';
import { roundCents } from '../lib/numbers.js';
import type { QuoteTick } from './databento-tape.js';

import {
  arbFillModel,
  arbSpread,
  arbIsBuy,
  arbLegCount,
  arbDirection,
  arbStrategy,
  arbQuantity,
  arbPrice,
  makeQuote,
  makeStockBuyOrder,
  makeStockSellOrder,
  stubMarketDataFromQuote,
  CREATE_TRADES_SQL,
  CREATE_TRADE_EVENTS_SQL,
} from './test-fixtures.js';

const TEST_EQUITY = 100_000;

beforeAll(async () => {
  await db.run(CREATE_TRADES_SQL);
  await db.run(CREATE_TRADE_EVENTS_SQL);
});

// ── 1. computeModelFillPrice ─────────────────────────────────────────

describe('computeModelFillPrice properties', () => {
  test('fill price is always within [bid, ask]', () => {
    fc.assert(
      fc.property(arbFillModel, arbSpread, arbIsBuy, arbLegCount, (model, spread, isBuy, legCount) => {
        const price = computeModelFillPrice({
          fillModel: model,
          bid: spread.bid,
          ask: spread.ask,
          isBuy,
          legCount,
        });
        expect(price).toBeGreaterThanOrEqual(spread.bid - 1e-9);
        expect(price).toBeLessThanOrEqual(spread.ask + 1e-9);
      }),
      { numRuns: 1000 },
    );
  });

  test('midpoint is exactly (bid + ask) / 2 regardless of direction', () => {
    fc.assert(
      fc.property(arbSpread, arbIsBuy, arbLegCount, (spread, isBuy, legCount) => {
        const price = computeModelFillPrice({
          fillModel: 'midpoint',
          bid: spread.bid,
          ask: spread.ask,
          isBuy,
          legCount,
        });
        expect(price).toBeCloseTo((spread.bid + spread.ask) / 2, 10);
      }),
    );
  });

  test('natural: buy fills at ask, sell fills at bid', () => {
    fc.assert(
      fc.property(arbSpread, arbLegCount, (spread, legCount) => {
        const buyPrice = computeModelFillPrice({
          fillModel: 'natural',
          bid: spread.bid,
          ask: spread.ask,
          isBuy: true,
          legCount,
        });
        const sellPrice = computeModelFillPrice({
          fillModel: 'natural',
          bid: spread.bid,
          ask: spread.ask,
          isBuy: false,
          legCount,
        });
        expect(buyPrice).toBeCloseTo(spread.ask, 10);
        expect(sellPrice).toBeCloseTo(spread.bid, 10);
      }),
    );
  });

  test('buy fill >= sell fill for any model (buyers pay more)', () => {
    fc.assert(
      fc.property(arbFillModel, arbSpread, arbLegCount, (model, spread, legCount) => {
        const buyPrice = computeModelFillPrice({
          fillModel: model,
          bid: spread.bid,
          ask: spread.ask,
          isBuy: true,
          legCount,
        });
        const sellPrice = computeModelFillPrice({
          fillModel: model,
          bid: spread.bid,
          ask: spread.ask,
          isBuy: false,
          legCount,
        });
        expect(buyPrice).toBeGreaterThanOrEqual(sellPrice - 1e-9);
      }),
    );
  });

  test('orats: more legs → fill closer to midpoint (lower fill pct)', () => {
    fc.assert(
      fc.property(arbSpread, arbIsBuy, (spread, isBuy) => {
        const mid = (spread.bid + spread.ask) / 2;
        const prices = [1, 2, 3, 4].map((legs) =>
          computeModelFillPrice({
            fillModel: 'orats',
            bid: spread.bid,
            ask: spread.ask,
            isBuy,
            legCount: legs,
          }),
        );
        for (let i = 1; i < prices.length; i++) {
          const distPrev = Math.abs(prices[i - 1] - mid);
          const distCurr = Math.abs(prices[i] - mid);
          expect(distCurr).toBeLessThanOrEqual(distPrev + 1e-9);
        }
      }),
    );
  });

  test('zero-width spread: all models return bid (= ask)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 500, noNaN: true, noDefaultInfinity: true }),
        arbFillModel,
        arbIsBuy,
        arbLegCount,
        (price, model, isBuy, legCount) => {
          const result = computeModelFillPrice({
            fillModel: model,
            bid: price,
            ask: price,
            isBuy,
            legCount,
          });
          expect(result).toBeCloseTo(price, 10);
        },
      ),
    );
  });
});

// ── 2. computeTradePnl ───────────────────────────────────────────────

describe('computeTradePnl properties', () => {
  test('round-trip (entry = exit) always yields zero PnL', () => {
    fc.assert(
      fc.property(arbPrice, arbDirection, arbStrategy, arbQuantity, (price, direction, strategy, quantity) => {
        const pnl = computeTradePnl({ entryPrice: price, exitPrice: price, direction, strategy, quantity });
        expect(Object.is(pnl, 0)).toBe(true); // must be +0, never -0
      }),
    );
  });

  test('LONG: higher exit → positive PnL; lower exit → negative PnL', () => {
    fc.assert(
      fc.property(arbPrice, arbStrategy, arbQuantity, (entry, strategy, quantity) => {
        const up = computeTradePnl({
          entryPrice: entry,
          exitPrice: entry + 1,
          direction: 'LONG',
          strategy,
          quantity,
        });
        const down = computeTradePnl({
          entryPrice: entry,
          exitPrice: entry - 0.5,
          direction: 'LONG',
          strategy,
          quantity,
        });
        expect(up).toBeGreaterThan(0);
        expect(down).toBeLessThan(0);
      }),
    );
  });

  test('SHORT: lower exit → positive PnL; higher exit → negative PnL', () => {
    fc.assert(
      fc.property(arbPrice, arbStrategy, arbQuantity, (entry, strategy, quantity) => {
        const up = computeTradePnl({
          entryPrice: entry,
          exitPrice: entry + 1,
          direction: 'SHORT',
          strategy,
          quantity,
        });
        const down = computeTradePnl({
          entryPrice: entry,
          exitPrice: entry - 0.5,
          direction: 'SHORT',
          strategy,
          quantity,
        });
        expect(up).toBeLessThan(0);
        expect(down).toBeGreaterThan(0);
      }),
    );
  });

  test('LONG and SHORT PnL are negatives of each other', () => {
    fc.assert(
      fc.property(arbPrice, arbPrice, arbStrategy, arbQuantity, (entry, exit, strategy, quantity) => {
        const longPnl = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction: 'LONG', strategy, quantity });
        const shortPnl = computeTradePnl({
          entryPrice: entry,
          exitPrice: exit,
          direction: 'SHORT',
          strategy,
          quantity,
        });
        expect(longPnl + shortPnl).toBeCloseTo(0, 8);
      }),
    );
  });

  test('NaN inputs throw instead of silently returning 0', () => {
    expect(() =>
      computeTradePnl({ entryPrice: NaN, exitPrice: 100, direction: 'LONG', strategy: 'STOCK', quantity: 1 }),
    ).toThrow('NaN');
    expect(() =>
      computeTradePnl({ entryPrice: 100, exitPrice: NaN, direction: 'LONG', strategy: 'STOCK', quantity: 1 }),
    ).toThrow('NaN');
    expect(() =>
      computeTradePnl({ entryPrice: 100, exitPrice: 100, direction: 'LONG', strategy: 'STOCK', quantity: NaN }),
    ).toThrow('NaN');
  });

  test('options multiply by 100, stock by 1', () => {
    fc.assert(
      fc.property(arbPrice, arbPrice, arbDirection, arbQuantity, (entry, exit, direction, quantity) => {
        const stockPnl = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy: 'STOCK', quantity });
        const optionPnl = computeTradePnl({
          entryPrice: entry,
          exitPrice: exit,
          direction,
          strategy: 'CALL_SPREAD',
          quantity,
        });
        // The 100x contract multiplier means |optionPnl| >= |stockPnl| always.
        // Exact 100x ratio only holds when cents rounding doesn't distort small values,
        // so check the ratio only when stockPnl is large enough to avoid rounding noise.
        expect(Math.abs(optionPnl)).toBeGreaterThanOrEqual(Math.abs(stockPnl) - 0.01);
        if (Math.abs(stockPnl) >= 1) {
          // Allow ±0.5 tolerance — cents rounding at different scales causes small drift
          expect(optionPnl / stockPnl).toBeCloseTo(100, 0);
        }
      }),
    );
  });
});

// ── 3. SimBroker placeOrder ──────────────────────────────────────────

describe('SimBroker.placeOrder properties', () => {
  test('MARKET order always fills with status FILLED and price > 0', () => {
    fc.assert(
      fc.asyncProperty(arbFillModel, arbSpread, async (model, spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', model, TEST_EQUITY);
        const result = await broker.placeOrder(makeStockBuyOrder());
        expect(result.status).toBe('FILLED');
        expect(result.filledPrice).toBeGreaterThan(0);
        expect(result.fillTimestamp).toBeDefined();
      }),
      { numRuns: 500 },
    );
  });

  test('MARKET fill price is always rounded to cents', () => {
    fc.assert(
      fc.asyncProperty(arbFillModel, arbSpread, async (model, spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', model, TEST_EQUITY);
        const result = await broker.placeOrder(makeStockBuyOrder());
        expect(result.filledPrice).toBe(roundCents(result.filledPrice!));
      }),
      { numRuns: 500 },
    );
  });

  test('LIMIT with no limitPrice is rejected', () => {
    fc.assert(
      fc.asyncProperty(arbFillModel, arbSpread, async (model, spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', model, TEST_EQUITY);
        const result = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT' }));
        expect(result.status).toBe('REJECTED');
      }),
    );
  });

  test('LIMIT BUY within spread fills immediately at the limit price', () => {
    fc.assert(
      fc.asyncProperty(arbFillModel, arbSpread, async (model, spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const limitPrice = spread.ask;
        const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', model, TEST_EQUITY);
        const result = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
        expect(result.status).toBe('FILLED');
        expect(result.filledPrice).toBe(roundCents(limitPrice));
      }),
    );
  });

  test('LIMIT BUY between bid and ask queues as OPEN (does not fill at midspread)', () => {
    fc.assert(
      fc.asyncProperty(
        arbSpread.filter((s) => s.ask - s.bid > 0.02),
        async (spread) => {
          const quote = makeQuote(spread.bid, spread.ask);
          // Limit at midpoint — above bid but below ask
          const limitPrice = (spread.bid + spread.ask) / 2;
          const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
          const result = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
          expect(result.status).toBe('OPEN');
        },
      ),
    );
  });

  test('LIMIT SELL between bid and ask queues as OPEN (does not fill at midspread)', () => {
    fc.assert(
      fc.asyncProperty(
        arbSpread.filter((s) => s.ask - s.bid > 0.02),
        async (spread) => {
          const quote = makeQuote(spread.bid, spread.ask);
          const limitPrice = (spread.bid + spread.ask) / 2;
          const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
          const result = await broker.placeOrder(makeStockSellOrder({ orderType: 'LIMIT', limitPrice }));
          expect(result.status).toBe('OPEN');
        },
      ),
    );
  });

  test('LIMIT BUY below bid queues as OPEN', () => {
    fc.assert(
      fc.asyncProperty(arbSpread.filter((s) => s.bid > 0.02), async (spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const limitPrice = spread.bid - 0.01;
        const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
        const result = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
        expect(result.status).toBe('OPEN');
      }),
    );
  });

  test('each order gets a unique orderId', () => {
    fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 20 }), async (n) => {
        const quote = makeQuote(100, 101);
        const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'midpoint', TEST_EQUITY);
        const ids = new Set<string>();
        for (let i = 0; i < n; i++) {
          const result = await broker.placeOrder(makeStockBuyOrder());
          ids.add(result.orderId);
        }
        expect(ids.size).toBe(n);
      }),
    );
  });
});

// ── 4. Order lifecycle: modify, cancel, status ───────────────────────

describe('SimBroker order lifecycle properties', () => {
  test('cancelling a working order returns CANCELLED', () => {
    fc.assert(
      fc.asyncProperty(arbSpread.filter((s) => s.bid > 0.02), async (spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
        const limit = spread.bid - 0.01;
        const order = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice: limit }));
        expect(order.status).toBe('OPEN');

        const cancel = await broker.cancelOrder(order.orderId);
        expect(cancel.status).toBe('CANCELLED');
      }),
    );
  });

  test('cancelling unknown orderId returns REJECTED', () => {
    fc.assert(
      fc.asyncProperty(fc.string(), async (randomId) => {
        const broker = new SimBroker(stubMarketDataFromQuote(makeQuote(100, 101)), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
        const result = await broker.cancelOrder(randomId);
        expect(result.status).toBe('REJECTED');
      }),
    );
  });

  test('modifyOrder updates limit price and order stays OPEN', () => {
    fc.assert(
      fc.asyncProperty(
        arbSpread.filter((s) => s.bid > 1),
        fc.double({ min: 0.01, max: 0.99, noNaN: true, noDefaultInfinity: true }),
        async (spread, offset) => {
          const quote = makeQuote(spread.bid, spread.ask);
          const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
          const limit = spread.bid - 1;
          const order = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice: limit }));
          expect(order.status).toBe('OPEN');

          const newLimit = limit - offset;
          const mod = await broker.modifyOrder(order.orderId, newLimit);
          expect(mod.status).toBe('OPEN');
        },
      ),
    );
  });

  test('modifying unknown orderId returns REJECTED', () => {
    fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.double({ min: 1, max: 100, noNaN: true, noDefaultInfinity: true }),
        async (randomId, price) => {
          const broker = new SimBroker(stubMarketDataFromQuote(makeQuote(100, 101)), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
          const result = await broker.modifyOrder(randomId, price);
          expect(result.status).toBe('REJECTED');
        },
      ),
    );
  });
});

// ── 5. processQuoteTick ──────────────────────────────────────────────

describe('processQuoteTick properties', () => {
  test('BUY limit fills only when limit >= ask', () => {
    fc.assert(
      fc.asyncProperty(
        arbSpread.filter((s) => s.bid > 0.02),
        arbSpread,
        async (orderSpread, tickSpread) => {
          const quote = makeQuote(orderSpread.bid, orderSpread.ask);
          const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
          const limitPrice = orderSpread.bid - 0.01;
          const order = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
          if (order.status !== 'OPEN') return;

          const tick: QuoteTick = { symbol: 'SPY', bid: tickSpread.bid, ask: tickSpread.ask, timestamp: new Date() };
          const fills = broker.processQuoteTick(tick);

          if (limitPrice >= tickSpread.ask) {
            expect(fills.length).toBe(1);
            // Price improvement: fill at min(limit, ask)
            expect(fills[0].price).toBe(roundCents(Math.min(limitPrice, tickSpread.ask)));
          } else {
            expect(fills.length).toBe(0);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  test('SELL limit fills only when limit <= bid', () => {
    fc.assert(
      fc.asyncProperty(
        arbSpread.filter((s) => s.ask < 499),
        arbSpread,
        async (orderSpread, tickSpread) => {
          const quote = makeQuote(orderSpread.bid, orderSpread.ask);
          const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
          const limitPrice = orderSpread.ask + 0.01;
          const order = await broker.placeOrder(makeStockSellOrder({ orderType: 'LIMIT', limitPrice }));
          if (order.status !== 'OPEN') return;

          const tick: QuoteTick = { symbol: 'SPY', bid: tickSpread.bid, ask: tickSpread.ask, timestamp: new Date() };
          const fills = broker.processQuoteTick(tick);

          if (limitPrice <= tickSpread.bid) {
            expect(fills.length).toBe(1);
            // Price improvement: fill at max(limit, bid)
            expect(fills[0].price).toBe(roundCents(Math.max(limitPrice, tickSpread.bid)));
          } else {
            expect(fills.length).toBe(0);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  test('each working order fills at most once across multiple ticks', () => {
    fc.assert(
      fc.asyncProperty(
        arbSpread.filter((s) => s.bid > 0.02),
        fc.array(arbSpread, { minLength: 2, maxLength: 20 }),
        async (orderSpread, ticks) => {
          const quote = makeQuote(orderSpread.bid, orderSpread.ask);
          const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
          const limitPrice = orderSpread.bid - 0.01;
          const order = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
          if (order.status !== 'OPEN') return;

          let totalFills = 0;
          for (const t of ticks) {
            const tick: QuoteTick = { symbol: 'SPY', bid: t.bid, ask: t.ask, timestamp: new Date() };
            totalFills += broker.processQuoteTick(tick).length;
          }
          expect(totalFills).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 500 },
    );
  });

  test('filled price gets price improvement (min of limit and ask for buys)', () => {
    fc.assert(
      fc.asyncProperty(arbSpread.filter((s) => s.bid > 5), async (spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
        const limitPrice = spread.bid - 1;
        const order = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
        if (order.status !== 'OPEN') return;

        const tick: QuoteTick = { symbol: 'SPY', bid: 0.01, ask: 0.01, timestamp: new Date() };
        const fills = broker.processQuoteTick(tick);
        expect(fills.length).toBe(1);
        // Price improvement: fill at min(limit, ask) — here ask=0.01 < limit
        expect(fills[0].price).toBe(roundCents(Math.min(limitPrice, 0.01)));
      }),
    );
  });

  test('ticks for unrelated symbols do not fill orders', () => {
    fc.assert(
      fc.asyncProperty(arbSpread.filter((s) => s.bid > 0.02), async (spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), 'test-run', 'orats', TEST_EQUITY);
        const limitPrice = spread.bid - 0.01;
        await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));

        const tick: QuoteTick = { symbol: 'AAPL', bid: 0.01, ask: 0.01, timestamp: new Date() };
        const fills = broker.processQuoteTick(tick);
        expect(fills.length).toBe(0);
      }),
    );
  });
});

// ── 6. Working order margin encumbrance ──────────────────────────────

describe('working order margin encumbrance', () => {
  test('placing a limit order reduces available buying power by its margin', () => {
    fc.assert(
      fc.asyncProperty(
        arbSpread.filter((s) => s.ask - s.bid > 0.10 && s.ask < 200),
        async (spread) => {
          await db.run(sql`DELETE FROM trades`);

          const quote = makeQuote(spread.bid, spread.ask);
          const runId = `enc-${Date.now()}-${Math.random()}`;
          const broker = new SimBroker(stubMarketDataFromQuote(quote), new SimClock(), runId, 'orats', TEST_EQUITY);

          const bpBefore = (await broker.getAccountBalance()).buyingPower;

          // Place a BUY LIMIT below the ask — queues without filling
          const limitPrice = roundCents(spread.bid + (spread.ask - spread.bid) * 0.3);
          const order = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
          if (order.status !== 'OPEN') return; // skip if it filled immediately

          const bpAfter = (await broker.getAccountBalance()).buyingPower;

          // STOCK LONG margin = 50% of entry price × qty × 1 (contractMult=1)
          // Working order encumbers initial margin at the limit price.
          // Allow $0.02 tolerance for cumulative roundCents in getAccountBalance.
          const expectedEncumbrance = 0.50 * limitPrice;
          const actualEncumbrance = bpBefore - bpAfter;
          expect(Math.abs(actualEncumbrance - expectedEncumbrance)).toBeLessThan(0.02);
        },
      ),
      { numRuns: 200 },
    );
  });
});
