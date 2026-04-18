import { z } from 'zod';
import { zPrice, zPct01 } from '../lib/zod-financial.js';
import {
  DecisionOutcomeSchema, DirectionSchema, StrategySchema,
  TradeActionSchema,
} from '../lib/enums.js';

// --- flag_for_review tool input ---

export const FlagForReviewInput = z.object({
  reason: z.string().min(1).describe('Why this needs human review'),
  uncertainty: z.string().optional().describe('What specifically is unclear'),
});

// --- Signal (classification + label shared type) ---
//
// `SignalObject` is the bare `z.object(...)` used for tool signatures — the
// SDK needs `.shape` access and cannot read `.shape` off a refined
// `ZodEffects`. `SignalSchema` is the same object plus the cross-field refine,
// used for runtime `.parse()`.

export const SignalObject = z.object({
  action: TradeActionSchema,
  symbol: z.string().min(1),
  direction: DirectionSchema.nullable().default(null)
    .describe('Required for OPEN. Optional hint for exits.'),
  strategy: StrategySchema.nullable().default(null)
    .describe('Required for OPEN. Optional hint for exits.'),
  /** Strike prices stated in the message. Single option: [332.5]. Spread: [190, 192.5]. */
  strikes: z.array(z.number()).nullable().default(null)
    .describe('Strike prices stated in the message. Single option: [332.5]. Spread: [190, 192.5]. Omit if no strikes stated.'),
  /** Expiry as stated in message: "Oct (17)", "next week", "5/23", "0DTE". */
  expiry: z.string().nullable().default(null)
    .describe('Expiry as stated in message: "Oct (17)", "next week", "5/23", "0DTE". Omit if not stated.'),
  /** Stated price: option premium, credit amount, or stock entry price. */
  statedPrice: zPrice.nullable().default(null)
    .describe('OPEN only. The premium/price the trader stated in the message (e.g. 3.72 from "for $3.72"). Omit if no price stated.'),
  /** Shares or contracts when stated. */
  quantity: z.number().nullable().default(null)
    .describe('Shares or contracts when stated. Omit if not stated.'),
  /** For TRIM: exit fraction 0.0–1.0 (0.5 = half). */
  exitPercent: zPct01.optional().describe('0.0-1.0 for TRIM'),
  /** For LEG_OFF: the strategy the position becomes after removing a leg. */
  targetStrategy: StrategySchema.optional()
    .describe('For LEG_OFF: strategy after removing the leg'),
});

export const SignalSchema = SignalObject.refine(
  s => s.action !== 'LEG_OFF' || s.targetStrategy != null,
  { message: 'LEG_OFF requires targetStrategy (the strategy after removing the leg)' },
);

export type Signal = z.infer<typeof SignalSchema>;

// --- submit_decision tool input / agent decision ---

export const SubmitDecisionObject = z.object({
  decision: DecisionOutcomeSchema,
  reasoning: z.string().describe('Why you made this decision'),
  signals: z.array(SignalSchema).optional().describe('Trade signals (required for EXECUTE)'),
});

export const AgentDecisionSchema = SubmitDecisionObject.refine(
  d => d.decision !== 'EXECUTE' || (d.signals && d.signals.length > 0),
  { message: 'EXECUTE requires at least one signal' },
);

export type TaskResult = z.infer<typeof AgentDecisionSchema>;
export const SubmitDecisionInput = AgentDecisionSchema;

// --- get_recent_chat tool input ---

export const GetRecentChatInput = z.object({
  author: z.string().optional()
    .describe('Filter to a specific author (optional). Omit to get all authors.'),
  limit: z.number().optional()
    .describe('Number of messages to return (default 20, max 50)'),
});
