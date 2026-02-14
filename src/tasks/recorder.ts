import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import type { TaskResult } from '../db/schema.js';

export async function recordStep(
  taskId: string,
  stepNumber: number,
  step: {
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: unknown;
    reasoning?: string;
    durationMs?: number;
  }
): Promise<void> {
  await db.insert(schema.taskSteps).values({
    taskId,
    stepNumber,
    toolName: step.toolName ?? null,
    toolInput: step.toolInput ?? null,
    toolOutput: step.toolOutput ?? null,
    reasoning: step.reasoning ?? null,
    durationMs: step.durationMs ?? null,
  });
}

export async function completeTask(
  taskId: string,
  result: TaskResult
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
