import { db, schema } from '../db/client.js';
import { eq, and, sql, asc } from 'drizzle-orm';
import { runAgent } from '../agent/trade-agent.js';
import { prefetchForAgent } from '../agent/prefetch.js';
import { shouldSkipDeterministic } from '../agent/deterministic-skips.js';
import { completeTask, failTask, recordStep } from './recorder.js';
import type { Task, TaskContext } from '../db/schema.js';
import { createTools } from '../agent/tool-factory.js';
import { liveService } from '../broker/tradestation.js';
import { getTrader } from '../config/traders.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { sendSystemAlert } from '../lib/alert.js';
import { checkRiskLimits } from '../orders/risk-check.js';
import { recordTrade } from '../trades/record-trade.js';

const POLL_INTERVAL = 3000; // 3 seconds
let running = false;
let currentTaskPromise: Promise<void> | null = null;

export async function startTaskRunner(): Promise<void> {
  if (running) return;
  running = true;
  console.log('[Runner] Started polling for tasks...');

  // 1D: Stale IN_PROGRESS recovery on startup
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const requeued = await db.update(schema.tasks)
    .set({ status: 'PENDING', startedAt: null })
    .where(and(
      eq(schema.tasks.status, 'IN_PROGRESS'),
      sql`started_at < ${staleThreshold}`,
    ))
    .returning();
  if (requeued.length > 0) {
    console.warn(`[Runner] Re-queued ${requeued.length} stale IN_PROGRESS task(s)`);
  }

  while (running) {
    try {
      await processPendingTasks();
    } catch (err) {
      console.error('[Runner] Error in poll loop:', err);
      sendSystemAlert({
        title: 'Task runner poll error',
        message: `Poll loop threw: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      });
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

export function stopTaskRunner(): void {
  running = false;
  console.log('[Runner] Stopped');
}

/** Wait for the currently in-flight task to complete (used by graceful shutdown). */
export async function awaitCurrentTask(): Promise<void> {
  if (currentTaskPromise) await currentTaskPromise;
}

async function processPendingTasks(): Promise<void> {
  // Phase 2: Atomic task claim — transaction SELECT+UPDATE avoids race
  const claimed = await db.transaction(async (tx) => {
    const [pending] = await tx.select()
      .from(schema.tasks)
      .where(eq(schema.tasks.status, 'PENDING'))
      .orderBy(asc(schema.tasks.createdAt))
      .limit(1);

    if (!pending) return [];

    const now = new Date().toISOString();
    return await tx.update(schema.tasks)
      .set({ status: 'IN_PROGRESS', startedAt: now })
      .where(eq(schema.tasks.id, pending.id))
      .returning();
  });

  if (claimed.length === 0) return;
  const task = claimed[0];

  currentTaskPromise = processTask(task);
  await currentTaskPromise;
  currentTaskPromise = null;
}

async function processTask(task: Task): Promise<void> {
  console.log(`[Runner] Processing task ${task.id} (${task.taskType})`);
  // No startTask() call needed — atomic claim already set IN_PROGRESS + started_at

  try {
    const context = (task.context || {}) as TaskContext;

    // Prefetch quotes, positions, and trader profile before the agent call.
    // If prefetch fails entirely, we fall back to the original flow (agent fetches its own data).
    let prefetched;
    try {
      prefetched = await prefetchForAgent(context, {
        broker: liveService,
        getOpenPositions: async (filters) => {
          const conditions = [eq(schema.trades.status, 'OPEN'), eq(schema.trades.isBacktest, false)];
          if (filters.symbol) conditions.push(eq(schema.trades.symbol, filters.symbol));
          if (filters.trader) conditions.push(eq(schema.trades.trader, filters.trader));
          return await db.select().from(schema.trades).where(and(...conditions));
        },
        getTraderConfig: getTrader,
      });
    } catch (err) {
      console.warn(`[Runner] Prefetch failed for task ${task.id}: ${err instanceof Error ? err.message : err}`);
    }

    // Deterministic pre-checks — skip without agent call if safe
    const skip = shouldSkipDeterministic(context, prefetched, {
      maxOnSymbol: 5,
      maxTotalPositions: 20,
    });
    if (skip) {
      await completeTask(task.id, { decision: 'SKIP', reasoning: `[deterministic] ${skip.reason}` });
      console.log(`[Runner] Task ${task.id} skipped (deterministic): ${skip.reason}`);
      return;
    }

    // Track trade recorded via onFill callback
    let recordedTradeId: string | undefined;

    const liveTools = createTools({
      broker: liveService,
      getOpenPositions: async (filters) => {
        const conditions = [eq(schema.trades.status, 'OPEN'), eq(schema.trades.isBacktest, false)];
        if (filters.symbol) conditions.push(eq(schema.trades.symbol, filters.symbol));
        if (filters.trader) conditions.push(eq(schema.trades.trader, filters.trader));
        return await db.select().from(schema.trades).where(and(...conditions));
      },
      checkRiskLimits,
      calculatePositionSize: async (input) => {
        const traderConfig = await getTrader(input.trader);
        const balance = await liveService.getAccountBalance();

        const sizer = buildPositionSizer(
          traderConfig?.positionSizingConfig,
          (symbol, barsBack) => liveService.getBars({ symbol, interval: '1', barsBack }),
        );

        return await sizer.calculateSize({
          symbol: input.symbol,
          entryPrice: input.entryPrice,
          equity: balance.equity,
          spreadMaxRisk: input.spreadMaxRisk,
        });
      },
      onFill: async (fill) => {
        const trader = context.author ?? 'unknown';
        const actionHint = context.actionHint;
        const action: 'OPEN' | 'CLOSE' = actionHint === 'CLOSE' ? 'CLOSE' : 'OPEN';

        // Duplicate guard — skip if trade already recorded for this task
        const existingForTask = await db.select()
          .from(schema.trades)
          .where(eq(schema.trades.taskId, task.id))
          .limit(1);
        if (existingForTask.length > 0) {
          console.log(`[Runner] Trade already recorded for task ${task.id}, skipping`);
          return null;
        }

        const result = await recordTrade({
          action,
          symbol: fill.symbol,
          trader,
          direction: fill.direction,
          strategy: fill.strategy,
          entryPrice: action === 'CLOSE' ? undefined : fill.filledPrice,
          exitPrice: action === 'CLOSE' ? fill.filledPrice : undefined,
          quantity: fill.quantity,
          legs: fill.legs,
          sourceMessageId: task.messageId ?? undefined,
          closeMessageId: action === 'CLOSE' ? (task.messageId ?? undefined) : undefined,
          taskId: task.id,
          isBacktest: false,
        });
        if (result) recordedTradeId = result.tradeId;
        return result ? { tradeId: result.tradeId } : null;
      },
    });

    const { steps, result, model } = await runAgent(context, liveTools, undefined, prefetched);

    // Write model info to task
    await db.update(schema.tasks)
      .set({ modelProvider: model.provider, modelName: model.model })
      .where(eq(schema.tasks.id, task.id));

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
      console.log(`[Runner] Task ${task.id} completed: ${result.decision}${recordedTradeId ? ` (trade ${recordedTradeId.slice(0, 8)})` : ''}`);
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

