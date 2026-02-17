'use server';

import { getMessages, getMessageById, getLatestIntents } from '@/lib/queries';
import type { Message } from '../../../src/db/schema';

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

  const intents = await getLatestIntents(messages.map((m) => m.id));

  return { messages, intents, nextCursor };
}

export async function fetchMessage(id: string): Promise<Message | null> {
  return getMessageById(id);
}
