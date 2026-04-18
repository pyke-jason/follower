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
    .describe('LONG | SHORT. REQUIRED whenever determinable. Always set from badges when present: [LONG BADGE] → LONG; [SHORT BADGE] → SHORT; [EXIT BADGE]+[LONG BADGE] → LONG (closing a long); [EXIT BADGE]+[SHORT BADGE] → SHORT (closing a short). For spreads: CDS/PCS → LONG (bullish); PDS/CCS → SHORT (bearish). Only null if the message truly provides no directional signal at all.'),
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
    .describe('The fill price the trader stated (entry on OPEN/ADD, exit on CLOSE/TRIM, credit/debit on spreads). REQUIRED whenever a price-like number appears anywhere in the message — including numbers stuck to the ticker ("Short UPS 85.38" → 85.38, "Long NVO55" → 55, "Short CVNA at 362" → 362), prices after badges ("Short Exit HOOD 98.89" → 98.89), and spread credits ("for .63 credit" → 0.63). Only null if the message contains NO price-like number, OR the number is unambiguously a quantity ("1,000 shares"), P&L figure ("$2 profit", "(51c gain)"), risk budget ("$500 risk"), or alert/threshold ("alert at 50"). When in doubt, emit the number. MUST be strictly positive (>0).'),
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
