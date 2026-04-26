import { z } from 'zod';
import type { Agent, AgentStep, AgentUsage } from '@/agent/result.js';
import type { ToolDef } from '@/agent/tool-factory.js';
import {
  CriticVerdictSchema,
  SafetyFindingSchema,
  type ClassificationAuditPayload,
  type CriticVerdict,
} from './schemas.js';

export const CriticSubmitInputSchema = z.object({
  verdict: z.enum(['ok', 'warning', 'critical']),
  summary: z.string().min(1),
  findings: z.array(SafetyFindingSchema).max(5),
});
export type CriticSubmitInput = z.infer<typeof CriticSubmitInputSchema>;

const CRITIC_SYSTEM_PROMPT = `You are a postmortem critic for an autonomous trade-copy system.

Your job is to find concrete contradictions only. Do not place orders, do not rewrite the trade, and do not speculate.

Review the JSON payload and call submit_audit exactly once.

Flag critical only when evidence is concrete:
- message says profit/gain but realized P&L is negative
- message says loss/stop/cut but realized P&L is positive beyond scratch
- message says scratch but P&L is material
- SKIP/MANUAL_REVIEW mentions a held symbol and looks like a real exit
- executed trade contradicts explicit options/stock language
- future/conditional language was executed as a trade
- multi-trade message produced too few or malformed signals

If the evidence is weak, return verdict="ok" or verdict="warning".`;

type CriticRun = {
  verdict: CriticVerdict;
  steps: AgentStep[];
  usage: AgentUsage;
};

export async function runClassificationCritic(params: {
  agent: Agent;
  payload: ClassificationAuditPayload;
}): Promise<CriticRun> {
  let captured: CriticVerdict | null = null;

  const submitAudit: ToolDef<typeof CriticSubmitInputSchema> = {
    name: 'submit_audit',
    description: 'Submit the final postmortem audit verdict.',
    input: CriticSubmitInputSchema,
    execute: async (input) => {
      captured = CriticVerdictSchema.parse(input);
      return { accepted: true };
    },
  };

  const result = await params.agent.run({
    systemPrompt: CRITIC_SYSTEM_PROMPT,
    userPrompt: JSON.stringify(params.payload, null, 2),
    tools: [submitAudit],
    onToolCall: (name, input) => {
      if (name !== 'submit_audit') return null;
      const parsed = CriticSubmitInputSchema.safeParse(input);
      return parsed.success ? parsed.data : null;
    },
    maxTurns: 3,
    timeoutMs: Number(process.env.CLASSIFICATION_CRITIC_TIMEOUT_MS ?? '60000'),
  });

  const parsed = CriticVerdictSchema.safeParse(result.result ?? captured);
  return {
    verdict: parsed.success
      ? parsed.data
      : {
          verdict: 'warning',
          summary: 'Critic did not return a valid audit verdict',
          findings: [{
            category: 'critic_error',
            severity: 'warning',
            message: 'Critic did not return a valid audit verdict.',
            evidence: result.steps.map((step) => step.reasoning).filter(Boolean).join('\n').slice(0, 500) || 'No critic output',
            confidence: 0.5,
          }],
        },
    steps: result.steps,
    usage: result.usage,
  };
}
