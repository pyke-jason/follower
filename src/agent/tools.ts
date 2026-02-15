import * as broker from '../broker/tradestation.js';
import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { getTodayStartingBalance } from '../reconciliation/daily-balance.js';
import { getTrader } from '../config/traders.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import {
  GetQuoteInput,
  GetOptionsChainInput,
  GetOpenPositionsInput,
  CheckRiskLimitsInput,
  PlaceOrderInput,
  CalculatePositionSizeInput,
  FlagForReviewInput,
} from './schemas.js';

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
      const { symbol } = GetQuoteInput.parse(input);
      return await broker.getQuote(symbol);
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
      const { symbol, expiry, optionType } = GetOptionsChainInput.parse(input);
      return await broker.getOptionsChain(symbol, expiry, optionType);
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
      const parsed = GetOpenPositionsInput.parse(input);
      const conditions = [eq(schema.trades.status, 'OPEN')];
      if (parsed.symbol) conditions.push(eq(schema.trades.symbol, parsed.symbol));
      if (parsed.trader) conditions.push(eq(schema.trades.trader, parsed.trader));

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
      const { trader, symbol } = CheckRiskLimitsInput.parse(input);

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

      const maxAllocRaw = traderConfig[0]?.maxAllocation
        ? parseFloat(traderConfig[0].maxAllocation)
        : null;
      if (maxAllocRaw != null && !Number.isFinite(maxAllocRaw)) {
        throw new Error(`[RiskCheck] Non-numeric maxAllocation for trader "${trader}": ${traderConfig[0]?.maxAllocation}`);
      }
      const maxAlloc = maxAllocRaw;

      const maxDailyAllocRaw = traderConfig[0]?.maxDailyAlloc
        ? parseFloat(traderConfig[0].maxDailyAlloc)
        : null;
      if (maxDailyAllocRaw != null && !Number.isFinite(maxDailyAllocRaw)) {
        throw new Error(`[RiskCheck] Non-numeric maxDailyAlloc for trader "${trader}": ${traderConfig[0]?.maxDailyAlloc}`);
      }
      const maxDailyAlloc = maxDailyAllocRaw;

      const dailyPnl = parseFloat(todayPnl[0]?.total ?? '0');
      if (!Number.isFinite(dailyPnl)) {
        throw new Error(`[RiskCheck] Non-numeric dailyPnl for trader "${trader}": ${todayPnl[0]?.total}`);
      }

      // Drawdown check using starting balance
      const startingBalance = await getTodayStartingBalance();
      let currentDrawdownPct: number | undefined;
      let drawdownBlocked = false;
      if (startingBalance && startingBalance.equity > 0) {
        currentDrawdownPct = Math.round((Math.abs(dailyPnl) / startingBalance.equity) * 10000) / 100;
        const maxDrawdownPct = 5; // 5% default, configurable per-trader later
        if (currentDrawdownPct >= maxDrawdownPct) {
          drawdownBlocked = true;
        }
      }

      // Check for unresolved reconciliation alerts (DB_ONLY = dangerous)
      const unresolvedAlerts = await db.select({
        count: sql<number>`COUNT(*)`,
      })
        .from(schema.reconciliationAlerts)
        .where(and(
          eq(schema.reconciliationAlerts.resolved, false),
          eq(schema.reconciliationAlerts.type, 'DB_ONLY'),
        ));
      const alertCount = unresolvedAlerts[0]?.count ?? 0;

      const allowed = (
        (!maxDailyAlloc || Math.abs(dailyPnl) < maxDailyAlloc) &&
        (openPositions[0]?.count ?? 0) < 5 &&
        !drawdownBlocked &&
        alertCount === 0
      );

      const reason = drawdownBlocked
        ? `Drawdown limit exceeded (${currentDrawdownPct}%)`
        : alertCount > 0
          ? `${alertCount} unresolved DB_ONLY reconciliation alert(s)`
          : undefined;

      return {
        allowed,
        reason,
        traderDailyPnl: dailyPnl,
        openPositionsOnSymbol: openPositions[0]?.count ?? 0,
        traderMaxAllocation: maxAlloc,
        traderMaxDailyAllocation: maxDailyAlloc,
        startingEquity: startingBalance?.equity,
        currentDrawdownPct,
        buyingPower: startingBalance?.buyingPower,
        reconciliationAlerts: alertCount,
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
      const parsed = PlaceOrderInput.parse(input);
      return await broker.placeOrder({
        symbol: parsed.symbol,
        strategy: parsed.strategy,
        direction: parsed.direction,
        legs: parsed.legs,
        orderType: parsed.orderType,
        limitPrice: parsed.limitPrice,
      });
    },
  },
  {
    name: 'calculate_position_size',
    description: 'Calculate position size based on account equity, ATR volatility, and risk limits.',
    input_schema: {
      type: 'object',
      properties: {
        trader: { type: 'string' },
        symbol: { type: 'string' },
        entryPrice: { type: 'number' },
        strategy: { type: 'string', description: 'STOCK, CALL, PUT, CDS, PDS' },
        spreadMaxRisk: { type: 'number', description: 'For spreads: width minus credit. Omit for stocks.' },
      },
      required: ['trader', 'symbol', 'entryPrice', 'strategy'],
    },
    execute: async (input) => {
      const parsed = CalculatePositionSizeInput.parse(input);
      const traderConfig = await getTrader(parsed.trader);
      const maxAllocation = traderConfig?.maxAllocation ? parseFloat(traderConfig.maxAllocation) : 5000;

      const sizingConfig = traderConfig?.positionSizingConfig;
      const balance = await broker.getAccountBalance();

      const sizer = buildPositionSizer(sizingConfig, (symbol, barsBack) =>
        broker.getBars({ symbol, interval: '1', barsBack }),
      );

      return await sizer.calculateSize({
        symbol: parsed.symbol,
        entryPrice: parsed.entryPrice,
        equity: balance.equity,
        maxAllocation,
        spreadMaxRisk: parsed.spreadMaxRisk,
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
      const parsed = FlagForReviewInput.parse(input);
      return {
        flagged: true,
        reason: parsed.reason,
        uncertainty: parsed.uncertainty,
      };
    },
  },
];
