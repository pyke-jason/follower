import type { BrokerService } from '../broker/interface.js';
import type { Trade } from '../db/schema.js';

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};
import type { OrderManager } from '../orders/order-manager.js';
import type { PositionSize } from '../position-sizing/index.js';
import { z } from 'zod';
import {
  GetQuoteInput,
  GetOptionsChainInput,
  GetOpenPositionsInput,
  CheckRiskLimitsInput,
  PlaceStockOrderInput,
  PlaceOptionOrderInput,
  CalculatePositionSizeInput,
  FlagForReviewInput,
} from './schemas.js';

export type RiskCheckResult = {
  allowed: boolean;
  reason?: string;
  traderDailyPnl: number;
  openPositionsOnSymbol: number;
  startingEquity?: number;
  currentDrawdownPct?: number;
  buyingPower?: number;
  reconciliationAlerts?: number;
  totalOpenPositions?: number;
  maxTotalPositions?: number;
};

export type OrderLeg = {
  strike: number;
  expiry: string;
  type: 'CALL' | 'PUT' | 'STOCK';
  action: 'BUY' | 'SELL';
  quantity: number;
};

export type FillInfo = {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  legs: OrderLeg[];
  quantity: number;
  filledPrice: number;
  filledAt: Date;
  orderId: string;
};

export type ToolDependencies = {
  broker: BrokerService;
  orderManager?: OrderManager;
  getOpenPositions: (filters: { symbol?: string; trader?: string }) => Promise<Trade[]>;
  checkRiskLimits: (input: {
    symbol: string;
    strategy: string;
    trader: string;
    maxRisk?: number;
  }) => Promise<RiskCheckResult>;
  calculatePositionSize: (input: {
    trader: string;
    symbol: string;
    entryPrice: number;
    strategy: string;
    spreadMaxRisk?: number;
  }) => Promise<PositionSize>;
  onFill?: (fill: FillInfo) => Promise<{ tradeId: string } | null>;
  onPending?: (orderId: string, fillInfo: FillInfo) => void;
};

/** Parse tool input with human-readable error messages for LLM self-correction. */
function parseToolInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const messages = result.error.issues.map(i =>
    `${i.path.join('.')}: ${i.message}`
  ).join('; ');
  throw new Error(`Invalid input: ${messages}`);
}

/** Infer option strategy from leg structure. */
function inferStrategy(legs: { optionType: 'CALL' | 'PUT'; action: 'BUY' | 'SELL' }[]): string {
  if (legs.length === 1) return legs[0].optionType;
  if (legs.length === 2) {
    const allCalls = legs.every(l => l.optionType === 'CALL');
    const allPuts = legs.every(l => l.optionType === 'PUT');
    const hasBuyAndSell = legs.some(l => l.action === 'BUY') && legs.some(l => l.action === 'SELL');
    if (allCalls && hasBuyAndSell) return 'CDS';
    if (allPuts && hasBuyAndSell) return 'PDS';
  }
  return 'SPREAD';
}

type ExecuteOrderParams = {
  symbol: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  legs: OrderLeg[];
  orderType: 'MARKET' | 'LIMIT';
  limitPrice?: number;
  adjustmentRules?: { type: 'PRICE_CHASE'; stepAmount: number; intervalSec: number; maxSteps?: number }[];
  cancelAfterSec?: number;
};

/** Shared order execution: routes to broker/orderManager, fires onFill/onPending. */
async function executeOrder(deps: ToolDependencies, params: ExecuteOrderParams): Promise<import('../broker/types.js').OrderResult> {
  let result: import('../broker/types.js').OrderResult;
  if (deps.orderManager) {
    result = await deps.orderManager.submitOrder(params);
  } else {
    const { adjustmentRules, cancelAfterSec, ...orderParams } = params;
    result = await deps.broker.placeOrder(orderParams);
  }

  const quantity = params.legs.reduce((max, leg) => Math.max(max, leg.quantity), 0);
  const fillInfo: FillInfo = {
    symbol: params.symbol,
    direction: params.direction,
    strategy: params.strategy,
    legs: params.legs,
    quantity,
    filledPrice: result.filledPrice ?? params.limitPrice ?? 0,
    filledAt: result.fillTimestamp ? new Date(result.fillTimestamp) : new Date(),
    orderId: result.orderId,
  };

  if (result.status === 'FILLED' && deps.onFill) {
    await deps.onFill(fillInfo);
  } else if (result.status === 'OPEN' && deps.onPending) {
    deps.onPending(result.orderId, fillInfo);
  }

  return result;
}

export function createTools(deps: ToolDependencies): ToolDef[] {
  return [
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
        return await deps.broker.getQuote(symbol);
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
        return await deps.broker.getOptionsChain(symbol, expiry, optionType);
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
        return await deps.getOpenPositions({
          symbol: parsed.symbol,
          trader: parsed.trader,
        });
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
        const parsed = CheckRiskLimitsInput.parse(input);
        return await deps.checkRiskLimits({
          symbol: parsed.symbol,
          strategy: parsed.strategy,
          trader: parsed.trader,
          maxRisk: parsed.maxRisk,
        });
      },
    },
    {
      name: 'place_stock_order',
      description: 'Buy or sell shares of a stock or ETF. Do NOT use this for options — use place_option_order instead.',
      input_schema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, SPY, TSLA)' },
          direction: { type: 'string', enum: ['LONG', 'SHORT'], description: 'LONG to buy shares, SHORT to sell short' },
          quantity: { type: 'number', description: 'Number of shares to trade' },
          orderType: { type: 'string', enum: ['MARKET', 'LIMIT'], default: 'LIMIT' },
          limitPrice: { type: 'number', description: 'Limit price per share. Required for LIMIT orders.' },
          adjustmentRules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['PRICE_CHASE'] },
                stepAmount: { type: 'number', description: 'Dollar amount to adjust each step' },
                intervalSec: { type: 'number', description: 'Seconds between adjustments' },
                maxSteps: { type: 'number', description: 'Max adjustments (optional)' },
              },
              required: ['type', 'stepAmount', 'intervalSec'],
            },
          },
          cancelAfterSec: { type: 'number', description: 'Auto-cancel if unfilled after N seconds' },
        },
        required: ['symbol', 'direction', 'quantity'],
      },
      execute: async (input) => {
        const parsed = parseToolInput(PlaceStockOrderInput, input);
        return executeOrder(deps, {
          symbol: parsed.symbol,
          strategy: 'STOCK',
          direction: parsed.direction,
          legs: [{
            strike: 0,
            expiry: '',
            type: 'STOCK' as const,
            action: parsed.direction === 'LONG' ? 'BUY' as const : 'SELL' as const,
            quantity: parsed.quantity,
          }],
          orderType: parsed.orderType,
          limitPrice: parsed.limitPrice,
          adjustmentRules: parsed.adjustmentRules,
          cancelAfterSec: parsed.cancelAfterSec,
        });
      },
    },
    {
      name: 'place_option_order',
      description: 'Place an options trade — single-leg (naked call/put) or multi-leg spread (CDS, PDS). Strategy is inferred from legs. Do NOT use this for stock/ETF share trades — use place_stock_order instead.',
      input_schema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Underlying ticker symbol (e.g. AAPL, not the OCC symbol)' },
          direction: { type: 'string', enum: ['LONG', 'SHORT'], description: 'LONG for debit trades, SHORT for credit trades' },
          legs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                strike: { type: 'number', description: 'Strike price (must be > 0)' },
                expiry: { type: 'string', description: 'Expiration date (YYYY-MM-DD)' },
                optionType: { type: 'string', enum: ['CALL', 'PUT'] },
                action: { type: 'string', enum: ['BUY', 'SELL'] },
                quantity: { type: 'number', description: 'Number of contracts' },
              },
              required: ['strike', 'expiry', 'optionType', 'action', 'quantity'],
            },
          },
          orderType: { type: 'string', enum: ['MARKET', 'LIMIT'], default: 'LIMIT' },
          limitPrice: { type: 'number', description: 'Net debit/credit per contract' },
          adjustmentRules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['PRICE_CHASE'] },
                stepAmount: { type: 'number', description: 'Dollar amount to adjust each step' },
                intervalSec: { type: 'number', description: 'Seconds between adjustments' },
                maxSteps: { type: 'number', description: 'Max adjustments (optional)' },
              },
              required: ['type', 'stepAmount', 'intervalSec'],
            },
          },
          cancelAfterSec: { type: 'number', description: 'Auto-cancel if unfilled after N seconds' },
        },
        required: ['symbol', 'direction', 'legs'],
      },
      execute: async (input) => {
        const parsed = parseToolInput(PlaceOptionOrderInput, input);
        const strategy = inferStrategy(parsed.legs);
        return executeOrder(deps, {
          symbol: parsed.symbol,
          strategy,
          direction: parsed.direction,
          legs: parsed.legs.map(l => ({
            strike: l.strike,
            expiry: l.expiry,
            type: l.optionType as 'CALL' | 'PUT',
            action: l.action,
            quantity: l.quantity,
          })),
          orderType: parsed.orderType,
          limitPrice: parsed.limitPrice,
          adjustmentRules: parsed.adjustmentRules,
          cancelAfterSec: parsed.cancelAfterSec,
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
        return await deps.calculatePositionSize({
          trader: parsed.trader,
          symbol: parsed.symbol,
          entryPrice: parsed.entryPrice,
          strategy: parsed.strategy,
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
}
