/**
 * Shared task lifecycle: complete, fail, expire.
 *
 * All task state transitions go through here — not in runners.
 * `handleTaskError` marks the task FAILED and re-throws so the caller
 * (circuit breaker / drain loop) can track failures.
 */

import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';

export async function completeTask(
  taskId: string,
  result: { outcome: string },
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
  error: string,
): Promise<void> {
  await db.update(schema.tasks)
    .set({
      status: 'FAILED',
      error,
      completedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.id, taskId));
}

export async function expireTask(
  taskId: string,
  reason: string,
): Promise<void> {
  await db.update(schema.tasks)
    .set({
      status: 'EXPIRED',
      error: reason,
      completedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.id, taskId));
}

/**
 * Handle a task-level error: mark FAILED and re-throw.
 *
 * Always re-throws so the caller (drain loop / circuit breaker) can track failures.
 */
export async function handleTaskError(taskId: string, err: unknown): Promise<never> {
  const msg = err instanceof Error ? err.message : String(err);
  await failTask(taskId, msg);
  throw err;
}
