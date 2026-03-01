import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';

export async function completeTask(
  taskId: string,
  result: { outcome: string }
): Promise<void> {
  await db.update(schema.tasks)
    .set({
      status: 'COMPLETED',
      result,
      completedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.id, taskId));
}

export async function failTask(
  taskId: string,
  error: string
): Promise<void> {
  await db.update(schema.tasks)
    .set({
      status: 'FAILED',
      error,
      completedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.id, taskId));
}

export async function startTask(taskId: string): Promise<void> {
  await db.update(schema.tasks)
    .set({
      status: 'IN_PROGRESS',
      startedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.id, taskId));
}

