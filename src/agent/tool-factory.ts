import {
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
              action: { type: 'string', enum: ['OPEN', 'CLOSE', 'ADD', 'TRIM', 'LEG_OFF'] },
              symbol: { type: 'string' },
              direction: { type: 'string', enum: ['LONG', 'SHORT'], description: 'Required for OPEN. Optional hint for exits.' },
              strategy: { type: 'string', enum: ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS', 'CCS'], description: 'Required for OPEN. Optional hint for exits.' },
              strikes: { type: 'array', items: { type: 'number' }, description: 'Strike prices stated in the message. Single option: [332.5]. Spread: [190, 192.5]. Omit if no strikes stated.' },
              expiry: { type: 'string', description: 'Expiry as stated in message: "Oct (17)", "next week", "5/23", "0DTE". Omit if not stated.' },
              statedPrice: { type: 'number', description: 'OPEN only. The premium/price the trader stated in the message (e.g. 3.72 from "for $3.72"). Omit if no price stated.' },
              quantity: { type: 'number', description: 'Shares or contracts when stated. Omit if not stated.' },
              exitPercent: { type: 'number', description: '0.0-1.0 for TRIM' },
              targetStrategy: { type: 'string', enum: ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS', 'CCS'], description: 'For LEG_OFF: strategy after removing the leg' },
            },
            required: ['action', 'symbol'],
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
