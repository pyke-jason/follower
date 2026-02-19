/**
 * Property-based tests for SimBroker's DB-touching methods.
 *
 * Uses an in-memory SQLite database (same engine as production) so we get
 * real SQL execution without touching disk or needing a repository pattern.
 */

import { describe, test, expect, vi, beforeAll } from 'vitest';
import fc from 'fast-check';
import { sql } from 'drizzle-orm';

// Mock db/client with a real in-memory SQLite + drizzle instance.
// vi.mock is hoisted, so the factory runs before any other imports.
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
import type { Quote, OptionsChain, Bar } from '../broker/types.js';
import type { BacktestPriceProvider } from './market-data.js';
import type { QuoteTick } from './databento-tape.js';

// ── DB setup ─────────────────────────────────────────────────────────

const CREATE_TRADES = sql`
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    source_message_id TEXT,
    trader TEXT NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    strategy TEXT NOT NULL,
    legs TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'OPEN',
    entry_price TEXT,
    exit_price TEXT,
    quantity INTEGER DEFAULT 1,
    pnl TEXT,
    opened_at TEXT,
    closed_at TEXT,
    close_message_id TEXT,
    is_backtest INTEGER DEFAULT 0,
    backtest_run_id TEXT,
    metadata TEXT DEFAULT '{}',
    parent_trade_id TEXT,
    exit_percent REAL,
    avg_entry_price TEXT,
    broker_fill_price TEXT,
    broker_fill_qty INTEGER,
    broker_commission TEXT,
    broker_fill_time TEXT,
    broker_leg_fills TEXT
  )
`;

beforeAll(async () => {
  await db.run(CREATE_TRADES);
});

/** Clear all trade rows — called at the start of each fc iteration. */
async function resetDb() {
  await db.run(sql`DELETE FROM trades`);
}

// ── Helpers ──────────────────────────────────────────────────────────

const RUN_ID = 'test-run';

async function insertOpenTrade(params: {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  entryPrice: number;
  quantity: number;
  legs?: unknown[];
}) {
  const id = crypto.randomUUID();
  await db.insert(schema.trades).values({
    id,
    trader: 'test-trader',
    symbol: params.symbol,
    direction: params.direction,
    strategy: params.strategy,
    legs: params.legs ?? [
      { symbol: params.symbol, strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: params.quantity },
    ],
    status: 'OPEN',
    entryPrice: String(params.entryPrice),
    quantity: params.quantity,
    isBacktest: true,
    backtestRunId: RUN_ID,
    openedAt: new Date().toISOString(),
  });
  return id;
}

async function insertClosedTrade(params: {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
}) {
  const id = crypto.randomUUID();
  await db.insert(schema.trades).values({
    id,
    trader: 'test-trader',
    symbol: params.symbol,
    direction: params.direction,
    strategy: params.strategy,
    legs: [
      { symbol: params.symbol, strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: params.quantity },
    ],
    status: 'CLOSED',
    entryPrice: String(params.entryPrice),
    exitPrice: String(params.exitPrice),
    quantity: params.quantity,
    pnl: String(params.pnl),
    isBacktest: true,
    backtestRunId: RUN_ID,
    openedAt: new Date().toISOString(),
    closedAt: new Date().toISOString(),
  });
  return id;
}

function stubMarketData(markPrice: number): BacktestPriceProvider {
  const quote: Quote = {
    symbol: 'SPY',
    bid: markPrice - 0.05,
    ask: markPrice + 0.05,
    last: markPrice,
    volume: 1000,
    timestamp: new Date().toISOString(),
  };
  return {
    getQuote: async () => quote,
    getOptionsChain: async () => ({ symbol: 'SPY', expiry: '2026-03-20', optionType: 'CALL', strikes: [] }) as OptionsChain,
    getBars: async () => [] as Bar[],
    getPriceSnapshot: () => ({}),
    getTicksInRange: async () => [] as QuoteTick[],
    prefetch: async () => {},
  };
}

function makeBroker(markPrice: number, startingEquity = 100_000) {
  return new SimBroker(stubMarketData(markPrice), new SimClock(), RUN_ID, 'midpoint', startingEquity);
}

// ── Arbitraries ──────────────────────────────────────────────────────

const arbDirection: fc.Arbitrary<'LONG' | 'SHORT'> = fc.constantFrom('LONG', 'SHORT');
const arbEntryPrice = fc.double({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true });
const arbMarkPrice = fc.double({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true });
const arbQuantity = fc.integer({ min: 1, max: 50 });
const arbEquity = fc.double({ min: 10_000, max: 1_000_000, noNaN: true, noDefaultInfinity: true });

// ── 1. getAccountBalance identity ────────────────────────────────────

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
          await insertClosedTrade({ symbol: 'SPY', direction, strategy: 'STOCK', entryPrice: entry, exitPrice: exit, quantity, pnl });

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
        await insertOpenTrade({ symbol: 'SPY', direction, strategy: 'STOCK', entryPrice: entry, quantity });

        const broker = makeBroker(mark);
        const bal = await broker.getAccountBalance();
        expect(bal.equity).toBeCloseTo(bal.cashBalance + bal.unrealizedPnl, 1);
      }),
      { numRuns: 200 },
    );
  });
});

// ── 2. closePositionAtPrice ──────────────────────────────────────────

describe('closePositionAtPrice invariants', () => {
  test('PnL matches computeTradePnl exactly', async () => {
    await fc.assert(
      fc.asyncProperty(arbEntryPrice, arbMarkPrice, arbDirection, arbQuantity, async (entry, exit, direction, quantity) => {
        await resetDb();
        const tradeId = await insertOpenTrade({ symbol: 'SPY', direction, strategy: 'STOCK', entryPrice: entry, quantity });

        const broker = makeBroker(exit);
        const { pnl } = await broker.closePositionAtPrice(tradeId, exit, new Date().toISOString());

        const expected = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy: 'STOCK', quantity });
        expect(pnl).toBeCloseTo(expected, 2);
      }),
      { numRuns: 300 },
    );
  });

  test('closed trade has status CLOSED in DB', async () => {
    await fc.assert(
      fc.asyncProperty(arbEntryPrice, arbMarkPrice, arbDirection, async (entry, exit, direction) => {
        await resetDb();
        const tradeId = await insertOpenTrade({ symbol: 'SPY', direction, strategy: 'STOCK', entryPrice: entry, quantity: 1 });

        const broker = makeBroker(exit);
        await broker.closePositionAtPrice(tradeId, exit, new Date().toISOString());

        const [row] = await db.select().from(schema.trades).where(sql`id = ${tradeId}`);
        expect(row.status).toBe('CLOSED');
        expect(row.exitPrice).toBe(String(exit));
      }),
      { numRuns: 200 },
    );
  });
});

// ── 3. getOpenPositionCount ──────────────────────────────────────────

describe('getOpenPositionCount invariants', () => {
  test('count matches number of inserted open trades', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 10 }), async (n) => {
        await resetDb();
        for (let i = 0; i < n; i++) {
          await insertOpenTrade({ symbol: 'SPY', direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
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
            await insertOpenTrade({ symbol: 'SPY', direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
          }
          for (let i = 0; i < closedCount; i++) {
            await insertClosedTrade({
              symbol: 'SPY',
              direction: 'LONG',
              strategy: 'STOCK',
              entryPrice: 100,
              exitPrice: 105,
              quantity: 1,
              pnl: 5,
            });
          }
          const broker = makeBroker(100);
          const count = await broker.getOpenPositionCount();
          expect(count).toBe(openCount);
        },
      ),
      { numRuns: 50 },
    );
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
            await insertOpenTrade({ symbol: 'SPY', direction: 'LONG', strategy: 'STOCK', entryPrice: 100, quantity: 1 });
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
            await insertOpenTrade({ symbol: 'SPY', direction: t.direction, strategy: 'STOCK', entryPrice: t.entry, quantity: t.quantity });
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
});
