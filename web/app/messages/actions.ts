'use server';

import { getMessages, getMessageById, getMessagesBySymbols, getLabelsForMessages, getEnrichedMessages } from '@/lib/queries';
import { db, schema } from '@/lib/db';
import { PAGE_SIZE } from './load-chat-data';
import { revalidatePath } from 'next/cache';
import type { Message, MessageLabel } from '@src/db/schema';
import type { Signal } from '@src/agent/schemas';
import type { TradeOutcome, MessageDecision } from '@src/lib/enriched-message';

export type LabelFilter = 'labeled' | 'unlabeled';

export type MessageEnrichment = {
  decision: MessageDecision | null;
  trade: TradeOutcome | null;
};

export type MessageFilters = {
  authors?: string[];
  startDate?: string;
  endDate?: string;
  signalsOnly?: boolean;
  labelFilter?: LabelFilter;
  cursor?: string;
  runId?: string;
  roleFilter?: 'all' | 'processed' | 'executed' | 'skipped';
};

export type FetchMessagesResult = {
  messages: Message[];
  labels: Record<string, MessageLabel>;
  enrichment: Record<string, MessageEnrichment>;
  nextCursor: string | null;
};


export async function fetchMessages(
  filters: MessageFilters
): Promise<FetchMessagesResult> {
  // When runId is present, use the enriched query path
  if (filters.runId) {
    return fetchEnrichedPath(filters);
  }
  return fetchStandardPath(filters);
}

async function fetchStandardPath(filters: MessageFilters): Promise<FetchMessagesResult> {
  const rows = await getMessages({
    authors: filters.authors,
    startDate: filters.startDate,
    endDate: filters.endDate,
    signalsOnly: filters.signalsOnly,
    labelFilter: filters.labelFilter,
    cursor: filters.cursor,
    limit: PAGE_SIZE + 1,
  });

  const hasMore = rows.length > PAGE_SIZE;
  const messages = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor = hasMore ? messages[messages.length - 1].timestamp : null;

  const ids = messages.map((m) => m.id);
  const labels = await getLabelsForMessages(ids);

  return { messages, labels, enrichment: {}, nextCursor };
}

async function fetchEnrichedPath(filters: MessageFilters): Promise<FetchMessagesResult> {
  const enrichedResult = await getEnrichedMessages({
    traders: filters.authors ?? [],
    startDate: filters.startDate ?? '',
    endDate: filters.endDate ?? '',
    cursor: filters.cursor,
    runId: filters.runId,
    roleFilter: filters.roleFilter,
  });

  const messages = enrichedResult.rows.map((r) => r.message);
  const enrichment: Record<string, MessageEnrichment> = {};
  for (const r of enrichedResult.rows) {
    enrichment[r.message.id] = { decision: r.decision, trade: r.trade };
  }

  const ids = messages.map((m) => m.id);
  const labels = await getLabelsForMessages(ids);

  return { messages, labels, enrichment, nextCursor: enrichedResult.nextCursor };
}

export async function fetchMessage(id: string): Promise<Message | null> {
  return getMessageById(id);
}

/** Fetch messages that share any symbol with the given message. */
export async function fetchRelatedMessages(
  messageId: string,
): Promise<{
  messages: Message[];
  labels: Record<string, MessageLabel>;
  sourceSymbols: string[];
}> {
  const source = await getMessageById(messageId);
  if (!source) return { messages: [], labels: {}, sourceSymbols: [] };

  const sourceSymbols = (source.symbols as string[]) ?? [];
  if (sourceSymbols.length === 0) return { messages: [source], labels: {}, sourceSymbols };

  const messages = await getMessagesBySymbols(sourceSymbols, 200);

  const ids = messages.map((m) => m.id);
  const labels = await getLabelsForMessages(ids);

  return { messages, labels, sourceSymbols };
}

// ─── Label Actions ──────────────────────────────────

/** Save label signals for a message (upsert). */
export async function saveLabel(
  messageId: string,
  signals: Signal[],
  source: 'manual' = 'manual',
) {
  const data = {
    signals,
    source,
    reviewed: true,
    updatedAt: new Date().toISOString(),
  };

  await db
    .insert(schema.messageLabels)
    .values({ ...data, messageId })
    .onConflictDoUpdate({
      target: schema.messageLabels.messageId,
      set: data,
    });

  revalidatePath('/messages');
}
