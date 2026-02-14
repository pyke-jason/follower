import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { runAgent } from '../agent/trade-agent.js';
import { startTask, completeTask, failTask, recordStep } from './recorder.js';
import type { Task, TaskContext, TaskResult } from '../db/schema.js';

const POLL_INTERVAL = 3000; // 3 seconds
let running = false;

export async function startTaskRunner(): Promise<void> {
  if (running) return;
  running = true;
  console.log('[Runner] Started polling for tasks...');

  while (running) {
    try {
      await processPendingTasks();
    } catch (err) {
      console.error('[Runner] Error in poll loop:', err);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

export function stopTaskRunner(): void {
  running = false;
  console.log('[Runner] Stopped');
}

async function processPendingTasks(): Promise<void> {
  const pendingTasks = await db.select()
    .from(schema.tasks)
    .where(eq(schema.tasks.status, 'PENDING'))
    .limit(1);

  for (const task of pendingTasks) {
    await processTask(task);
  }
}

async function processTask(task: Task): Promise<void> {
  console.log(`[Runner] Processing task ${task.id} (${task.taskType})`);
  await startTask(task.id);

  try {
    const context = (task.context || {}) as TaskContext;
    const { steps, result } = await runAgent(context);

    // Record each step
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      await recordStep(task.id, i + 1, {
        toolName: step.tool ?? undefined,
        toolInput: step.input ?? undefined,
        toolOutput: step.output ?? undefined,
        reasoning: step.reasoning ?? undefined,
        durationMs: step.durationMs ?? undefined,
      });
    }

    if (result) {
      await completeTask(task.id, result);
      console.log(`[Runner] Task ${task.id} completed: ${result.decision}`);

      // If the agent executed a trade, record it
      if (result.decision === 'EXECUTE' && result.trade) {
        await recordTrade(task, context, result);
      }
    } else {
      await failTask(task.id, 'Agent returned no result');
      console.log(`[Runner] Task ${task.id} failed: no result from agent`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failTask(task.id, msg);
    console.error(`[Runner] Task ${task.id} failed:`, msg);
  }
}

async function recordTrade(task: Task, context: TaskContext, result: TaskResult): Promise<void> {
  const trade = result.trade;
  if (!trade) return;

  await db.insert(schema.trades).values({
    taskId: task.id,
    sourceMessageId: task.messageId ?? undefined,
    trader: context.author ?? 'unknown',
    symbol: (trade.symbol as string) ?? context.symbols?.[0] ?? 'UNKNOWN',
    direction: (trade.direction as string) ?? context.directionHint ?? 'LONG',
    strategy: (trade.strategy as string) ?? 'STOCK',
    legs: (trade.legs as any) ?? [],
    status: 'OPEN',
    entryPrice: trade.entryPrice != null ? String(trade.entryPrice) : null,
    quantity: trade.quantity ?? 1,
    openedAt: new Date().toISOString(),
    metadata: (trade.metadata as any) ?? {},
  });

  console.log(`[Runner] Recorded trade for ${context.author}: ${trade.symbol} ${trade.strategy}`);
}
