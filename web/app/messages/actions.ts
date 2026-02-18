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

/** One-click approve: copy intent signals into a label, mark reviewed. */
export async function approveIntent(messageId: string, intent: MessageIntent) {
  const signals = (intent.signals ?? []) as Signal[];
  const signal = signals[0];
  const isTrade = intent.decision === 'EXECUTE' && signals.length > 0;

  const label = {
    isTrade,
    action: signal?.action ?? null,
    direction: signal?.direction ?? null,
    strategy: signal?.strategy ?? null,
    symbol: signal?.symbol ?? null,
    price: signal?.limitPrice ?? null,
    strikes: signal?.legs?.map((l) => parseFloat(l.strike)) ?? null,
    expiry: signal?.legs?.[0]?.expiry ?? null,
    exitPercent: signal?.exitPercent ?? null,
    source: 'approved' as const,
    reviewed: true,
    updatedAt: new Date().toISOString(),
  };

  // Upsert: insert or update on conflict
  const existing = await db
    .select({ id: schema.messageLabels.id })
    .from(schema.messageLabels)
    .where(eq(schema.messageLabels.messageId, messageId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(schema.messageLabels)
      .set(label)
      .where(eq(schema.messageLabels.id, existing[0].id));
  } else {
    await db
      .insert(schema.messageLabels)
      .values({ ...label, messageId });
  }

  revalidatePath('/messages');
}

/** Save a manually-edited label for a message (upsert). */
export async function saveIntentLabel(messageId: string, formData: FormData) {
  const strikesRaw = (formData.get('strikes') as string)?.trim();
  let strikes: number[] | null = null;
  if (strikesRaw) {
    strikes = strikesRaw.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
    if (strikes.length === 0) strikes = null;
  }

  const label = {
    isTrade: formData.get('isTrade') === 'true',
    action: (formData.get('action') as string) || null,
    direction: (formData.get('direction') as string) || null,
    strategy: (formData.get('strategy') as string) || null,
    symbol: (formData.get('symbol') as string)?.toUpperCase() || null,
    price: (formData.get('price') as string) || null,
    strikes,
    quantity: (formData.get('quantity') as string) || null,
    expiry: (formData.get('expiry') as string) || null,
    exitPercent: formData.has('exitPercent')
      ? parseFloat(formData.get('exitPercent') as string) || null
      : null,
    notes: (formData.get('notes') as string) || null,
    source: 'manual' as const,
    reviewed: true,
    updatedAt: new Date().toISOString(),
  };

  // Upsert
  const existing = await db
    .select({ id: schema.messageLabels.id })
    .from(schema.messageLabels)
    .where(eq(schema.messageLabels.messageId, messageId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(schema.messageLabels)
      .set(label)
      .where(eq(schema.messageLabels.id, existing[0].id));
  } else {
    await db
      .insert(schema.messageLabels)
      .values({ ...label, messageId });
  }

  revalidatePath('/messages');
}
