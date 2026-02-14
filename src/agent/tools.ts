import * as broker from '../broker/tradestation.js';
import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

export const tools: ToolDef[] = [
  {
    name: 'get_quote',
    description: 'Get current bid/ask/last for a stock or ETF.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol' },
      },
      required: ['symbol'],
    },
    execute: async (input) => {
      return await broker.getQuote(input.symbol as string);
    },
  },
  {
    name: 'get_options_chain',
    description: 'Get options chain filtered by expiry and type. Returns strikes, bid/ask, IV, greeks.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Underlying ticker' },
        expiry: { type: 'string', description: 'ISO date, e.g. 2025-11-28' },
        optionType: { type: 'string', enum: ['CALL', 'PUT'] },
      },
      required: ['symbol', 'expiry', 'optionType'],
    },
    execute: async (input) => {
      return await broker.getOptionsChain(
        input.symbol as string,
        input.expiry as string,
        input.optionType as 'CALL' | 'PUT',
      );
    },
  },
  {
    name: 'get_open_positions',
    description: 'Get all currently open trade positions, optionally filtered by symbol or trader.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Filter by symbol' },
        trader: { type: 'string', description: 'Filter by trader name' },
      },
    },
    execute: async (input) => {
      const conditions = [eq(schema.trades.status, 'OPEN')];
      if (input.symbol) conditions.push(eq(schema.trades.symbol, input.symbol as string));
      if (input.trader) conditions.push(eq(schema.trades.trader, input.trader as string));

      return await db.select().from(schema.trades).where(and(...conditions));
    },
  },
  {
    name: 'check_risk_limits',
    description: 'Check if a proposed trade would exceed risk limits (daily loss, position size, exposure).',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        maxRisk: { type: 'number', description: 'Max dollar risk for this trade' },
        strategy: { type: 'string' },
        trader: { type: 'string' },
      },
      required: ['symbol', 'strategy', 'trader'],
    },
    execute: async (input) => {
      const trader = input.trader as string;
      const symbol = input.symbol as string;

      const traderConfig = await db.select()
        .from(schema.trackedTraders)
        .where(eq(schema.trackedTraders.name, trader));

      const todayPnl = await db.select({
        total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
      })
        .from(schema.trades)
        .where(and(
          eq(schema.trades.trader, trader),
          sql`opened_at >= date('now')`,
        ));

      const openPositions = await db.select({
        count: sql<number>`COUNT(*)`,
      })
        .from(schema.trades)
        .where(and(
          eq(schema.trades.symbol, symbol),
          eq(schema.trades.status, 'OPEN'),
        ));

      const maxAlloc = traderConfig[0]?.maxAllocation
        ? parseFloat(traderConfig[0].maxAllocation)
        : null;
      const maxDailyAlloc = traderConfig[0]?.maxDailyAlloc
        ? parseFloat(traderConfig[0].maxDailyAlloc)
        : null;
      const dailyPnl = parseFloat(todayPnl[0]?.total ?? '0');

      const allowed = (
        (!maxDailyAlloc || Math.abs(dailyPnl) < maxDailyAlloc) &&
        (openPositions[0]?.count ?? 0) < 5  // max 5 open positions per symbol
      );

      return {
        allowed,
        traderDailyPnl: dailyPnl,
        openPositionsOnSymbol: openPositions[0]?.count ?? 0,
        traderMaxAllocation: maxAlloc,
        traderMaxDailyAllocation: maxDailyAlloc,
      };
    },
  },
  {
    name: 'place_order',
    description: 'Place a trade order. Supports stocks, single-leg options, and multi-leg spreads (CDS/PDS).',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        strategy: { type: 'string', description: 'CDS, PDS, CALL, PUT, STOCK' },
        direction: { type: 'string', enum: ['LONG', 'SHORT'] },
        legs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              strike: { type: 'number' },
              expiry: { type: 'string' },
              type: { type: 'string', enum: ['CALL', 'PUT', 'STOCK'] },
              action: { type: 'string', enum: ['BUY', 'SELL'] },
              quantity: { type: 'number' },
            },
            required: ['strike', 'expiry', 'type', 'action', 'quantity'],
          },
        },
        orderType: { type: 'string', enum: ['MARKET', 'LIMIT'], default: 'LIMIT' },
        limitPrice: { type: 'number' },
      },
      required: ['symbol', 'strategy', 'direction', 'legs'],
    },
    execute: async (input) => {
      return await broker.placeOrder({
        symbol: input.symbol as string,
        strategy: input.strategy as string,
        direction: input.direction as 'LONG' | 'SHORT',
        legs: input.legs as any[],
        orderType: (input.orderType as 'MARKET' | 'LIMIT') || 'LIMIT',
        limitPrice: input.limitPrice as number | undefined,
      });
    },
  },
  {
    name: 'flag_for_review',
    description: 'Flag this message for manual human review. Use when uncertain about the trade.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why this needs human review' },
        uncertainty: { type: 'string', description: 'What specifically is unclear' },
      },
      required: ['reason'],
    },
    execute: async (input) => {
      return {
        flagged: true,
        reason: input.reason,
        uncertainty: input.uncertainty,
      };
    },
  },
];
