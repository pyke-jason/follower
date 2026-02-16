'use server';

import { db, schema } from '@/lib/db';
import { eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

const DEFAULT_STRATEGIES = ['CDS', 'PDS', 'CALL', 'PUT', 'STOCK'];

function refresh() {
  revalidatePath('/traders');
  revalidatePath('/');
}

export async function quickAdd(name: string) {
  if (!name?.trim()) return;
  await db.insert(schema.trackedTraders).values({
    name: name.trim(),
    enabled: true,
    strategies: DEFAULT_STRATEGIES,
    notes: null,
  });
  refresh();
}

export async function removeTrader(name: string) {
  if (!name) return;
  await db
    .delete(schema.trackedTraders)
    .where(eq(schema.trackedTraders.name, name));
  refresh();
}

export async function toggleEnabled(name: string, currentlyEnabled: boolean) {
  if (!name) return;
  await db
    .update(schema.trackedTraders)
    .set({ enabled: !currentlyEnabled })
    .where(eq(schema.trackedTraders.name, name));
  refresh();
}

export async function setStrategies(name: string, strategies: string[]) {
  if (!name) return;
  await db
    .update(schema.trackedTraders)
    .set({ strategies })
    .where(eq(schema.trackedTraders.name, name));
  refresh();
}

export async function setNotes(name: string, notes: string | null) {
  if (!name) return;
  await db
    .update(schema.trackedTraders)
    .set({ notes: notes || null })
    .where(eq(schema.trackedTraders.name, name));
  refresh();
}

export async function bulkAdd(names: string[]) {
  const valid = names.map((n) => n.trim()).filter(Boolean);
  if (!valid.length) return;
  await db.insert(schema.trackedTraders).values(
    valid.map((name) => ({
      name,
      enabled: true,
      strategies: DEFAULT_STRATEGIES,
      notes: null,
    })),
  );
  refresh();
}

export async function bulkRemove(names: string[]) {
  if (!names.length) return;
  await db
    .delete(schema.trackedTraders)
    .where(inArray(schema.trackedTraders.name, names));
  refresh();
}
