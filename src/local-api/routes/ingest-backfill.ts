import { Hono } from 'hono';
import { db, schema } from '@/db/client.js';
import { classifyMessage } from '@/parsing/classify.js';
import { normalizeForDedup, computeContentHash } from '@/ingestion/dedup.js';
import { validateBody } from '../validate.js';
import { IngestBackfillBodySchema } from '../http-schemas.js';

const app = new Hono();

app.post('/', async (c) => {
  const { messages } = await validateBody(IngestBackfillBodySchema, c);

  let saved = 0;
  for (const apiMsg of messages) {
    const id = String(apiMsg.Id);
    const classification = classifyMessage(apiMsg.Message ?? '');
    const normalizedText = normalizeForDedup(classification.cleanText);
    const contentHash = computeContentHash(normalizedText);
    const reactions = (apiMsg.Reactions ?? [])
      .filter((r) => r.Type && r.Count > 0)
      .map((r) => ({ Type: r.Type, Count: r.Count }));

    try {
      await db.insert(schema.messages).values({
        id,
        author: apiMsg.Author,
        timestamp: apiMsg.TimeUtc ?? new Date().toISOString(),
        rawHtml: apiMsg.Message ?? '',
        cleanText: classification.cleanText,
        badges: classification.badges,
        symbols: classification.symbols,
        actionHint: classification.actionHint ?? null,
        directionHint: classification.directionHint ?? null,
        detectedStrategies: classification.detectedStrategies,
        isPaperTrade: classification.isPaperTrade,
        confidence: String(classification.confidence),
        contentHash,
        reactions,
      }).onConflictDoNothing();
      saved++;
    } catch {
      // Skip duplicates / errors
    }
  }

  return c.json({ received: messages.length, saved });
});

export default app;
