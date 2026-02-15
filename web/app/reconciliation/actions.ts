'use server';

import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export async function resolveAlert(formData: FormData) {
  const alertId = formData.get('alertId') as string;
  const reason = formData.get('reason') as string;

  if (!alertId || !reason) return;

  await db.update(schema.reconciliationAlerts)
    .set({
      resolved: true,
      resolvedAt: new Date().toISOString(),
      resolvedReason: reason,
    })
    .where(eq(schema.reconciliationAlerts.id, alertId));

  revalidatePath('/reconciliation');
}
