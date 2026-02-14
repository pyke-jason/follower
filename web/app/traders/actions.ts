'use server';

import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export async function addTrader(formData: FormData) {
  const name = formData.get('name') as string;
  if (!name?.trim()) return;

  const strategies = (formData.get('strategies') as string || 'CDS,PDS,CALL,PUT,STOCK')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  await db.insert(schema.trackedTraders).values({
    name: name.trim(),
    enabled: true,
    strategies,
    maxAllocation: (formData.get('maxAllocation') as string) || '5000',
    maxDailyAlloc: (formData.get('maxDailyAlloc') as string) || '10000',
    notes: (formData.get('notes') as string) || null,
  });

  revalidatePath('/traders');
  revalidatePath('/');
}

export async function updateTrader(formData: FormData) {
  const name = formData.get('name') as string;
  if (!name) return;

  const strategies = (formData.get('strategies') as string || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  await db
    .update(schema.trackedTraders)
    .set({
      strategies,
      maxAllocation: (formData.get('maxAllocation') as string) || null,
      maxDailyAlloc: (formData.get('maxDailyAlloc') as string) || null,
      notes: (formData.get('notes') as string) || null,
    })
    .where(eq(schema.trackedTraders.name, name));

  revalidatePath('/traders');
}

export async function deleteTrader(formData: FormData) {
  const name = formData.get('name') as string;
  if (!name) return;

  await db
    .delete(schema.trackedTraders)
    .where(eq(schema.trackedTraders.name, name));

  revalidatePath('/traders');
  revalidatePath('/');
}

export async function toggleTrader(formData: FormData) {
  const name = formData.get('name') as string;
  const enabled = formData.get('enabled') === 'true';
  if (!name) return;

  await db
    .update(schema.trackedTraders)
    .set({ enabled: !enabled })
    .where(eq(schema.trackedTraders.name, name));

  revalidatePath('/traders');
  revalidatePath('/');
}
