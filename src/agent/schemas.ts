import { z } from 'zod';

// --- Tool input schemas ---

export const GetQuoteInput = z.object({
  symbol: z.string().min(1),
});

export const GetOptionsChainInput = z.object({
  symbol: z.string().min(1),
  expiry: z.string().min(1),
  optionType: z.enum(['CALL', 'PUT']),
});

export const GetOpenPositionsInput = z.object({
  symbol: z.string().optional(),
  trader: z.string().optional(),
});

export const CheckRiskLimitsInput = z.object({
  symbol: z.string().min(1),
  strategy: z.string().min(1),
  trader: z.string().min(1),
  maxRisk: z.number().optional(),
});

const OrderLegSchema = z.object({
  strike: z.number(),
  expiry: z.string(),
  type: z.enum(['CALL', 'PUT', 'STOCK']),
  action: z.enum(['BUY', 'SELL']),
  quantity: z.number().positive(),
});

export const PlaceOrderInput = z.object({
  symbol: z.string().min(1),
  strategy: z.string().min(1),
  direction: z.enum(['LONG', 'SHORT']),
  legs: z.array(OrderLegSchema).min(1),
  orderType: z.enum(['MARKET', 'LIMIT']).default('LIMIT'),
  limitPrice: z.number().optional(),
  adjustmentRules: z.array(z.object({
    type: z.enum(['PRICE_CHASE']),
    stepAmount: z.number(),
    intervalSec: z.number(),
    maxSteps: z.number().optional(),
  })).optional(),
  cancelAfterSec: z.number().optional(),
});

export const CalculatePositionSizeInput = z.object({
  trader: z.string().min(1),
  symbol: z.string().min(1),
  entryPrice: z.number().positive(),
  strategy: z.string().min(1),
  spreadMaxRisk: z.number().optional(),
});

export const FlagForReviewInput = z.object({
  reason: z.string().min(1),
  uncertainty: z.string().optional(),
});

// --- Agent decision schema ---

export const AgentDecisionSchema = z.object({
  decision: z.enum(['EXECUTE', 'SKIP', 'MANUAL_REVIEW']),
  reasoning: z.string(),
  trade: z.record(z.string(), z.unknown()).nullable().optional(),
});
