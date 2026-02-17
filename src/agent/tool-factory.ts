import type { BrokerService } from '../broker/interface.js';
import type { Trade } from '../db/schema.js';
import {
  GetQuoteInput,
  GetOptionsChainInput,
  GetOpenPositionsInput,
  FlagForReviewInput,
  SubmitDecisionInput,
} from './schemas.js';

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
};

// ─── Individual tool builders ────────────────────────────────────────

export function getQuoteTool(broker: BrokerService): ToolDef {
  return {
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
  };
}

export function getOptionsChainTool(broker: BrokerService): ToolDef {
  return {
    name: 'get_options_chain',
    description: 'Get options chain filtered by expiry and type. Returns strikes with bid/ask. IV and greeks may not be available for historical data.',
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
  };
}

export function flagForReviewTool(): ToolDef {
  return {
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
  };
}

export function submitDecisionTool(): ToolDef {
  return {
    name: 'submit_decision',
    description: 'Submit your final trade classification decision. Call this exactly once after analysis.',
    input_schema: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['EXECUTE', 'SKIP', 'MANUAL_REVIEW'] },
        reasoning: { type: 'string', description: 'Why you made this decision' },
        signals: {
          type: 'array',
          description: 'Trade signals (required for EXECUTE)',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['OPEN', 'CLOSE', 'ADD', 'TRIM'] },
              symbol: { type: 'string' },
              direction: { type: 'string', enum: ['LONG', 'SHORT'] },
              strategy: { type: 'string', enum: ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS'] },
              limitPrice: { type: 'number' },
              exitPercent: { type: 'number', description: '0.0-1.0 for TRIM' },
              legs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    strike: { type: 'number' },
                    expiry: { type: 'string' },
                    optionType: { type: 'string', enum: ['CALL', 'PUT'] },
                    action: { type: 'string', enum: ['BUY', 'SELL'] },
                  },
                  required: ['strike', 'expiry', 'optionType', 'action'],
                },
              },
            },
            required: ['action', 'symbol', 'direction', 'strategy'],
          },
        },
      },
      required: ['decision', 'reasoning'],
    },
    execute: async (input) => {
      SubmitDecisionInput.parse(input);
      return { accepted: true };
    },
  };
}

export function getOpenPositionsTool(
  getOpenPositions: (filters: { symbol?: string; trader?: string }) => Promise<Trade[]>,
): ToolDef {
  return {
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
      return await getOpenPositions({
        symbol: parsed.symbol,
        trader: parsed.trader,
      });
    },
  };
}
