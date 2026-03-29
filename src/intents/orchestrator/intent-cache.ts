/**
 * Intent cache — records ALL orchestrator decisions and provides LLM cache hits.
 *
 * Every orchestrator outcome (deterministic or LLM) is written to `message_intents`
 * for tracking improvement across INTENT_VERSION bumps. LLM results are read back
 * on cache hit to skip the expensive agent loop.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { messageIntents } from '@/db/schema.js';
import type { Signal, IntentStep } from '@/db/schema.js';
import { createLogger } from '@/lib/logger.js';

const log = createLogger('IntentCache');

/**
 * Bump when NLU_SYSTEM_PROMPT, tool schemas, parser logic, or prompt
 * construction changes. Invalidates all cached results.
 */
export const INTENT_VERSION = 2;

export type IntentRoute = 'hard-skip' | 'deterministic' | 'llm';

export type CachedIntent = {
  decision: string;
  reasoning: string | null;
  signals: Signal[] | null;
  steps: IntentStep[] | null;
  durationMs: number | null;
};

/**
 * Look up a cached LLM intent result.
 * Returns null on miss. Only useful for LLM-route results (deterministic
 * paths are cheap to re-run).
 */
export function lookupIntent(
  messageId: string,
  model: string,
): CachedIntent | null {
  const row = db
    .select({
      decision: messageIntents.decision,
      reasoning: messageIntents.reasoning,
      signals: messageIntents.signals,
      steps: messageIntents.steps,
      durationMs: messageIntents.durationMs,
    })
    .from(messageIntents)
    .where(
      and(
        eq(messageIntents.messageId, messageId),
        eq(messageIntents.model, model),
        eq(messageIntents.version, INTENT_VERSION),
        eq(messageIntents.route, 'llm'),
      ),
    )
    .get() ?? null;

  if (!row) return null;

  return {
    decision: row.decision,
    reasoning: row.reasoning,
    signals: row.signals,
    steps: row.steps,
    durationMs: row.durationMs,
  };
}

/**
 * Write an orchestrator decision to the cache. INSERT OR IGNORE — the
 * unique index on (messageId, model, version) handles races naturally.
 */
export function writeIntent(entry: {
  messageId: string;
  model: string;
  route: IntentRoute;
  decision: string;
  reasoning?: string | null;
  signals?: Signal[] | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  turns?: number | null;
  steps?: IntentStep[] | null;
}): void {
  try {
    db.insert(messageIntents)
      .values({
        messageId: entry.messageId,
        model: entry.model,
        version: INTENT_VERSION,
        route: entry.route,
        decision: entry.decision,
        reasoning: entry.reasoning ?? null,
        signals: entry.signals ?? null,
        durationMs: entry.durationMs ?? null,
        inputTokens: entry.inputTokens ?? null,
        outputTokens: entry.outputTokens ?? null,
        turns: entry.turns ?? null,
        steps: entry.steps ?? null,
      })
      .onConflictDoNothing()
      .run();
  } catch (err) {
    log.debug('Failed to write intent cache (non-fatal):', err);
  }
}
