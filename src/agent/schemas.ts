import { z } from 'zod';
import { zPrice, zPriceOpt, zNonNegPrice, zQuantity, zPct01 } from '../lib/zod-financial.js';

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
  strike: zPrice,
  expiry: z.string(),
  type: z.enum(['CALL', 'PUT', 'STOCK']),
  action: z.enum(['BUY', 'SELL']),
  quantity: zQuantity,
});

export const PlaceOrderInput = z.object({
  symbol: z.string().min(1),
  strategy: z.string().min(1),
  direction: z.enum(['LONG', 'SHORT']),
  legs: z.array(OrderLegSchema).min(1),
  orderType: z.enum(['MARKET', 'LIMIT']).default('LIMIT'),
  limitPrice: zPriceOpt,
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
  entryPrice: zPrice,
  strategy: z.string().min(1),
  spreadMaxRisk: z.number().optional(),
});

export const FlagForReviewInput = z.object({
  reason: z.string().min(1),
  uncertainty: z.string().optional(),
});

// --- Agent trade schema ---

export const AgentTradeSchema = z.object({
  symbol: z.string().min(1),
  direction: z.enum(['LONG', 'SHORT']),
  strategy: z.string().min(1),
  entryPrice: zPrice,
  exitPrice: zNonNegPrice.optional(),
  quantity: zQuantity,
  closeQuantity: zQuantity.optional(), // for partial closes
  legs: z.array(z.object({
    strike: zPrice,
    expiry: z.string().min(1),
    type: z.enum(['CALL', 'PUT', 'STOCK']),
    action: z.enum(['BUY', 'SELL']),
    quantity: zQuantity,
  })).optional().default([]),
});

export type AgentTrade = z.infer<typeof AgentTradeSchema>;

// --- Agent decision schema ---

export const AgentDecisionSchema = z.object({
  decision: z.enum(['EXECUTE', 'SKIP', 'MANUAL_REVIEW']),
  reasoning: z.string(),
  trade: AgentTradeSchema.nullable().optional(),
});

// --- Label agent result schema ---

export const LabelResultSchema = z.object({
  isTrade: z.boolean(),
  action: z.enum(['OPEN', 'CLOSE', 'ADD', 'TRIM']).nullable().optional(),
  direction: z.enum(['LONG', 'SHORT']).nullable().optional(),
  strategy: z.enum(['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS']).nullable().optional(),
  symbol: z.string().nullable().optional(),
  price: z.string().nullable().optional(),
  strikes: z.array(z.number()).nullable().optional(),
  quantity: z.string().nullable().optional(),
  expiry: z.string().nullable().optional(),
  exitPercent: zPct01.nullable().optional(), // 0.0–1.0 for TRIM actions
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  notes: z.string().nullable().optional(),
});

export type LabelResult = z.infer<typeof LabelResultSchema>;
