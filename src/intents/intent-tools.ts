/**
 * Shared intent extraction tools and callbacks.
 *
 * Extracted from extract-intent.ts so that both the old LLM pipeline
 * and the orchestrator's llm-path can import without circular deps.
 */

import type { ToolDef } from '../agent/tool-factory.js';
import type { TaskResult } from '../agent/schemas.js';
import {
  flagForReviewTool,
  submitDecisionTool,
} from '../agent/tool-factory.js';
import {
  FlagForReviewInput,
  GetRecentChatInput,
  SubmitDecisionInput,
  SubmitDecisionObject,
} from '../agent/schemas.js';
import type { ValidatorIssue } from './orchestrator/signal-validator.js';
import type { z } from 'zod';
import { createLogger } from '../lib/logger.js';

const log = createLogger('IntentTools');

/** Callback for the get_recent_chat tool. */
export type ChatLookup = (author: string | undefined, limit: number) => Promise<string>;

/**
 * Validator called from inside submit_decision. If it returns any issues,
 * the tool rejects the draft; the LLM sees the concerns in its next turn
 * and retries within the same agent loop.
 */
export type ValidateFn = (draft: TaskResult) => Promise<ValidatorIssue[]>;

/** Create the standard intent extraction tools with a pluggable chat lookup. */
export function createIntentTools(chat: ChatLookup, validate?: ValidateFn): ToolDef[] {
  const getRecentChat: ToolDef<typeof GetRecentChatInput> = {
    name: 'get_recent_chat',
    description: 'Get recent chat room messages before this message. Use to resolve follow-trades: when a trader references another trader ("following Dave", "@spectre", "ty Hari") or posts a bare entry that might follow someone else\'s call. Optionally filter by author.',
    input: GetRecentChatInput,
    execute: async (input) => {
      const limit = Math.min(input.limit ?? 20, 50);
      return chat(input.author, limit);
    },
  };
  // If a validator was provided, wrap submit_decision. Validator fires ONCE
  // per agent run; if the LLM's first draft raises concerns, the tool returns
  // a rejection and the LLM retries within the same loop. On the retry, the
  // validator auto-accepts — preventing infinite LLM↔validator disagreement
  // loops that waste turns (per April 2026 SOTA: max 1 repair call).
  const base = submitDecisionTool();
  const submit: ToolDef<typeof SubmitDecisionObject> = validate
    ? (() => {
        let rejectionCount = 0;
        return {
          name: base.name,
          description: base.description,
          input: base.input,
          execute: async (input: z.infer<typeof SubmitDecisionObject>) => {
            SubmitDecisionInput.parse(input);
            if (input.decision !== 'EXECUTE' || !input.signals || input.signals.length === 0) {
              return { accepted: true };
            }
            if (rejectionCount >= 2) return { accepted: true }; // cap at 2 repair attempts
            const issues = await validate({ decision: input.decision, reasoning: input.reasoning ?? '', signals: input.signals });
            if (issues.length === 0) return { accepted: true };
            rejectionCount++;
            return {
              accepted: false,
              reason: 'Verification concerns — please reconsider and call submit_decision again with any corrections. If a concern is unfounded, explain briefly in reasoning and proceed.',
              issues: issues.map((i) => ({
                signalIndex: i.signalIndex,
                field: i.field,
                evidence: i.evidence,
                concern: i.concern,
              })),
            };
          },
        };
      })()
    : base;
  return [flagForReviewTool(), submit, getRecentChat];
}

function coerceSignal(sig: unknown): unknown {
  if (sig == null || typeof sig !== 'object') return sig;
  const s = { ...(sig as Record<string, unknown>) };
  if (typeof s.action === 'string') s.action = s.action.toUpperCase();
  if (typeof s.direction === 'string') {
    const d = s.direction.toUpperCase();
    s.direction = d === 'BUY' ? 'LONG' : d === 'SELL' ? 'SHORT' : d;
  }
  if (typeof s.strategy === 'string') s.strategy = s.strategy.toUpperCase();
  if (typeof s.targetStrategy === 'string') s.targetStrategy = s.targetStrategy.toUpperCase();
  if (typeof s.symbol === 'string') s.symbol = s.symbol.toUpperCase();
  if (typeof s.strikes === 'number') s.strikes = [s.strikes];
  if (typeof s.strikes === 'string') {
    const n = Number(s.strikes);
    s.strikes = Number.isFinite(n) ? [n] : null;
  }
  if (typeof s.statedPrice === 'string') {
    const n = Number(s.statedPrice);
    s.statedPrice = Number.isFinite(n) ? n : null;
  }
  // Grok frequently strips leading decimals ("0.63" → "0") and zPrice requires >0.
  // Null-out statedPrice=0 so the schema accepts the call; real prices are never 0.
  if (s.statedPrice === 0) s.statedPrice = null;
  if (typeof s.quantity === 'string') {
    const n = Number(s.quantity);
    s.quantity = Number.isFinite(n) ? n : null;
  }
  if (typeof s.exitPercent === 'string') {
    const n = Number(s.exitPercent);
    s.exitPercent = Number.isFinite(n) ? n : undefined;
  }
  if (typeof s.exitPercent === 'number' && s.exitPercent > 1 && s.exitPercent <= 100) {
    s.exitPercent = s.exitPercent / 100;
  }
  // exitPercent=0 on non-TRIM is invalid — drop it.
  if (s.exitPercent === 0 && s.action !== 'TRIM') delete s.exitPercent;
  // targetStrategy is only valid for LEG_OFF; Grok sometimes emits "STOCK" for OPENs.
  if (s.action !== 'LEG_OFF' && s.targetStrategy != null) delete s.targetStrategy;
  return s;
}

function coerceDecision(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  if (typeof out.decision === 'string') out.decision = out.decision.toUpperCase();
  if (Array.isArray(out.signals)) out.signals = out.signals.map(coerceSignal);
  return out;
}

/** Shared onToolCall handler for submit_decision and flag_for_review. */
export function intentOnToolCall(name: string, input: Record<string, unknown>, output?: unknown): TaskResult | null {
  if (name === 'submit_decision') {
    // If the tool's execute rejected the draft (validator found issues),
    // DO NOT capture as final — the LLM sees the rejection output and retries.
    if (output && typeof output === 'object' && (output as Record<string, unknown>).accepted === false) {
      return null;
    }
    const coerced = coerceDecision(input);
    const parsed = SubmitDecisionInput.safeParse(coerced);
    if (parsed.success) return parsed.data satisfies TaskResult;
    log.warn(`submit_decision schema failure: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')} | input=${JSON.stringify(input).slice(0, 400)}`);
    return null;
  }
  if (name === 'flag_for_review') {
    const flagParsed = FlagForReviewInput.safeParse(input);
    return {
      decision: 'MANUAL_REVIEW',
      reasoning: flagParsed.success ? flagParsed.data.reason : 'Flagged by agent',
    } satisfies TaskResult;
  }
  return null;
}
