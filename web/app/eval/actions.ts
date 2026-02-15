'use server';

import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export async function saveLabel(formData: FormData) {
  const id = formData.get('id') as string;
  if (!id) return;

  const strikesRaw = (formData.get('strikes') as string)?.trim();
  let strikes: number[] | null = null;
  if (strikesRaw) {
    strikes = strikesRaw.split(',').map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
    if (strikes.length === 0) strikes = null;
  }

  await db
    .update(schema.messageLabels)
    .set({
      isTrade: formData.get('isTrade') === 'true',
      action: (formData.get('action') as string) || null,
      direction: (formData.get('direction') as string) || null,
      strategy: (formData.get('strategy') as string) || null,
      symbol: (formData.get('symbol') as string)?.toUpperCase() || null,
      price: (formData.get('price') as string) || null,
      strikes,
      quantity: (formData.get('quantity') as string) || null,
      expiry: (formData.get('expiry') as string) || null,
      notes: (formData.get('notes') as string) || null,
      reviewed: true,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.messageLabels.id, id));

  revalidatePath('/eval');
}

export async function approveLabel(formData: FormData) {
  const id = formData.get('id') as string;
  if (!id) return;

  await db
    .update(schema.messageLabels)
    .set({
      reviewed: true,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.messageLabels.id, id));

  revalidatePath('/eval');
}

export async function deleteLabel(formData: FormData) {
  const id = formData.get('id') as string;
  if (!id) return;

  await db
    .delete(schema.messageLabels)
    .where(eq(schema.messageLabels.id, id));

  revalidatePath('/eval');
}
