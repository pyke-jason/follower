import { and, gte, lte, inArray, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/client.js';
import type { HistoricalMessage } from './types.js';

const ActionHintEnum = z.enum(['OPEN', 'CLOSE']).nullable();
const DirectionHintEnum = z.enum(['LONG', 'SHORT']).nullable();

/**
 * Load historical messages from the local database.
 * Messages are already classified at ingestion time.
 */
export async function loadHistoricalMessages(opts: {
  startDate: Date;
  endDate: Date;
  traders: string[];
}): Promise<HistoricalMessage[]> {
  const startIso = opts.startDate.toISOString();
  const endIso = opts.endDate.toISOString();

  const rows = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        inArray(schema.messages.author, opts.traders),
        gte(schema.messages.timestamp, startIso),
        lte(schema.messages.timestamp, endIso),
      ),
    )
    .orderBy(asc(schema.messages.timestamp));

  return rows.map((row) => {
    const actionParsed = ActionHintEnum.safeParse(row.actionHint);
    const directionParsed = DirectionHintEnum.safeParse(row.directionHint);

    if (!actionParsed.success && row.actionHint != null) {
      console.warn(`[HistoricalLoader] Invalid actionHint "${row.actionHint}" for message ${row.id}, treating as null`);
    }
    if (!directionParsed.success && row.directionHint != null) {
      console.warn(`[HistoricalLoader] Invalid directionHint "${row.directionHint}" for message ${row.id}, treating as null`);
    }

    const confidence = row.confidence ? parseFloat(row.confidence) : 0;
    if (Number.isNaN(confidence)) {
      console.warn(`[HistoricalLoader] Non-numeric confidence "${row.confidence}" for message ${row.id}, using 0`);
    }

    return {
      id: row.id,
      author: row.author,
      timestamp: new Date(row.timestamp),
      rawHtml: row.rawHtml,
      cleanText: row.cleanText,
      badges: row.badges ?? [],
      symbols: row.symbols ?? [],
      actionHint: actionParsed.success ? actionParsed.data : null,
      directionHint: directionParsed.success ? directionParsed.data : null,
      detectedStrategies: row.detectedStrategies ?? [],
      isPaperTrade: row.isPaperTrade ?? false,
      confidence: Number.isNaN(confidence) ? 0 : confidence,
    };
  });
}
