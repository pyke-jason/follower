/**
 * Intent cache — records ALL orchestrator decisions and provides LLM cache hits.
 *
 * Every orchestrator outcome (deterministic or LLM) is written to `message_intents`
 * for tracking improvement across INTENT_VERSION bumps. LLM results are read back
 * on cache hit to skip the expensive agent loop.
 */

import { eq, and, gte, sql } from 'drizzle-orm';
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
export const INTENT_VERSION = 61;

export type IntentRoute = 'hard-skip' | 'deterministic' | 'llm';

const CachedIntentSchema = z.object({
  decision: z.string(),
  reasoning: z.string().nullable(),
  signals: z.array(SignalSchema).nullable(),
  steps: z.array(IntentStepSchema).nullable(),
  durationMs: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheReadInputTokens: z.number().nullable(),
  cacheCreationInputTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
});
type CachedIntent = z.infer<typeof CachedIntentSchema>;

/**
 * Look up a cached LLM intent result.
 * Returns null on miss. Only useful for LLM-route results (deterministic
 * paths are cheap to re-run).
 *
 * On schema mismatch (tightened validators rejecting older payloads),
 * logs a warning and returns null — the caller re-runs the LLM and the
 * fresh row overwrites via the unique-index upsert path.
 */
export async function lookupIntent(
  messageId: string,
  model: string,
): Promise<CachedIntent | null> {
  const [row] = await db
    .select({
      decision: messageIntents.decision,
      reasoning: messageIntents.reasoning,
      signals: messageIntents.signals,
      steps: messageIntents.steps,
      durationMs: messageIntents.durationMs,
      inputTokens: messageIntents.inputTokens,
      outputTokens: messageIntents.outputTokens,
      cacheReadInputTokens: messageIntents.cacheReadInputTokens,
      cacheCreationInputTokens: messageIntents.cacheCreationInputTokens,
      costUsd: messageIntents.costUsd,
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
    .limit(1);

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
 * Sum LLM cost (USD) recorded in message_intents for the current calendar day
 * (UTC). Includes all models and versions. Returns 0 when no rows exist or
 * all costs are null.
 */
export async function getDailyLlmCostUsd(): Promise<number> {
  const todayUtc = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${messageIntents.costUsd}), 0)` })
    .from(messageIntents)
    .where(gte(messageIntents.createdAt, todayUtc));
  return row?.total ?? 0;
}

/**
 * Write an orchestrator decision to the cache. INSERT OR IGNORE — the
 * unique index on (messageId, model, version) handles races naturally.
 */
export async function writeIntent(entry: {
  messageId: string;
  model: string;
  route: IntentRoute;
  decision: string;
  reasoning?: string | null;
  signals?: Signal[] | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  costUsd?: number | null;
  turns?: number | null;
  steps?: IntentStep[] | null;
}): Promise<void> {
  try {
    await db.insert(messageIntents)
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
        cacheReadInputTokens: entry.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: entry.cacheCreationInputTokens ?? null,
        costUsd: entry.costUsd ?? null,
        turns: entry.turns ?? null,
        steps: entry.steps ?? null,
      })
      .onConflictDoNothing();
  } catch (err) {
    log.debug('Failed to write intent cache (non-fatal):', err);
  }
}
