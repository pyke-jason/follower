'use server';

import { getMessages, getMessageById, getLatestIntents, getLabelsForMessages } from '@/lib/queries';
import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import type { Message, MessageLabel } from '../../../src/db/schema';
import type { Signal } from '../../../src/agent/schemas';

export type MessageIntent = {
  id: string;
  messageId: string;
  model: string;
  version: number;
  decision: string;
  reasoning: string | null;
  signals: import('../../../src/db/schema').Signal[] | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string | null;
};

export type MessageFilters = {
  authors?: string[];
  startDate?: string;
  endDate?: string;
  signalsOnly?: boolean;
  cursor?: string;
};

const PAGE_SIZE = 50;

export async function fetchMessages(
  filters: MessageFilters
): Promise<{
  messages: Message[];
  intents: Record<string, MessageIntent>;
  labels: Record<string, MessageLabel>;
  nextCursor: string | null;
}> {
  const rows = await getMessages({
    authors: filters.authors,
    startDate: filters.startDate,
    endDate: filters.endDate,
    signalsOnly: filters.signalsOnly,
    cursor: filters.cursor,
    limit: PAGE_SIZE + 1, // fetch one extra to detect if there are more
  });

  const hasMore = rows.length > PAGE_SIZE;
  const messages = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  // Messages are ordered desc (newest first). The cursor for "older" is the
  // timestamp of the last (oldest) message in this batch.
  const nextCursor = hasMore
    ? messages[messages.length - 1].timestamp
    : null;

  const ids = messages.map((m) => m.id);
  const [intents, labels] = await Promise.all([
    getLatestIntents(ids),
    getLabelsForMessages(ids),
  ]);

  return { messages, intents, labels, nextCursor };
}

export async function fetchMessage(id: string): Promise<Message | null> {
  return getMessageById(id);
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
