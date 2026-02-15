'use server';

import { getMessages } from '@/lib/queries';
import type { Message } from '../../../src/db/schema';

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
): Promise<{ messages: Message[]; nextCursor: string | null }> {
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

  return { messages, nextCursor };
}
