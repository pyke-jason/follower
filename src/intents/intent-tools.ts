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
} from '../agent/schemas.js';

/** Callback for the get_recent_chat tool. */
export type ChatLookup = (author: string | undefined, limit: number) => Promise<string>;

/** Create the standard intent extraction tools with a pluggable chat lookup. */
export function createIntentTools(chat: ChatLookup): ToolDef[] {
  const getRecentChat: ToolDef<typeof GetRecentChatInput> = {
    name: 'get_recent_chat',
    description: 'Get recent chat room messages before this message. Use to resolve follow-trades: when a trader references another trader ("following Dave", "@spectre", "ty Hari") or posts a bare entry that might follow someone else\'s call. Optionally filter by author.',
    input: GetRecentChatInput,
    execute: async (input) => {
      const limit = Math.min(input.limit ?? 20, 50);
      return chat(input.author, limit);
    },
  };
  return [flagForReviewTool(), submitDecisionTool(), getRecentChat];
}

/** Shared onToolCall handler for submit_decision and flag_for_review. */
export function intentOnToolCall(name: string, input: Record<string, unknown>): TaskResult | null {
  if (name === 'submit_decision') {
    const parsed = SubmitDecisionInput.safeParse(input);
    if (parsed.success) return parsed.data satisfies TaskResult;
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
