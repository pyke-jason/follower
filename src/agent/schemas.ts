import { z } from 'zod';
import { zPrice, zPct01 } from '../lib/zod-financial.js';
import {
  DirectionSchema, LegActionSchema, StrategySchema,
  LabelStrategySchema, TradeActionSchema,
} from '../lib/enums.js';

// --- Tool input schemas (classification tools) ---

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

export const FlagForReviewInput = z.object({
  reason: z.string().min(1),
  uncertainty: z.string().optional(),
});

export const GetRecentChatInput = z.object({
  author: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type GetRecentChatInput = z.infer<typeof GetRecentChatInput>;

// --- Signal schema (classification-only agent output) ---

const SignalLegSchema = z.object({
  strike: zPrice,
  expiry: z.string().min(1),
  optionType: z.enum(['CALL', 'PUT']),
  action: LegActionSchema,
});

export const SignalSchema = z.object({
  action: TradeActionSchema,
  symbol: z.string().min(1),
  direction: DirectionSchema,
  strategy: StrategySchema,
  limitPrice: zPrice.optional(),
  exitPercent: zPct01.optional(),     // for TRIM: 0.5 = half
  legs: z.array(SignalLegSchema).optional(),
  /** For LEG_OFF: the strategy the position becomes after removing a leg. */
  targetStrategy: StrategySchema.optional(),
}).refine(
  s => s.strategy === 'STOCK' || !['OPEN', 'ADD'].includes(s.action) || (s.legs && s.legs.length > 0),
  { message: 'Options OPEN/ADD signals require legs with strike, expiry, optionType, and action' },
).refine(
  s => s.action !== 'LEG_OFF' || s.targetStrategy != null,
  { message: 'LEG_OFF requires targetStrategy (the strategy after removing the leg)' },
);

export type Signal = z.infer<typeof SignalSchema>;

// --- Agent decision schema ---

export const AgentDecisionSchema = z.object({
  decision: z.enum(['EXECUTE', 'SKIP', 'MANUAL_REVIEW']),
  reasoning: z.string(),
  signals: z.array(SignalSchema).optional(),
}).refine(
  d => d.decision !== 'EXECUTE' || (d.signals && d.signals.length > 0),
  { message: 'EXECUTE requires at least one signal' },
);

// --- Label agent result schema ---

export const LabelResultSchema = z.object({
  isTrade: z.boolean(),
  action: TradeActionSchema.nullable().optional(),
  direction: DirectionSchema.nullable().optional(),
  strategy: LabelStrategySchema.nullable().optional(),
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

export type TaskResult = z.infer<typeof AgentDecisionSchema>;

// --- submit_decision tool input (same shape as AgentDecisionSchema) ---

export const SubmitDecisionInput = AgentDecisionSchema;
