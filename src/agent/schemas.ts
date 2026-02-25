import { z } from 'zod';
import { zPrice, zPct01 } from '../lib/zod-financial.js';
import {
  DirectionSchema, LegActionSchema, StrategySchema,
  LabelStrategySchema, TradeActionSchema,
} from '../lib/enums.js';

// --- Tool input schemas (classification tools) ---

export const FlagForReviewInput = z.object({
  reason: z.string().min(1),
  uncertainty: z.string().optional(),
});

// --- Signal schema (classification-only agent output) ---

const SignalLegSchema = z.object({
  strike: z.number().nonnegative(),
  expiry: z.string().min(1).optional(),
  optionType: z.enum(['CALL', 'PUT']),
  action: LegActionSchema,
});

export const SignalSchema = z.object({
  action: TradeActionSchema,
  symbol: z.string().min(1),
  direction: DirectionSchema.optional(),
  strategy: StrategySchema.default('STOCK'),
  /** Trader's stated premium from the message text ("for $3.72", "for .09"). Informational only — never used for order placement. */
  statedPremium: zPrice.optional(),
  exitPercent: zPct01.optional(),     // for TRIM: 0.5 = half
  /** Present when trader explicitly states strikes. Absent when strikes need inferring by pipeline. */
  legs: z.array(SignalLegSchema).max(2).optional(),
  /** For LEG_OFF: the strategy the position becomes after removing a leg. */
  targetStrategy: StrategySchema.optional(),
}).refine(
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
