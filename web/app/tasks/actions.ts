'use server';

import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export async function skipTask(formData: FormData) {
  const taskId = formData.get('taskId') as string;
  if (!taskId) return;

  await db
    .update(schema.tasks)
    .set({
      status: 'SKIPPED',
      completedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.id, taskId));

  revalidatePath('/tasks');
  revalidatePath(`/tasks/${taskId}`);
  revalidatePath('/');
}
