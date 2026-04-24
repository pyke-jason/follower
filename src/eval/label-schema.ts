import { z } from 'zod';
import { SignalSchema } from '../agent/schemas.js';

export const EvalLabelDataSchema = z.object({
  reasoning: z.string(),
  isTrade: z.boolean(),
  confidence: z.enum(['HIGH', 'LOW']).default('HIGH'),
  trades: z.array(z.array(SignalSchema)).default([])
    .describe('outer = trades in message, inner = legs of one trade'),
});

type EvalLabelData = z.infer<typeof EvalLabelDataSchema>;
