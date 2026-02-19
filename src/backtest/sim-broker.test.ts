/**
 * Property-based tests for SimBroker.
 *
 * Uses fast-check to generate random inputs and assert invariants
 * ("properties") that must hold for ALL inputs — not just hand-picked examples.
 *
 * Focuses on the pure / DB-free surface:
 *   - computeModelFillPrice (pure function)
 *   - placeOrder (MARKET + LIMIT), processQuoteTick, order lifecycle
 *   - computeTradePnl (pure function used by SimBroker)
 */

import { describe, test, expect, vi } from 'vitest';
import fc from 'fast-check';

// Mock the DB module before any sim-broker imports (top-level import opens SQLite file)
vi.mock('../db/client.js', () => ({
  db: {},
  schema: { trades: {} },
}));

import { computeModelFillPrice, SimBroker } from './sim-broker.js';
import { SimClock } from './clock.js';
import { computeTradePnl } from '../lib/pnl.js';
import { roundCents } from '../lib/numbers.js';
import type { Quote, OrderParams, OptionsChain, Bar } from '../broker/types.js';
import type { BacktestPriceProvider } from './market-data.js';
import type { QuoteTick } from './databento-tape.js';
import type { FillModel } from './types.js';

// ── Arbitraries ──────────────────────────────────────────────────────

const arbFillModel: fc.Arbitrary<FillModel> = fc.constantFrom('orats', 'midpoint', 'natural');

/** Bid/ask pair where bid <= ask and both > 0, realistic price range. */
const arbSpread = fc
  .record({
    bid: fc.double({ min: 0.01, max: 500, noNaN: true, noDefaultInfinity: true }),
    ask: fc.double({ min: 0.01, max: 500, noNaN: true, noDefaultInfinity: true }),
  })
  .filter((q) => q.ask >= q.bid);

const arbIsBuy = fc.boolean();
const arbLegCount = fc.integer({ min: 1, max: 4 });

const arbDirection: fc.Arbitrary<'LONG' | 'SHORT'> = fc.constantFrom('LONG', 'SHORT');
const arbStrategy = fc.constantFrom('STOCK', 'CALL_SPREAD', 'PUT_SPREAD', 'IRON_CONDOR');
const arbQuantity = fc.integer({ min: 1, max: 100 });
const arbPrice = fc.double({ min: 0.01, max: 5000, noNaN: true, noDefaultInfinity: true });

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal mock of BacktestPriceProvider that returns a fixed quote. */
function stubMarketData(quote: Quote): BacktestPriceProvider {
  return {
    getQuote: async () => quote,
    getOptionsChain: async () =>
      ({ symbol: 'SPY', expiry: '2026-03-20', optionType: 'CALL', strikes: [] }) as OptionsChain,
    getBars: async () => [] as Bar[],
    getPriceSnapshot: () => ({}),
    getTicksInRange: async () => [] as QuoteTick[],
    prefetch: async () => {},
  };
}

function makeQuote(bid: number, ask: number): Quote {
  return { symbol: 'SPY', bid, ask, last: (bid + ask) / 2, volume: 1000, timestamp: new Date().toISOString() };
}

function makeStockBuyOrder(overrides: Partial<OrderParams> = {}): OrderParams {
  return {
    symbol: 'SPY',
    strategy: 'STOCK',
    direction: 'LONG',
    legs: [{ strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: 1 }],
    orderType: 'MARKET',
    ...overrides,
  };
}

function makeStockSellOrder(overrides: Partial<OrderParams> = {}): OrderParams {
  return {
    symbol: 'SPY',
    strategy: 'STOCK',
    direction: 'SHORT',
    legs: [{ strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'SELL', quantity: 1 }],
    orderType: 'MARKET',
    ...overrides,
  };
}

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
        const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', model);
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
        const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', model);
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
        const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', model);
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
        const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', model);
        const result = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
        expect(result.status).toBe('FILLED');
        expect(result.filledPrice).toBe(roundCents(limitPrice));
      }),
    );
  });

  test('LIMIT BUY below bid queues as OPEN', () => {
    fc.assert(
      fc.asyncProperty(arbSpread.filter((s) => s.bid > 0.02), async (spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const limitPrice = spread.bid - 0.01;
        const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', 'orats');
        const result = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
        expect(result.status).toBe('OPEN');
      }),
    );
  });

  test('each order gets a unique orderId', () => {
    fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 20 }), async (n) => {
        const quote = makeQuote(100, 101);
        const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', 'midpoint');
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
        const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', 'orats');
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
        const broker = new SimBroker(stubMarketData(makeQuote(100, 101)), new SimClock(), 'test-run', 'orats');
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
          const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', 'orats');
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
          const broker = new SimBroker(stubMarketData(makeQuote(100, 101)), new SimClock(), 'test-run', 'orats');
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
          const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', 'orats');
          const limitPrice = orderSpread.bid - 0.01;
          const order = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
          if (order.status !== 'OPEN') return;

          const tick: QuoteTick = { symbol: 'SPY', bid: tickSpread.bid, ask: tickSpread.ask, timestamp: new Date() };
          const fills = broker.processQuoteTick(tick);

          if (limitPrice >= tickSpread.ask) {
            expect(fills.length).toBe(1);
            expect(fills[0].price).toBe(roundCents(limitPrice));
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
          const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', 'orats');
          const limitPrice = orderSpread.ask + 0.01;
          const order = await broker.placeOrder(makeStockSellOrder({ orderType: 'LIMIT', limitPrice }));
          if (order.status !== 'OPEN') return;

          const tick: QuoteTick = { symbol: 'SPY', bid: tickSpread.bid, ask: tickSpread.ask, timestamp: new Date() };
          const fills = broker.processQuoteTick(tick);

          if (limitPrice <= tickSpread.bid) {
            expect(fills.length).toBe(1);
            expect(fills[0].price).toBe(roundCents(limitPrice));
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
          const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', 'orats');
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

  test('filled price always equals the limit price (not tick price)', () => {
    fc.assert(
      fc.asyncProperty(arbSpread.filter((s) => s.bid > 5), async (spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', 'orats');
        const limitPrice = spread.bid - 1;
        const order = await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));
        if (order.status !== 'OPEN') return;

        const tick: QuoteTick = { symbol: 'SPY', bid: 0.01, ask: 0.01, timestamp: new Date() };
        const fills = broker.processQuoteTick(tick);
        expect(fills.length).toBe(1);
        expect(fills[0].price).toBe(roundCents(limitPrice));
      }),
    );
  });

  test('ticks for unrelated symbols do not fill orders', () => {
    fc.assert(
      fc.asyncProperty(arbSpread.filter((s) => s.bid > 0.02), async (spread) => {
        const quote = makeQuote(spread.bid, spread.ask);
        const broker = new SimBroker(stubMarketData(quote), new SimClock(), 'test-run', 'orats');
        const limitPrice = spread.bid - 0.01;
        await broker.placeOrder(makeStockBuyOrder({ orderType: 'LIMIT', limitPrice }));

        const tick: QuoteTick = { symbol: 'AAPL', bid: 0.01, ask: 0.01, timestamp: new Date() };
        const fills = broker.processQuoteTick(tick);
        expect(fills.length).toBe(0);
      }),
    );
  });
});
