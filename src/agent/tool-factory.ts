import type { z } from 'zod';
import {
  FlagForReviewInput,
  SubmitDecisionInput,
  SubmitDecisionObject,
} from './schemas.js';

export type ToolDef<TInput extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  input: TInput;
  execute: (input: z.infer<TInput>) => Promise<unknown>;
};

// ─── Individual tool builders ────────────────────────────────────────

export function flagForReviewTool(): ToolDef<typeof FlagForReviewInput> {
  return {
    name: 'flag_for_review',
    description: 'Flag this message for manual human review. Use when uncertain about the trade.',
    input: FlagForReviewInput,
    execute: async (input) => ({
      flagged: true,
      reason: input.reason,
      uncertainty: input.uncertainty,
    }),
  };
}

export function submitDecisionTool(): ToolDef<typeof SubmitDecisionObject> {
  return {
    name: 'submit_decision',
    description: 'Submit your final trade classification decision. Call this exactly once after analysis.',
    input: SubmitDecisionObject,
    execute: async (input) => {
      SubmitDecisionInput.parse(input);
      return { accepted: true };
    },
  };
}
