'use server';

import { getMessages, getMessageById, getMessagesBySymbols, getLatestIntents, getLabelsForMessages, getEnrichedMessages } from '@/lib/queries';
import { compareSignals } from '../../../src/lib/eval';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import type { Message, MessageLabel } from '../../../src/db/schema';
import type { Signal } from '../../../src/agent/schemas';
import type { TradeOutcome, MessageDecision } from '../../../src/lib/enriched-message';

export type MessageIntent = {
  id: string;
  messageId: string;
  model: string;
  version: number;
  decision: string;
  reasoning: string | null;
  signals: Signal[] | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string | null;
};

export type LabelFilter = 'labeled' | 'unlabeled' | 'mismatched' | 'needs-review';

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
  roleFilter?: 'all' | 'executed' | 'skipped';
};

export type FetchMessagesResult = {
  messages: Message[];
  intents: Record<string, MessageIntent>;
  labels: Record<string, MessageLabel>;
  enrichment: Record<string, MessageEnrichment>;
  nextCursor: string | null;
};

const PAGE_SIZE = 50;

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
  const isMismatchFilter = filters.labelFilter === 'mismatched';
  const queryLabelFilter = (isMismatchFilter ? 'labeled' : filters.labelFilter) as 'labeled' | 'unlabeled' | 'needs-review' | undefined;
  const fetchLimit = isMismatchFilter ? PAGE_SIZE * 4 : PAGE_SIZE + 1;

  const rows = await getMessages({
    authors: filters.authors,
    startDate: filters.startDate,
    endDate: filters.endDate,
    signalsOnly: filters.signalsOnly,
    labelFilter: queryLabelFilter,
    cursor: filters.cursor,
    limit: fetchLimit + 1,
  });

  if (!isMismatchFilter) {
    const hasMore = rows.length > PAGE_SIZE;
    const messages = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const nextCursor = hasMore ? messages[messages.length - 1].timestamp : null;

    const ids = messages.map((m) => m.id);
    const [intents, labels] = await Promise.all([
      getLatestIntents(ids),
      getLabelsForMessages(ids),
    ]);

    return { messages, intents, labels, enrichment: {}, nextCursor };
  }

  // Mismatched: load intents+labels for all fetched rows, then filter to mismatches
  const allIds = rows.map((m) => m.id);
  const [allIntents, allLabels] = await Promise.all([
    getLatestIntents(allIds),
    getLabelsForMessages(allIds),
  ]);

  const mismatched = rows.filter((m) => {
    const label = allLabels[m.id];
    const intent = allIntents[m.id];
    if (!label || !intent) return false;
    return !compareSignals((label.signals as Signal[]) ?? [], intent);
  });

  const hasMore = mismatched.length > PAGE_SIZE;
  const messages = hasMore ? mismatched.slice(0, PAGE_SIZE) : mismatched;
  const nextCursor = hasMore ? messages[messages.length - 1].timestamp : null;

  const intents: Record<string, MessageIntent> = {};
  const labels: Record<string, MessageLabel> = {};
  for (const m of messages) {
    if (allIntents[m.id]) intents[m.id] = allIntents[m.id];
    if (allLabels[m.id]) labels[m.id] = allLabels[m.id];
  }

  return { messages, intents, labels, enrichment: {}, nextCursor };
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

  // Also load intents + labels for the full ChatRoom experience
  const ids = messages.map((m) => m.id);
  const [intents, labels] = await Promise.all([
    getLatestIntents(ids),
    getLabelsForMessages(ids),
  ]);

  return { messages, intents, labels, enrichment, nextCursor: enrichedResult.nextCursor };
}

export async function fetchMessage(id: string): Promise<Message | null> {
  return getMessageById(id);
}

/** Fetch messages that share any symbol with the given message. */
export async function fetchRelatedMessages(
  messageId: string,
): Promise<{
  messages: Message[];
  intents: Record<string, MessageIntent>;
  labels: Record<string, MessageLabel>;
  sourceSymbols: string[];
}> {
  const source = await getMessageById(messageId);
  if (!source) return { messages: [], intents: {}, labels: {}, sourceSymbols: [] };

  const sourceSymbols = (source.symbols as string[]) ?? [];
  if (sourceSymbols.length === 0) return { messages: [source], intents: {}, labels: {}, sourceSymbols };

  const messages = await getMessagesBySymbols(sourceSymbols, 200);

  const ids = messages.map((m) => m.id);
  const [intents, labels] = await Promise.all([
    getLatestIntents(ids),
    getLabelsForMessages(ids),
  ]);

  return { messages, intents, labels, sourceSymbols };
}

// ─── Label Actions ──────────────────────────────────

/** Save label signals for a message (upsert). */
export async function saveLabel(
  messageId: string,
  signals: Signal[],
  source: 'approved' | 'manual' = 'manual',
) {
  const data = {
    signals,
    source,
    reviewed: true,
    updatedAt: new Date().toISOString(),
  };

  const existing = await db
    .select({ id: schema.messageLabels.id })
    .from(schema.messageLabels)
    .where(eq(schema.messageLabels.messageId, messageId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(schema.messageLabels)
      .set(data)
      .where(eq(schema.messageLabels.id, existing[0].id));
  } else {
    await db
      .insert(schema.messageLabels)
      .values({ ...data, messageId });
  }

  revalidatePath('/messages');
}

/** One-click approve: store intent signals as reviewed label. */
export async function approveIntent(messageId: string, intent: MessageIntent) {
  await saveLabel(messageId, (intent.signals ?? []) as Signal[], 'approved');
}
