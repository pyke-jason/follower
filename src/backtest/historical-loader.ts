import { and, gte, lte, inArray, asc } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { HistoricalMessage } from './types.js';

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

  return rows.map((row) => ({
    id: row.id,
    author: row.author,
    timestamp: new Date(row.timestamp),
    rawHtml: row.rawHtml,
    cleanText: row.cleanText,
    badges: row.badges ?? [],
    symbols: row.symbols ?? [],
    actionHint: row.actionHint as 'OPEN' | 'CLOSE' | null,
    directionHint: row.directionHint as 'LONG' | 'SHORT' | null,
    detectedStrategies: row.detectedStrategies ?? [],
    isPaperTrade: row.isPaperTrade ?? false,
    confidence: row.confidence ? parseFloat(row.confidence) : 0,
  }));
}
