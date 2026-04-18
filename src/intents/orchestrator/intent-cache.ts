/**
 * Intent cache — records ALL orchestrator decisions and provides LLM cache hits.
 *
 * Every orchestrator outcome (deterministic or LLM) is written to `message_intents`
 * for tracking improvement across INTENT_VERSION bumps. LLM results are read back
 * on cache hit to skip the expensive agent loop.
 */

import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { messageIntents, IntentStepSchema } from '@/db/schema.js';
import type { IntentStep } from '@/db/schema.js';
import { SignalSchema } from '@/agent/schemas.js';
import type { Signal } from '@/agent/schemas.js';
import { createLogger } from '@/lib/logger.js';

const log = createLogger('IntentCache');

/**
 * Bump when NLU_SYSTEM_PROMPT, tool schemas, parser logic, or prompt
 * construction changes. Invalidates all cached results.
 */
export const INTENT_VERSION = 29;

export type IntentRoute = 'hard-skip' | 'deterministic' | 'llm';

const CachedIntentSchema = z.object({
  decision: z.string(),
  reasoning: z.string().nullable(),
  signals: z.array(SignalSchema).nullable(),
  steps: z.array(IntentStepSchema).nullable(),
  durationMs: z.number().nullable(),
});
export type CachedIntent = z.infer<typeof CachedIntentSchema>;

/**
 * Look up a cached LLM intent result.
 * Returns null on miss. Only useful for LLM-route results (deterministic
 * paths are cheap to re-run).
 *
 * On schema mismatch (tightened validators rejecting older payloads),
 * logs a warning and returns null — the caller re-runs the LLM and the
 * fresh row overwrites via the unique-index upsert path.
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

  const parsed = CachedIntentSchema.safeParse(row);
  if (!parsed.success) {
    log.warn(
      `Cached intent schema mismatch for ${messageId} v${INTENT_VERSION} — treating as miss: ${parsed.error.message.slice(0, 200)}`,
    );
    return null;
  }
  return parsed.data;
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
