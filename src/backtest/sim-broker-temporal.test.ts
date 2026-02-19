/**
 * Temporal property tests for SimBroker.
 *
 * Uses a time-aware market data stub where option prices decay via
 * sqrt(daysToExpiry) and underlying prices follow a generated path.
 * Verifies that SimBroker invariants hold at every point in simulated time.
 *
 * Covers: equity identity over time, mark/PnL consistency at each timestamp,
 *         theta decay, expiry convergence, stock mark tracking, and
 *         full lifecycle (open → mark → close) across time steps.
 */

import { describe, test, expect, vi, beforeAll } from 'vitest';
import fc from 'fast-check';

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
  makeTimeAwareStub,
  makeQuote,
  makeStockBuyOrder,
  constantPrice,
  linearPrice,
  makeDbHelpers,
  CREATE_TRADES_SQL,
  type PriceFn,
} from './test-fixtures.js';

// ── DB setup ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await db.run(CREATE_TRADES_SQL);
});

const RUN_ID = 'temporal-run';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const {
  resetDb,
  insertOpenTrade,
  insertClosedTrade,
  insertOpenOptionTrade,
} = makeDbHelpers(db, schema, RUN_ID);

// Fixed time references — options expiry is 2026-06-19, giving ~168 days from T0.
const T0 = new Date('2026-01-02T10:00:00Z');
const EXPIRY = '2026-06-19';
const EXPIRY_DATE = new Date('2026-06-19T00:00:00Z'); // UTC midnight = OCC expiry date

/** Build N evenly-spaced timestamps between `from` and `to` (inclusive of both). */
function spacedTimestamps(from: Date, to: Date, n: number): Date[] {
  if (n <= 1) return [from];
  const fromMs = from.getTime();
  const step = (to.getTime() - fromMs) / (n - 1);
  return Array.from({ length: n }, (_, i) => new Date(fromMs + Math.round(step * i)));
}

/** Expected time value from our sqrt-decay stub model. */
function expectedTimeValue(baseTV: number, at: Date, expiryDate: Date): number {
  const msToExpiry = Math.max(0, expiryDate.getTime() - at.getTime());
  const daysToExpiry = msToExpiry / MS_PER_DAY;
  return baseTV * Math.sqrt(daysToExpiry / 365);
}

// ── 1. Equity identity holds at every timestamp ──────────────────────

describe('temporal: equity identity', () => {
  test('equity = cashBalance + unrealizedPnl at every time step (STOCK)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEquity,
        arbEntryPrice,
        arbMarkPrice,
        arbDirection,
        arbQuantity,
        async (startingEquity, entry, endPrice, direction, quantity) => {
          await resetDb();
          await insertOpenTrade({ direction, strategy: 'STOCK', entryPrice: entry, quantity });

          const startPrice = entry; // start at entry so T0 unrealized ~ 0
          const timestamps = spacedTimestamps(T0, new Date(T0.getTime() + 30 * MS_PER_DAY), 4);
          const priceFn = linearPrice(startPrice, endPrice, timestamps[0], timestamps[timestamps.length - 1]);
          const md = makeTimeAwareStub({ underlyings: { SPY: priceFn } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint', startingEquity);

          for (const t of timestamps) {
            clock.advance(t);
            const bal = await broker.getAccountBalance();
            expect(bal.equity).toBeCloseTo(bal.cashBalance + bal.unrealizedPnl, 1);
            // No closed trades yet, so cashBalance = startingEquity
            expect(bal.cashBalance).toBeCloseTo(startingEquity, 1);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  test('equity = cashBalance + unrealizedPnl at every time step (CALL option)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEquity,
        arbEntryPrice,
        fc.double({ min: 100, max: 400, noNaN: true, noDefaultInfinity: true }),
        arbQuantity,
        async (startingEquity, entry, underlyingPrice, quantity) => {
          await resetDb();
          const strike = 250;
          await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'CALL',
            entryPrice: entry,
            quantity,
            legs: [{ strike, expiry: EXPIRY, type: 'CALL', action: 'BUY', quantity }],
          });

          const timestamps = spacedTimestamps(T0, new Date(T0.getTime() + 60 * MS_PER_DAY), 4);
          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint', startingEquity);

          for (const t of timestamps) {
            clock.advance(t);
            const bal = await broker.getAccountBalance();
            expect(bal.equity).toBeCloseTo(bal.cashBalance + bal.unrealizedPnl, 1);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  test('equity = cashBalance + unrealizedPnl at every time step (CDS spread)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEquity,
        arbEntryPrice,
        fc.double({ min: 100, max: 400, noNaN: true, noDefaultInfinity: true }),
        arbQuantity,
        async (startingEquity, entry, underlyingPrice, quantity) => {
          await resetDb();
          await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'CDS',
            entryPrice: entry,
            quantity,
            legs: [
              { strike: 240, expiry: EXPIRY, type: 'CALL', action: 'BUY', quantity },
              { strike: 250, expiry: EXPIRY, type: 'CALL', action: 'SELL', quantity },
            ],
          });

          const timestamps = spacedTimestamps(T0, new Date(T0.getTime() + 60 * MS_PER_DAY), 4);
          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint', startingEquity);

          for (const t of timestamps) {
            clock.advance(t);
            const bal = await broker.getAccountBalance();
            expect(bal.equity).toBeCloseTo(bal.cashBalance + bal.unrealizedPnl, 1);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── 2. Mark consistency: unrealizedPnl = computeTradePnl(entry, mark) ─

describe('temporal: mark-to-PnL consistency', () => {
  test('unrealizedPnl = computeTradePnl(entry, mark(T)) at each timestamp (STOCK)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEntryPrice,
        arbMarkPrice,
        arbDirection,
        arbQuantity,
        async (entry, endPrice, direction, quantity) => {
          await resetDb();
          const tradeId = await insertOpenTrade({ direction, strategy: 'STOCK', entryPrice: entry, quantity });

          const timestamps = spacedTimestamps(T0, new Date(T0.getTime() + 20 * MS_PER_DAY), 3);
          const priceFn = linearPrice(entry, endPrice, timestamps[0], timestamps[timestamps.length - 1]);
          const md = makeTimeAwareStub({ underlyings: { SPY: priceFn } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          for (const t of timestamps) {
            clock.advance(t);
            const marks = await broker.markToMarket();
            const markPrice = marks.get(tradeId)!;
            const unrealized = await broker.getUnrealizedPnl();
            const expected = computeTradePnl({ entryPrice: entry, exitPrice: markPrice, direction, strategy: 'STOCK', quantity });
            expect(unrealized).toBeCloseTo(roundCents(expected), 1);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  test('unrealizedPnl = computeTradePnl(entry, mark(T)) at each timestamp (CALL)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEntryPrice,
        fc.double({ min: 100, max: 400, noNaN: true, noDefaultInfinity: true }),
        arbQuantity,
        async (entry, underlyingPrice, quantity) => {
          await resetDb();
          const strike = 250;
          const tradeId = await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'CALL',
            entryPrice: entry,
            quantity,
            legs: [{ strike, expiry: EXPIRY, type: 'CALL', action: 'BUY', quantity }],
          });

          const timestamps = spacedTimestamps(T0, new Date(T0.getTime() + 60 * MS_PER_DAY), 4);
          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          for (const t of timestamps) {
            clock.advance(t);
            const marks = await broker.markToMarket();
            const markPrice = marks.get(tradeId)!;
            const unrealized = await broker.getUnrealizedPnl();
            const expected = computeTradePnl({ entryPrice: entry, exitPrice: markPrice, direction: 'LONG', strategy: 'CALL', quantity });
            expect(unrealized).toBeCloseTo(roundCents(expected), 1);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── 3. Theta decay: same underlying, closer to expiry → lower mark ──

describe('temporal: theta decay', () => {
  test('single CALL: mark decreases as time passes (constant underlying)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 100, max: 400, noNaN: true, noDefaultInfinity: true }),
        arbQuantity,
        async (underlyingPrice, quantity) => {
          await resetDb();
          const strike = 250;
          const tradeId = await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'CALL',
            entryPrice: 5,
            quantity,
            legs: [{ strike, expiry: EXPIRY, type: 'CALL', action: 'BUY', quantity }],
          });

          // 5 timestamps from T0 to 10 days before expiry (to avoid expiry edge)
          const tEnd = new Date(EXPIRY_DATE.getTime() - 10 * MS_PER_DAY);
          const timestamps = spacedTimestamps(T0, tEnd, 5);

          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          const markValues: number[] = [];
          for (const t of timestamps) {
            clock.advance(t);
            const marks = await broker.markToMarket();
            markValues.push(marks.get(tradeId)!);
          }

          // Each mark should be <= the previous one (theta decay)
          for (let i = 1; i < markValues.length; i++) {
            expect(markValues[i]).toBeLessThanOrEqual(markValues[i - 1] + 1e-9);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  test('single PUT: mark decreases as time passes (constant underlying)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 100, max: 400, noNaN: true, noDefaultInfinity: true }),
        async (underlyingPrice) => {
          await resetDb();
          const strike = 250;
          const tradeId = await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'PUT',
            entryPrice: 5,
            quantity: 1,
            legs: [{ strike, expiry: EXPIRY, type: 'PUT', action: 'BUY', quantity: 1 }],
          });

          const tEnd = new Date(EXPIRY_DATE.getTime() - 10 * MS_PER_DAY);
          const timestamps = spacedTimestamps(T0, tEnd, 5);
          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          const markValues: number[] = [];
          for (const t of timestamps) {
            clock.advance(t);
            const marks = await broker.markToMarket();
            markValues.push(marks.get(tradeId)!);
          }

          for (let i = 1; i < markValues.length; i++) {
            expect(markValues[i]).toBeLessThanOrEqual(markValues[i - 1] + 1e-9);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  test('PDS spread: net mark decreases as time passes (constant underlying)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 200, max: 300, noNaN: true, noDefaultInfinity: true }),
        async (underlyingPrice) => {
          await resetDb();
          // Put debit spread: BUY higher strike put, SELL lower strike put
          const tradeId = await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'PDS',
            entryPrice: 3,
            quantity: 1,
            legs: [
              { strike: 260, expiry: EXPIRY, type: 'PUT', action: 'BUY', quantity: 1 },
              { strike: 250, expiry: EXPIRY, type: 'PUT', action: 'SELL', quantity: 1 },
            ],
          });

          const tEnd = new Date(EXPIRY_DATE.getTime() - 10 * MS_PER_DAY);
          const timestamps = spacedTimestamps(T0, tEnd, 5);
          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          const markValues: number[] = [];
          for (const t of timestamps) {
            clock.advance(t);
            const marks = await broker.markToMarket();
            markValues.push(marks.get(tradeId)!);
          }

          // For a spread the net time value also decays (both legs lose time value,
          // but BUY leg has more at-risk), so the mark should decrease or stay same.
          // Allow tiny float tolerance.
          for (let i = 1; i < markValues.length; i++) {
            expect(markValues[i]).toBeLessThanOrEqual(markValues[i - 1] + 0.01);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── 4. Expiry convergence: at expiry, mark = intrinsic ───────────────

describe('temporal: expiry convergence', () => {
  test('CALL mark at expiry = intrinsic (zero time value)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 100, max: 400, noNaN: true, noDefaultInfinity: true }),
        async (underlyingPrice) => {
          await resetDb();
          const strike = 250;
          const tradeId = await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'CALL',
            entryPrice: 5,
            quantity: 1,
            legs: [{ strike, expiry: EXPIRY, type: 'CALL', action: 'BUY', quantity: 1 }],
          });

          // Use zero spread so abs() normalization doesn't distort near-zero intrinsic
          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) }, optionHalfSpread: 0 });
          const clock = new SimClock(EXPIRY_DATE);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          const marks = await broker.markToMarket();
          const mark = marks.get(tradeId)!;
          const intrinsic = Math.max(0, underlyingPrice - strike);
          expect(mark).toBeCloseTo(intrinsic, 2);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('PUT mark at expiry = intrinsic (zero time value)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 100, max: 400, noNaN: true, noDefaultInfinity: true }),
        async (underlyingPrice) => {
          await resetDb();
          const strike = 250;
          const tradeId = await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'PUT',
            entryPrice: 5,
            quantity: 1,
            legs: [{ strike, expiry: EXPIRY, type: 'PUT', action: 'BUY', quantity: 1 }],
          });

          // Use zero spread so abs() normalization doesn't distort near-zero intrinsic
          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) }, optionHalfSpread: 0 });
          const clock = new SimClock(EXPIRY_DATE);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          const marks = await broker.markToMarket();
          const mark = marks.get(tradeId)!;
          const intrinsic = Math.max(0, strike - underlyingPrice);
          expect(mark).toBeCloseTo(intrinsic, 2);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('CDS spread mark at expiry = net intrinsic', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 200, max: 300, noNaN: true, noDefaultInfinity: true }),
        async (underlyingPrice) => {
          await resetDb();
          const buyStrike = 240;
          const sellStrike = 250;
          const tradeId = await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'CDS',
            entryPrice: 3,
            quantity: 1,
            legs: [
              { strike: buyStrike, expiry: EXPIRY, type: 'CALL', action: 'BUY', quantity: 1 },
              { strike: sellStrike, expiry: EXPIRY, type: 'CALL', action: 'SELL', quantity: 1 },
            ],
          });

          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) } });
          const clock = new SimClock(EXPIRY_DATE);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          const marks = await broker.markToMarket();
          const mark = marks.get(tradeId)!;

          // At expiry, each leg mid = intrinsic. Net = BUY intrinsic - SELL intrinsic.
          // getOptionSpreadQuote normalises bid/ask to positive → mid = abs(net).
          const buyIntrinsic = Math.max(0, underlyingPrice - buyStrike);
          const sellIntrinsic = Math.max(0, underlyingPrice - sellStrike);
          // Net bid = buyBid - sellAsk, but at expiry time_value=0 so bid=ask=intrinsic.
          // Actually with opHS=0.10 spread: bid = intr-0.10, ask = intr+0.10
          // Net bid = (buyIntr-0.10) - (sellIntr+0.10)
          // Net ask = (buyIntr+0.10) - (sellIntr-0.10)
          const netBid = (buyIntrinsic - 0.10) - (sellIntrinsic + 0.10);
          const netAsk = (buyIntrinsic + 0.10) - (sellIntrinsic - 0.10);
          const absBid = Math.abs(netBid);
          const absAsk = Math.abs(netAsk);
          const expectedMid = (Math.min(absBid, absAsk) + Math.max(absBid, absAsk)) / 2;

          expect(mark).toBeCloseTo(expectedMid, 1);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── 5. Stock marks track underlying price changes ────────────────────

describe('temporal: stock marks track underlying', () => {
  test('mark(T1) ≠ mark(T2) when underlying has moved', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 50, max: 200, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 50, max: 200, noNaN: true, noDefaultInfinity: true }),
        async (startPrice, endPrice) => {
          // Ensure prices are sufficiently different
          fc.pre(Math.abs(endPrice - startPrice) > 1);

          await resetDb();
          const tradeId = await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });

          const t1 = T0;
          const t2 = new Date(T0.getTime() + 30 * MS_PER_DAY);
          const priceFn = linearPrice(startPrice, endPrice, t1, t2);
          const md = makeTimeAwareStub({ underlyings: { SPY: priceFn } });
          const clock = new SimClock(t1);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          const marks1 = await broker.markToMarket();
          clock.advance(t2);
          const marks2 = await broker.markToMarket();

          expect(marks1.get(tradeId)).not.toBeCloseTo(marks2.get(tradeId)!, 0);
        },
      ),
      { numRuns: 50 },
    );
  });

  test('stock mark equals underlying mid at each timestamp', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 50, max: 400, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 50, max: 400, noNaN: true, noDefaultInfinity: true }),
        async (startPrice, endPrice) => {
          await resetDb();
          const tradeId = await insertOpenTrade({ direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });

          const timestamps = spacedTimestamps(T0, new Date(T0.getTime() + 20 * MS_PER_DAY), 4);
          const priceFn = linearPrice(startPrice, endPrice, timestamps[0], timestamps[timestamps.length - 1]);
          const md = makeTimeAwareStub({ underlyings: { SPY: priceFn } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          for (const t of timestamps) {
            clock.advance(t);
            const marks = await broker.markToMarket();
            const mark = marks.get(tradeId)!;
            // The stub returns bid = p - 0.05, ask = p + 0.05, so mid = p
            const expected = priceFn(t);
            expect(mark).toBeCloseTo(expected, 2);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── 6. Full lifecycle over time ──────────────────────────────────────

describe('temporal: full lifecycle', () => {
  test('STOCK: open at T0, verify unrealized at T1, close at T2', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEquity,
        arbEntryPrice,
        arbMarkPrice,
        arbDirection,
        arbQuantity,
        async (startingEquity, entry, endPrice, direction, quantity) => {
          await resetDb();
          const tradeId = await insertOpenTrade({ direction, strategy: 'STOCK', entryPrice: entry, quantity });

          const t1 = new Date(T0.getTime() + 10 * MS_PER_DAY);
          const t2 = new Date(T0.getTime() + 20 * MS_PER_DAY);
          const priceFn = linearPrice(entry, endPrice, T0, t2);
          const md = makeTimeAwareStub({ underlyings: { SPY: priceFn } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint', startingEquity);

          // T1: check unrealized
          clock.advance(t1);
          const marks = await broker.markToMarket();
          const markAtT1 = marks.get(tradeId)!;
          const unrealizedT1 = await broker.getUnrealizedPnl();
          const expectedT1 = computeTradePnl({ entryPrice: entry, exitPrice: markAtT1, direction, strategy: 'STOCK', quantity });
          expect(unrealizedT1).toBeCloseTo(roundCents(expectedT1), 1);

          // T2: close at market price
          clock.advance(t2);
          const exitPrice = priceFn(t2);
          await broker.closePositionAtPrice(tradeId, exitPrice, t2.toISOString());

          const bal = await broker.getAccountBalance();
          expect(bal.unrealizedPnl).toBeCloseTo(0);
          expect(bal.equity).toBeCloseTo(bal.cashBalance, 1);

          const expectedPnl = computeTradePnl({ entryPrice: entry, exitPrice, direction, strategy: 'STOCK', quantity });
          expect(bal.realizedPnl).toBeCloseTo(expectedPnl, 1);
          expect(bal.equity).toBeCloseTo(startingEquity + expectedPnl, 1);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('CALL option: open at T0, verify decay at T1, close at T2', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEquity,
        arbEntryPrice,
        fc.double({ min: 200, max: 350, noNaN: true, noDefaultInfinity: true }),
        arbQuantity,
        async (startingEquity, entry, underlyingPrice, quantity) => {
          await resetDb();
          const strike = 250;
          const tradeId = await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'CALL',
            entryPrice: entry,
            quantity,
            legs: [{ strike, expiry: EXPIRY, type: 'CALL', action: 'BUY', quantity }],
          });

          const t1 = new Date(T0.getTime() + 30 * MS_PER_DAY);
          const t2 = new Date(T0.getTime() + 60 * MS_PER_DAY);
          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint', startingEquity);

          // T0: initial mark
          const marks0 = await broker.markToMarket();
          const mark0 = marks0.get(tradeId)!;

          // T1: mark should be less due to theta
          clock.advance(t1);
          const marks1 = await broker.markToMarket();
          const mark1 = marks1.get(tradeId)!;
          expect(mark1).toBeLessThanOrEqual(mark0 + 1e-9);

          // T2: close — verify lifecycle
          clock.advance(t2);
          const marks2 = await broker.markToMarket();
          const exitMark = marks2.get(tradeId)!;
          await broker.closePositionAtPrice(tradeId, exitMark, t2.toISOString());

          const bal = await broker.getAccountBalance();
          expect(bal.unrealizedPnl).toBeCloseTo(0);
          expect(bal.equity).toBeCloseTo(bal.cashBalance, 1);
          expect(bal.equity).toBeCloseTo(startingEquity + bal.realizedPnl, 1);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── 7. advanceTo: option limit fills via theta decay ─────────────────

describe('temporal: advanceTo option fills', () => {
  test('option LIMIT BUY fills when theta decay drops bid to limit', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 200, max: 350, noNaN: true, noDefaultInfinity: true }),
        async (underlyingPrice) => {
          await resetDb();
          const strike = 250;
          const baseTV = 3.0;

          // Compute the option bid at T0 so we can set limit below it
          const intrinsic = Math.max(0, underlyingPrice - strike);
          const dteT0 = (EXPIRY_DATE.getTime() - T0.getTime()) / MS_PER_DAY;
          const tvT0 = baseTV * Math.sqrt(dteT0 / 365);
          const midT0 = intrinsic + tvT0;
          const bidT0 = midT0 - 0.10;

          // Set limit halfway between intrinsic and T0 bid — theta should reach it
          const limit = roundCents(intrinsic + (bidT0 - intrinsic) * 0.3);

          // Ensure the limit is actually below the initial bid (skip degenerate cases)
          fc.pre(limit < bidT0 - 0.01);
          fc.pre(limit > 0);

          const md = makeTimeAwareStub({
            underlyings: { SPY: constantPrice(underlyingPrice) },
            baseTimeValue: baseTV,
          });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          // Place limit order (queued because limit < bid)
          const order = await broker.placeOrder({
            symbol: 'SPY',
            strategy: 'CALL',
            direction: 'LONG',
            legs: [{ strike, expiry: EXPIRY, type: 'CALL' as const, action: 'BUY' as const, quantity: 1 }],
            orderType: 'LIMIT',
            limitPrice: limit,
          });

          // If it filled immediately, skip (limit was within spread)
          if (order.status !== 'OPEN') return;

          // Advance day by day toward expiry — should eventually fill
          let filled = false;
          const dayStep = 7 * MS_PER_DAY;
          for (let ms = T0.getTime() + dayStep; ms <= EXPIRY_DATE.getTime(); ms += dayStep) {
            const t = new Date(ms);
            clock.advance(t);
            const fills = await broker.advanceTo(t);
            if (fills.length > 0) {
              expect(fills[0].price).toBe(roundCents(limit));
              filled = true;
              break;
            }
          }
          expect(filled).toBe(true);
        },
      ),
      { numRuns: 30 },
    );
  });

  test('option LIMIT BUY stays open when limit is below intrinsic', async () => {
    await resetDb();
    const underlyingPrice = 270; // ITM call
    const strike = 250;
    const intrinsic = underlyingPrice - strike; // = 20

    // Limit below intrinsic — can never fill (even at expiry, bid = intrinsic - opHS)
    const limit = intrinsic - 1; // $19

    const md = makeTimeAwareStub({
      underlyings: { SPY: constantPrice(underlyingPrice) },
      baseTimeValue: 2.0,
    });
    const clock = new SimClock(T0);
    const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

    const order = await broker.placeOrder({
      symbol: 'SPY',
      strategy: 'CALL',
      direction: 'LONG',
      legs: [{ strike, expiry: EXPIRY, type: 'CALL' as const, action: 'BUY' as const, quantity: 1 }],
      orderType: 'LIMIT',
      limitPrice: limit,
    });

    if (order.status !== 'OPEN') return;

    // Advance all the way to expiry — should never fill
    const dayStep = 14 * MS_PER_DAY;
    for (let ms = T0.getTime() + dayStep; ms <= EXPIRY_DATE.getTime(); ms += dayStep) {
      const t = new Date(ms);
      clock.advance(t);
      const fills = await broker.advanceTo(t);
      expect(fills.length).toBe(0);
    }
  });

  test('option order fills at most once across multiple advanceTo calls', async () => {
    await resetDb();
    const underlyingPrice = 260;
    const strike = 250;
    const intrinsic = underlyingPrice - strike; // = 10
    // Set limit at intrinsic + small amount — will fill quickly as TV decays
    const limit = roundCents(intrinsic + 0.5);

    const md = makeTimeAwareStub({
      underlyings: { SPY: constantPrice(underlyingPrice) },
      baseTimeValue: 2.0,
    });
    const clock = new SimClock(T0);
    const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

    const order = await broker.placeOrder({
      symbol: 'SPY',
      strategy: 'CALL',
      direction: 'LONG',
      legs: [{ strike, expiry: EXPIRY, type: 'CALL' as const, action: 'BUY' as const, quantity: 1 }],
      orderType: 'LIMIT',
      limitPrice: limit,
    });

    if (order.status !== 'OPEN') return;

    let totalFills = 0;
    const dayStep = 7 * MS_PER_DAY;
    for (let ms = T0.getTime() + dayStep; ms <= EXPIRY_DATE.getTime(); ms += dayStep) {
      const t = new Date(ms);
      clock.advance(t);
      totalFills += (await broker.advanceTo(t)).length;
    }
    expect(totalFills).toBeLessThanOrEqual(1);
  });
});

// ── 8. advanceTo: equity limit fills via tick replay ─────────────────

describe('temporal: advanceTo equity fills', () => {
  test('equity LIMIT BUY fills when price drops through limit via ticks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 110, max: 200, noNaN: true, noDefaultInfinity: true }),
        async (startPrice) => {
          await resetDb();

          // Price drops from startPrice to 50 — limit at 100 should fill
          const endPrice = 50;
          const limit = 100;
          fc.pre(startPrice > limit + 1);

          const t1 = new Date(T0.getTime() + 10 * MS_PER_DAY);
          const priceFn = linearPrice(startPrice, endPrice, T0, t1);
          const md = makeTimeAwareStub({
            underlyings: { SPY: priceFn },
            ticksPerRange: 10,
          });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          const order = await broker.placeOrder(makeStockBuyOrder({
            orderType: 'LIMIT',
            limitPrice: limit,
          }));

          if (order.status !== 'OPEN') return;

          clock.advance(t1);
          const fills = await broker.advanceTo(t1);

          // Price crosses 100 at some point between T0 and t1 → should fill
          expect(fills.length).toBe(1);
          expect(fills[0].price).toBe(roundCents(limit));
        },
      ),
      { numRuns: 30 },
    );
  });

  test('equity LIMIT BUY stays open when ask never drops to limit', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 150, max: 300, noNaN: true, noDefaultInfinity: true }),
        async (price) => {
          await resetDb();
          // Price stays constant well above limit
          const limit = 50;
          fc.pre(price > limit + 10);

          const t1 = new Date(T0.getTime() + 5 * MS_PER_DAY);
          const md = makeTimeAwareStub({
            underlyings: { SPY: constantPrice(price) },
            ticksPerRange: 5,
          });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          const order = await broker.placeOrder(makeStockBuyOrder({
            orderType: 'LIMIT',
            limitPrice: limit,
          }));

          if (order.status !== 'OPEN') return;

          clock.advance(t1);
          const fills = await broker.advanceTo(t1);
          expect(fills.length).toBe(0);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ── 9. Mixed open + closed equity identity ───────────────────────────

describe('temporal: mixed portfolio equity identity', () => {
  test('equity = startingEquity + realizedPnl + unrealizedPnl with mixed trades at every T', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEquity,
        // Closed trades
        fc.array(
          fc.record({
            entry: arbEntryPrice,
            exit: arbEntryPrice,
            direction: arbDirection,
            quantity: arbQuantity,
          }),
          { minLength: 1, maxLength: 3 },
        ),
        // Open trades
        fc.array(
          fc.record({
            entry: arbEntryPrice,
            direction: arbDirection,
            quantity: arbQuantity,
          }),
          { minLength: 1, maxLength: 3 },
        ),
        arbMarkPrice,
        async (startingEquity, closedTrades, openTrades, endPrice) => {
          await resetDb();

          // Insert closed trades with correct PnL
          let expectedRealized = 0;
          for (const ct of closedTrades) {
            const pnl = computeTradePnl({
              entryPrice: ct.entry,
              exitPrice: ct.exit,
              direction: ct.direction,
              strategy: 'STOCK',
              quantity: ct.quantity,
            });
            expectedRealized += pnl;
            await insertClosedTrade({
              direction: ct.direction,
              strategy: 'STOCK',
              entryPrice: ct.entry,
              exitPrice: ct.exit,
              quantity: ct.quantity,
              pnl,
            });
          }
          expectedRealized = roundCents(expectedRealized);

          // Insert open trades
          for (const ot of openTrades) {
            await insertOpenTrade({
              direction: ot.direction,
              strategy: 'STOCK',
              entryPrice: ot.entry,
              quantity: ot.quantity,
            });
          }

          const timestamps = spacedTimestamps(T0, new Date(T0.getTime() + 30 * MS_PER_DAY), 4);
          const priceFn = linearPrice(100, endPrice, timestamps[0], timestamps[timestamps.length - 1]);
          const md = makeTimeAwareStub({ underlyings: { SPY: priceFn } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint', startingEquity);

          for (const t of timestamps) {
            clock.advance(t);
            const bal = await broker.getAccountBalance();

            // Core identity: equity = cash + unrealized
            expect(bal.equity).toBeCloseTo(bal.cashBalance + bal.unrealizedPnl, 1);

            // Cash = startingEquity + realized (realized doesn't change over time)
            expect(bal.cashBalance).toBeCloseTo(startingEquity + bal.realizedPnl, 1);
            expect(bal.realizedPnl).toBeCloseTo(expectedRealized, 1);

            // Equity = startingEquity + realized + unrealized
            expect(bal.equity).toBeCloseTo(startingEquity + bal.realizedPnl + bal.unrealizedPnl, 1);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  test('mixed portfolio with options: equity identity at each timestamp', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEquity,
        arbEntryPrice,
        arbEntryPrice,
        fc.double({ min: 100, max: 400, noNaN: true, noDefaultInfinity: true }),
        arbQuantity,
        async (startingEquity, closedEntry, closedExit, underlyingPrice, quantity) => {
          await resetDb();

          // One closed stock trade
          const closedPnl = computeTradePnl({
            entryPrice: closedEntry,
            exitPrice: closedExit,
            direction: 'LONG',
            strategy: 'STOCK',
            quantity,
          });
          await insertClosedTrade({
            direction: 'LONG',
            strategy: 'STOCK',
            entryPrice: closedEntry,
            exitPrice: closedExit,
            quantity,
            pnl: closedPnl,
          });

          // One open option trade
          const strike = 250;
          await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'CALL',
            entryPrice: 5,
            quantity,
            legs: [{ strike, expiry: EXPIRY, type: 'CALL', action: 'BUY', quantity }],
          });

          const timestamps = spacedTimestamps(T0, new Date(T0.getTime() + 60 * MS_PER_DAY), 4);
          const md = makeTimeAwareStub({ underlyings: { SPY: constantPrice(underlyingPrice) } });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint', startingEquity);

          for (const t of timestamps) {
            clock.advance(t);
            const bal = await broker.getAccountBalance();

            // Core identities
            expect(bal.equity).toBeCloseTo(bal.cashBalance + bal.unrealizedPnl, 1);
            expect(bal.cashBalance).toBeCloseTo(startingEquity + bal.realizedPnl, 1);
            expect(bal.realizedPnl).toBeCloseTo(closedPnl, 1);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── 10. Time value computation matches expected model ─────────────────

describe('temporal: time value model', () => {
  test('option mark = intrinsic + baseTV * sqrt(DTE/365) at any timestamp', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 100, max: 400, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.5, max: 5, noNaN: true, noDefaultInfinity: true }),
        async (underlyingPrice, baseTV) => {
          await resetDb();
          const strike = 250;
          const tradeId = await insertOpenOptionTrade({
            direction: 'LONG',
            strategy: 'CALL',
            entryPrice: 5,
            quantity: 1,
            legs: [{ strike, expiry: EXPIRY, type: 'CALL', action: 'BUY', quantity: 1 }],
          });

          const timestamps = spacedTimestamps(T0, new Date(EXPIRY_DATE.getTime() - 5 * MS_PER_DAY), 5);
          // Use zero spread so abs() normalization doesn't distort near-zero mid values
          const md = makeTimeAwareStub({
            underlyings: { SPY: constantPrice(underlyingPrice) },
            baseTimeValue: baseTV,
            optionHalfSpread: 0,
          });
          const clock = new SimClock(T0);
          const broker = new SimBroker(md, clock, RUN_ID, 'midpoint');

          const intrinsic = Math.max(0, underlyingPrice - strike);

          for (const t of timestamps) {
            clock.advance(t);
            const marks = await broker.markToMarket();
            const mark = marks.get(tradeId)!;
            const tv = expectedTimeValue(baseTV, t, EXPIRY_DATE);
            expect(mark).toBeCloseTo(intrinsic + tv, 2);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
