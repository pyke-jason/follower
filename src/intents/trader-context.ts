import { db, schema } from '../db/client.js';
import { eq, and, lt, desc } from 'drizzle-orm';
import type { Message } from '../db/schema.js';
import { htmlToLLMText } from '../parsing/html.js';
import { isoToDateKey } from '../lib/et-date.js';

/**
 * Fetch the last N messages from a trader before a given timestamp.
 * Provides chat-room context so the intent extraction agent can infer
 * what positions the trader holds (e.g. "exit CDS" → which CDS?).
 *
 * This replaces `get_open_positions` in Phase 1 — the agent reads
 * recent messages like a human would, instead of querying simulated positions.
 */
export async function getRecentTraderMessages(
  trader: string,
  beforeTimestamp: string,
  limit = 15,
): Promise<Message[]> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.author, trader),
        lt(schema.messages.timestamp, beforeTimestamp),
      ),
    )
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit);

  // Return in chronological order (oldest first)
  return rows.reverse();
}

/**
 * Fetch the last N messages from the chat room (all authors) before a timestamp.
 * Optionally filter to a specific author.
 *
 * Used as a tool call when the agent detects follow-trade patterns:
 * "following Dave on this one", "@spectre same trade", bare entries
 * seconds after another trader's call on the same symbol, etc.
 */
export async function getRecentChatMessages(
  beforeTimestamp: string,
  author?: string,
  limit = 20,
): Promise<Message[]> {
  const conditions = [lt(schema.messages.timestamp, beforeTimestamp)];
  if (author) {
    conditions.push(eq(schema.messages.author, author));
  }

  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(...conditions))
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit);

  return rows.reverse();
}

/**
 * Format recent messages as plain text for injection into the agent prompt.
 */
export function formatTraderContext(messages: Message[]): string {
  if (messages.length === 0) return 'No recent messages from this trader.';

  const lines = messages.map((m) => {
    const time = m.timestamp.split('T')[1]?.slice(0, 5) ?? '';
    const date = isoToDateKey(m.timestamp);
    const text = (htmlToLLMText(m.rawHtml)).slice(0, 200);
    return `  ${date} ${time} | ${text}`;
  });

  return `Recent messages from ${messages[0].author} (${messages.length} messages, oldest first):\n${lines.join('\n')}`;
}

/**
 * Format chat messages (potentially multi-author) as plain text.
 */
export function formatChatContext(messages: Message[]): string {
  if (messages.length === 0) return 'No recent chat messages.';

  const lines = messages.map((m) => {
    const time = m.timestamp.split('T')[1]?.slice(0, 5) ?? '';
    const text = (htmlToLLMText(m.rawHtml)).slice(0, 200);
    return `  ${time} | ${m.author}: ${text}`;
  });

  return `Recent chat messages (${messages.length} messages, oldest first):\n${lines.join('\n')}`;
}
