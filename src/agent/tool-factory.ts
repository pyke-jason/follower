import type { BrokerService } from '../broker/interface.js';
import type { ToolDef } from './tools.js';
import type { Trade } from '../db/schema.js';
import type { OrderManager } from '../orders/order-manager.js';
import type { PositionSize } from '../position-sizing/index.js';
import {
  GetQuoteInput,
  GetOptionsChainInput,
  GetOpenPositionsInput,
  CheckRiskLimitsInput,
  PlaceOrderInput,
  CalculatePositionSizeInput,
  FlagForReviewInput,
} from './schemas.js';

export type RiskCheckResult = {
  allowed: boolean;
  reason?: string;
  traderDailyPnl: number;
  openPositionsOnSymbol: number;
  traderMaxAllocation: number | null;
  traderMaxDailyAllocation: number | null;
  startingEquity?: number;
  currentDrawdownPct?: number;
  buyingPower?: number;
  reconciliationAlerts?: number;
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
};

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
        required: ['symbol', 'strategy', 'direction', 'legs'],
      },
      execute: async (input) => {
        const parsed = PlaceOrderInput.parse(input);
        const params = {
          symbol: parsed.symbol,
          strategy: parsed.strategy,
          direction: parsed.direction,
          legs: parsed.legs,
          orderType: parsed.orderType,
          limitPrice: parsed.limitPrice,
          adjustmentRules: parsed.adjustmentRules,
          cancelAfterSec: parsed.cancelAfterSec,
        };

        if (deps.orderManager) {
          return await deps.orderManager.submitOrder(params);
        }
        // Fallback: direct broker call (no adjustment rules support)
        const { adjustmentRules, cancelAfterSec, ...orderParams } = params;
        return await deps.broker.placeOrder(orderParams);
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
