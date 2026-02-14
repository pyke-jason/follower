import type { BrokerService } from '../broker/interface.js';
import type { ToolDef } from './tools.js';
import type { Trade } from '../db/schema.js';
import type { OrderManager } from '../orders/order-manager.js';

export type ToolDependencies = {
  broker: BrokerService;
  orderManager?: OrderManager;
  getOpenPositions: (filters: { symbol?: string; trader?: string }) => Promise<Trade[]>;
  checkRiskLimits: (input: {
    symbol: string;
    strategy: string;
    trader: string;
    maxRisk?: number;
  }) => Promise<{
    allowed: boolean;
    traderDailyPnl: number;
    openPositionsOnSymbol: number;
    traderMaxAllocation: number | null;
    traderMaxDailyAllocation: number | null;
  }>;
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
        return await deps.broker.getQuote(input.symbol as string);
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
        return await deps.broker.getOptionsChain(
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
        return await deps.getOpenPositions({
          symbol: input.symbol as string | undefined,
          trader: input.trader as string | undefined,
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
        return await deps.checkRiskLimits({
          symbol: input.symbol as string,
          strategy: input.strategy as string,
          trader: input.trader as string,
          maxRisk: input.maxRisk as number | undefined,
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
        const params = {
          symbol: input.symbol as string,
          strategy: input.strategy as string,
          direction: input.direction as 'LONG' | 'SHORT',
          legs: input.legs as any[],
          orderType: (input.orderType as 'MARKET' | 'LIMIT') || 'LIMIT',
          limitPrice: input.limitPrice as number | undefined,
          adjustmentRules: input.adjustmentRules as any[] | undefined,
          cancelAfterSec: input.cancelAfterSec as number | undefined,
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
}
