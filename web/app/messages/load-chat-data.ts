import { getMessages, getDistinctAuthors, getLabelsForMessages, getEnrichedMessages } from '@/lib/queries';
import type { Message, MessageLabel } from '@src/db/schema';
import type { MessageEnrichment, LabelFilter } from './actions';

export const PAGE_SIZE = 50;

export type ChatInitialData = {
  messages: Message[];
  cursor: string | null;
  labels: Record<string, MessageLabel>;
  enrichment: Record<string, MessageEnrichment>;
  authors: string[];
};

export async function loadInitialChatData(opts: {
  authors?: string[];
  startDate?: string;
  endDate?: string;
  runId?: string;
  signalsOnly?: boolean;
  labelFilter?: LabelFilter;
}): Promise<ChatInitialData> {
  const authorsPromise = getDistinctAuthors();

  let messages: Message[];
  let enrichment: Record<string, MessageEnrichment> = {};
  let nextCursor: string | null;

  if (opts.runId) {
    // Enriched path: fetch messages with trade/decision joins
    const enrichedResult = await getEnrichedMessages({
      traders: opts.authors ?? [],
      startDate: opts.startDate ?? '',
      endDate: opts.endDate ?? '',
      runId: opts.runId,
    });

    const hasMore = enrichedResult.rows.length > PAGE_SIZE;
    const rows = hasMore ? enrichedResult.rows.slice(0, PAGE_SIZE) : enrichedResult.rows;
    messages = rows.map((r) => r.message);
    for (const r of rows) {
      enrichment[r.message.id] = { decision: r.decision, trade: r.trade };
    }
    nextCursor = hasMore ? messages[messages.length - 1].timestamp : enrichedResult.nextCursor;
  } else {
    // Standard path
    const rows = await getMessages({
      authors: opts.authors,
      startDate: opts.startDate,
      endDate: opts.endDate,
      signalsOnly: opts.signalsOnly,
      labelFilter: opts.labelFilter,
      limit: PAGE_SIZE + 1,
    });

    const hasMore = rows.length > PAGE_SIZE;
    messages = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    nextCursor = hasMore ? messages[messages.length - 1].timestamp : null;
  }

  const ids = messages.map((m) => m.id);
  const [labels, authors] = await Promise.all([
    getLabelsForMessages(ids),
    authorsPromise,
  ]);

  return { messages, cursor: nextCursor, labels, enrichment, authors };
}
