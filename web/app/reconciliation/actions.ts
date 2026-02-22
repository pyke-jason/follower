'use server';

import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const ResolveAlertSchema = z.object({
  alertId: z.string().uuid(),
  reason: z.string().min(1).trim(),
});

export async function resolveAlert(formData: FormData) {
  const { alertId, reason } = ResolveAlertSchema.parse({
    alertId: formData.get('alertId'),
    reason: formData.get('reason'),
  });

  await db.update(schema.reconciliationAlerts)
    .set({
      resolved: true,
      resolvedAt: new Date().toISOString(),
      resolvedReason: reason,
    })
    .where(eq(schema.reconciliationAlerts.id, alertId));

  revalidatePath('/reconciliation');
}
