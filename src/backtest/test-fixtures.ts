/**
 * Shared test fixtures: arbitraries, market-data stubs, DB DDL, and helpers.
 *
 * Any test that needs Postgres-backed tables or domain arbitraries should
 * import from here rather than maintaining its own copies.
 */

import fc from 'fast-check';
import { sql } from 'drizzle-orm';
import { btChannel } from '../lib/channel.js';
import { parseOccSymbol } from '../lib/occ-symbology.js';
import type { Direction, LegAction } from '../lib/enums.js';
import type { Quote, OrderParams } from '../broker/types.js';
import type { BacktestPriceProvider } from './market-data.js';
import type { QuoteTick } from './databento-tape.js';
import type { FillModel } from './types.js';

// ── Arbitraries ──────────────────────────────────────────────────────

export const arbFillModel: fc.Arbitrary<FillModel> = fc.constantFrom('orats', 'midpoint', 'natural');

/** Bid/ask pair where bid <= ask and both > 0. */
export const arbSpread = fc
  .record({
    bid: fc.double({ min: 0.01, max: 500, noNaN: true, noDefaultInfinity: true }),
    ask: fc.double({ min: 0.01, max: 500, noNaN: true, noDefaultInfinity: true }),
  })
  .filter((q) => q.ask >= q.bid);

export const arbIsBuy = fc.boolean();
export const arbLegCount = fc.integer({ min: 1, max: 4 });
export const arbDirection: fc.Arbitrary<Direction> = fc.constantFrom('LONG', 'SHORT');
export const arbStrategy = fc.constantFrom('STOCK', 'CALL_SPREAD', 'PUT_SPREAD', 'IRON_CONDOR');
export const arbQuantity = fc.integer({ min: 1, max: 50 });
export const arbPrice = fc.double({ min: 0.01, max: 5000, noNaN: true, noDefaultInfinity: true });
export const arbEntryPrice = fc.double({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true });
export const arbMarkPrice = fc.double({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true });
export const arbEquity = fc.double({ min: 10_000, max: 1_000_000, noNaN: true, noDefaultInfinity: true });

// ── Quote / order helpers ────────────────────────────────────────────

export function makeQuote(bid: number, ask: number, symbol = 'SPY'): Quote {
  return { symbol, bid, ask, last: (bid + ask) / 2, volume: 1000, timestamp: new Date().toISOString() };
}

export function makeStockBuyOrder(overrides: Partial<OrderParams> = {}): OrderParams {
  const sym = overrides.symbol ?? 'SPY';
  return {
    symbol: sym,
    strategy: 'STOCK',
    direction: 'LONG',
    legs: [{ symbol: sym, strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: 1 }],
    orderType: 'MARKET',
    isClosing: false,
    ...overrides,
  };
}

export function makeStockSellOrder(overrides: Partial<OrderParams> = {}): OrderParams {
  const sym = overrides.symbol ?? 'SPY';
  return {
    symbol: sym,
    strategy: 'STOCK',
    direction: 'SHORT',
    legs: [{ symbol: sym, strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'SELL', quantity: 1 }],
    orderType: 'MARKET',
    isClosing: false,
    ...overrides,
  };
}

// ── Market data stubs ────────────────────────────────────────────────

/** Minimal stub that returns a fixed quote for every symbol. */
export function stubMarketDataFromQuote(quote: Quote): BacktestPriceProvider {
  return {
    getQuote: async () => quote,
    getPriceSnapshot: () => ({}),
    getTicksInRange: async () => [] as QuoteTick[],
    prefetch: async () => {},
  };
}

/**
 * Static per-symbol stub. For equity symbols, looks up the price directly.
 * For OCC option symbols, parses the OCC format and synthesises a quote
 * from intrinsic value + a constant $0.50 time premium.
 */
export function stubMarketData(prices: Record<string, number> | number): BacktestPriceProvider {
  const priceMap = typeof prices === 'number' ? { SPY: prices } : prices;

  function makeOptionQuote(symbol: string, underlyingPrice: number): Quote {
    const occ = parseOccSymbol(symbol);
    if (!occ) throw new Error(`Invalid OCC symbol: ${symbol}`);
    const intrinsic = occ.type === 'CALL'
      ? Math.max(0, underlyingPrice - occ.strike)
      : Math.max(0, occ.strike - underlyingPrice);
    const mid = intrinsic + 0.50;
    return { symbol, bid: mid - 0.10, ask: mid + 0.10, last: mid, volume: 100, timestamp: new Date().toISOString() };
  }

  return {
    getQuote: async (symbol: string) => {
      const p = priceMap[symbol];
      if (p != null) {
        return { symbol, bid: p - 0.05, ask: p + 0.05, last: p, volume: 1000, timestamp: new Date().toISOString() };
      }
      const occ = parseOccSymbol(symbol);
      if (occ) {
        const underlying = priceMap[occ.underlying];
        if (underlying != null) return makeOptionQuote(symbol, underlying);
      }
      throw new Error(`No quote for ${symbol}`);
    },
    getPriceSnapshot: () => ({}),
    getTicksInRange: async () => [] as QuoteTick[],
    prefetch: async () => {},
  };
}

// ── Time-aware market data stub ──────────────────────────────────────

/** A function that returns a price for a given timestamp. */
export type PriceFn = (at: Date) => number;

type TimeAwareStubConfig = {
  /** Map from underlying symbol to a time-varying price function. */
  underlyings: Record<string, PriceFn>;
  /** Base time value for options in dollars (default: 2.00). */
  baseTimeValue?: number;
  /** Equity bid-ask half-spread (default: 0.05). */
  equityHalfSpread?: number;
  /** Option bid-ask half-spread (default: 0.10). */
  optionHalfSpread?: number;
  /** Number of evenly-spaced ticks to emit from getTicksInRange (default: 0 = empty). */
  ticksPerRange?: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Time-aware market data stub.
 *
 * Underlying prices come from caller-supplied PriceFn callbacks.
 * Option prices are derived as: intrinsic + baseTimeValue * sqrt(daysToExpiry / 365).
 * At expiry the time-value term vanishes, leaving pure intrinsic.
 */
export function makeTimeAwareStub(config: TimeAwareStubConfig): BacktestPriceProvider {
  const baseTV = config.baseTimeValue ?? 2.0;
  const eqHS = config.equityHalfSpread ?? 0.05;
  const opHS = config.optionHalfSpread ?? 0.10;

  return {
    getQuote: async (symbol: string, at?: Date) => {
      const t = at ?? new Date();

      // Direct equity lookup
      const priceFn = config.underlyings[symbol];
      if (priceFn) {
        const p = priceFn(t);
        return { symbol, bid: p - eqHS, ask: p + eqHS, last: p, volume: 1000, timestamp: t.toISOString() };
      }

      // OCC option symbol — derive from underlying
      const occ = parseOccSymbol(symbol);
      if (occ) {
        const underlyingFn = config.underlyings[occ.underlying];
        if (underlyingFn) {
          const underlyingPrice = underlyingFn(t);
          const intrinsic = occ.type === 'CALL'
            ? Math.max(0, underlyingPrice - occ.strike)
            : Math.max(0, occ.strike - underlyingPrice);
          const msToExpiry = Math.max(0, occ.expiration.getTime() - t.getTime());
          const daysToExpiry = msToExpiry / MS_PER_DAY;
          const timeValue = baseTV * Math.sqrt(daysToExpiry / 365);
          const mid = intrinsic + timeValue;
          return { symbol, bid: mid - opHS, ask: mid + opHS, last: mid, volume: 100, timestamp: t.toISOString() };
        }
      }

      throw new Error(`No quote for ${symbol}`);
    },
    getPriceSnapshot: () => ({}),
    getTicksInRange: async (symbol: string, from: Date, to: Date) => {
      const n = config.ticksPerRange ?? 0;
      if (n === 0) return [] as QuoteTick[];

      // Direct underlying lookup
      let priceFn = config.underlyings[symbol];
      let hs = eqHS;

      // OCC symbols: derive timestamps from the underlying's price function.
      // advanceTo only uses OCC tick timestamps (actual prices come from
      // getOptionSpreadQuote), so the tick bid/ask values don't matter.
      if (!priceFn) {
        const occ = parseOccSymbol(symbol);
        if (occ) {
          priceFn = config.underlyings[occ.underlying];
          hs = opHS;
        }
      }

      if (!priceFn) return [] as QuoteTick[];
      const fromMs = from.getTime();
      const toMs = to.getTime();
      const step = n <= 1 ? 0 : (toMs - fromMs) / (n - 1);
      const ticks: QuoteTick[] = [];
      for (let i = 0; i < n; i++) {
        const t = new Date(fromMs + Math.round(step * i));
        const p = priceFn(t);
        ticks.push({ symbol, bid: p - hs, ask: p + hs, timestamp: t });
      }
      return ticks;
    },
    prefetch: async () => {},
  };
}

// ── Price path helpers ───────────────────────────────────────────────

/** Constant price regardless of time. */
export function constantPrice(price: number): PriceFn {
  return () => price;
}

/** V-shaped dip: starts at startPrice, dips to dipPrice at midpoint, recovers to startPrice. */
export function vShapedPrice(
  startPrice: number,
  dipPrice: number,
  startTime: Date,
  endTime: Date,
): PriceFn {
  const startMs = startTime.getTime();
  const midMs = (startTime.getTime() + endTime.getTime()) / 2;
  const endMs = endTime.getTime();
  return (at: Date) => {
    const ms = at.getTime();
    if (ms <= midMs) {
      // First half: drop from startPrice to dipPrice
      const t = (ms - startMs) / (midMs - startMs);
      return startPrice + (dipPrice - startPrice) * t;
    }
    // Second half: recover from dipPrice to startPrice
    const t = (ms - midMs) / (endMs - midMs);
    return dipPrice + (startPrice - dipPrice) * t;
  };
}

/** Linear interpolation from startPrice at startTime to endPrice at endTime. */
export function linearPrice(
  startPrice: number,
  endPrice: number,
  startTime: Date,
  endTime: Date,
): PriceFn {
  const startMs = startTime.getTime();
  const rangeMs = endTime.getTime() - startMs;
  return (at: Date) => {
    if (rangeMs === 0) return startPrice;
    const t = Math.max(0, Math.min(1, (at.getTime() - startMs) / rangeMs));
    return startPrice + (endPrice - startPrice) * t;
  };
}

// ── DB helpers (parameterised on db/schema from vi.mock) ─────────────

/** SQL to create the trades table for isolated Postgres test schemas. */
export const CREATE_TRADES_SQL = sql`
  CREATE TABLE IF NOT EXISTS trades (
    id text PRIMARY KEY,
    task_id text,
    source_message_id text,
    trader text NOT NULL,
    symbol text NOT NULL,
    direction text NOT NULL,
    strategy text NOT NULL,
    legs jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL DEFAULT 'OPEN',
    entry_price text,
    exit_price text,
    quantity integer DEFAULT 1,
    pnl text,
    opened_at text,
    closed_at text,
    close_message_id text,
    channel_id text NOT NULL DEFAULT 'ibkr:live:12345',
    metadata jsonb DEFAULT '{}'::jsonb,
    avg_entry_price text,
    realized_pnl text,
    broker_fill_price text,
    broker_fill_qty integer,
    broker_commission text,
    broker_fill_time text,
    broker_leg_fills jsonb
  )
`;

/** SQL to create the trade_events table (append-only action log used by recordTrade). */
export const CREATE_TRADE_EVENTS_SQL = sql`
  CREATE TABLE IF NOT EXISTS trade_events (
    id text PRIMARY KEY,
    trade_id text NOT NULL,
    action text NOT NULL,
    price text,
    quantity integer,
    legs jsonb DEFAULT '[]'::jsonb,
    strategy text,
    direction text,
    message_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    timestamp text NOT NULL,
    created_at text
  )
`;

/** SQL to create the messages table for isolated Postgres test schemas. */
export const CREATE_MESSAGES_SQL = sql`
  CREATE TABLE IF NOT EXISTS messages (
    id text PRIMARY KEY,
    author text NOT NULL,
    timestamp text NOT NULL,
    raw_html text NOT NULL,
    clean_text text NOT NULL,
    badges jsonb DEFAULT '[]'::jsonb,
    symbols jsonb DEFAULT '[]'::jsonb,
    action_hint text,
    direction_hint text,
    detected_strategies jsonb DEFAULT '[]'::jsonb,
    is_paper_trade boolean DEFAULT false,
    confidence text,
    ingested_at text,
    content_hash text,
    reactions jsonb DEFAULT '[]'::jsonb
  )
`;

/** SQL to create the tasks table for isolated Postgres test schemas. */
export const CREATE_TASKS_SQL = sql`
  CREATE TABLE IF NOT EXISTS tasks (
    id text PRIMARY KEY,
    message_id text,
    task_type text NOT NULL,
    status text NOT NULL DEFAULT 'PENDING',
    assignee text NOT NULL DEFAULT 'agent',
    priority integer DEFAULT 0,
    context jsonb DEFAULT '{}'::jsonb,
    created_at text,
    started_at text,
    completed_at text,
    error text,
    model_provider text,
    model_name text,
    channel_id text NOT NULL DEFAULT 'test:channel'
  )
`;

/** Unique index on tasks.message_id + channel_id (mirrors schema.ts). */
export const CREATE_TASKS_UNIQUE_IDX = sql`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_message_unique
  ON tasks(message_id, channel_id) WHERE message_id IS NOT NULL
`;

type InsertOpenTradeParams = {
  symbol?: string;
  direction: Direction;
  strategy: string;
  entryPrice: number;
  quantity: number;
  legs?: unknown[];
  trader?: string;
  runId?: string;
  openedAt?: string;
};

type InsertClosedTradeParams = {
  symbol?: string;
  direction: Direction;
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  runId?: string;
};

type InsertOpenOptionTradeParams = {
  symbol?: string;
  direction: Direction;
  strategy: string;
  entryPrice: number;
  quantity: number;
  legs: Array<{
    symbol?: string;
    strike: number;
    expiry: string;
    type: 'CALL' | 'PUT' | 'STOCK';
    action: LegAction;
    quantity: number;
    fillPrice?: number;
  }>;
};

/**
 * Create DB helper functions bound to a specific drizzle db + schema.
 * Each test file calls this after setting up its vi.mock for ../db/client.
 */
export function makeDbHelpers(db: any, schema: any, defaultRunId = 'test-run') {
  return {
    async resetDb() {
      await db.execute(sql`DELETE FROM trade_events`);
      await db.execute(sql`DELETE FROM trades`);
    },

    async insertOpenTrade(params: InsertOpenTradeParams): Promise<string> {
      const id = crypto.randomUUID();
      const symbol = params.symbol ?? 'SPY';
      await db.insert(schema.trades).values({
        id,
        trader: params.trader ?? 'test-trader',
        symbol,
        direction: params.direction,
        strategy: params.strategy,
        legs: params.legs ?? [
          { symbol, strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: params.quantity },
        ],
        status: 'OPEN',
        entryPrice: String(params.entryPrice),
        quantity: params.quantity,
        channelId: btChannel(params.runId ?? defaultRunId),
        openedAt: params.openedAt ?? new Date().toISOString(),
      });
      return id;
    },

    async insertClosedTrade(params: InsertClosedTradeParams): Promise<string> {
      const id = crypto.randomUUID();
      const symbol = params.symbol ?? 'SPY';
      await db.insert(schema.trades).values({
        id,
        trader: 'test-trader',
        symbol,
        direction: params.direction,
        strategy: params.strategy,
        legs: [
          { symbol, strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: params.quantity },
        ],
        status: 'CLOSED',
        entryPrice: String(params.entryPrice),
        exitPrice: String(params.exitPrice),
        quantity: params.quantity,
        pnl: String(params.pnl),
        channelId: btChannel(params.runId ?? defaultRunId),
        openedAt: new Date().toISOString(),
        closedAt: new Date().toISOString(),
      });
      return id;
    },

    async insertOpenOptionTrade(params: InsertOpenOptionTradeParams): Promise<string> {
      const id = crypto.randomUUID();
      const symbol = params.symbol ?? 'SPY';
      await db.insert(schema.trades).values({
        id,
        trader: 'test-trader',
        symbol,
        direction: params.direction,
        strategy: params.strategy,
        legs: params.legs.map(l => ({ ...l, symbol: l.symbol ?? symbol })),
        status: 'OPEN',
        entryPrice: String(params.entryPrice),
        quantity: params.quantity,
        channelId: btChannel(defaultRunId),
        openedAt: new Date().toISOString(),
      });
      return id;
    },
  };
}
