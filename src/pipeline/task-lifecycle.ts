/**
 * Shared task lifecycle: complete, fail, requeue.
 *
 * All task state transitions go through here — not in runners.
 * `handleTaskError` classifies errors (transient → requeue, permanent → fail)
 * so runners don't embed error handling logic.
 */

import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { BrokerTransientError } from '../lib/errors.js';

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

export async function requeueTask(taskId: string): Promise<void> {
  await db.update(schema.tasks)
    .set({ status: 'PENDING', startedAt: null })
    .where(eq(schema.tasks.id, taskId));
}

/**
 * Classify and handle a task-level error.
 * - BrokerTransientError → requeue for retry
 * - Everything else → mark FAILED
 *
 * Always re-throws so the caller (poll loop / circuit breaker) can track failures.
 */
export async function handleTaskError(taskId: string, err: unknown): Promise<never> {
  if (err instanceof BrokerTransientError) {
    await requeueTask(taskId);
    console.warn(`[TaskLifecycle] Task ${taskId} requeued (broker transient): ${err.message}`);
    throw err;
  }
  const msg = err instanceof Error ? err.message : String(err);
  await failTask(taskId, msg);
  throw err;
}
