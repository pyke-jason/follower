import { z } from 'zod';
import { zPrice, zPct01 } from '../lib/zod-financial.js';
import {
  DecisionOutcomeSchema, DirectionSchema, StrategySchema,
  TradeActionSchema,
} from '../lib/enums.js';

// --- Tool input schemas (classification tools) ---

export const FlagForReviewInput = z.object({
  reason: z.string().min(1),
  uncertainty: z.string().optional(),
});

// --- Signal schema (classification + label shared type) ---

export const SignalSchema = z.object({
  action: TradeActionSchema,
  symbol: z.string().min(1),
  direction: DirectionSchema.nullable().default(null),
  strategy: StrategySchema.nullable().default(null),
  /** Strike prices stated in the message. Single option: [332.5]. Spread: [190, 192.5]. */
  strikes: z.array(z.number()).nullable().default(null),
  /** Expiry as stated in message: "Oct (17)", "next week", "5/23", "0DTE". */
  expiry: z.string().nullable().default(null),
  /** Stated price: option premium, credit amount, or stock entry price. */
  statedPrice: zPrice.nullable().default(null),
  /** Shares or contracts when stated. */
  quantity: z.number().nullable().default(null),
  /** For TRIM: exit fraction 0.0–1.0 (0.5 = half). */
  exitPercent: zPct01.optional(),
  /** For LEG_OFF: the strategy the position becomes after removing a leg. */
  targetStrategy: StrategySchema.optional(),
}).refine(
  s => s.action !== 'LEG_OFF' || s.targetStrategy != null,
  { message: 'LEG_OFF requires targetStrategy (the strategy after removing the leg)' },
);

export type Signal = z.infer<typeof SignalSchema>;

// --- Agent decision schema ---

export const AgentDecisionSchema = z.object({
  decision: DecisionOutcomeSchema,
  reasoning: z.string(),
  signals: z.array(SignalSchema).optional(),
}).refine(
  d => d.decision !== 'EXECUTE' || (d.signals && d.signals.length > 0),
  { message: 'EXECUTE requires at least one signal' },
);

export type TaskResult = z.infer<typeof AgentDecisionSchema>;

// --- submit_decision tool input (same shape as AgentDecisionSchema) ---

export const SubmitDecisionInput = AgentDecisionSchema;
