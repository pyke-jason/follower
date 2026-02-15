import { db, schema } from '../db/client.js';
import { eq, and, sql, asc } from 'drizzle-orm';
import { runAgent } from '../agent/trade-agent.js';
import { completeTask, failTask, recordStep } from './recorder.js';
import type { Task, TaskContext, TaskResult } from '../db/schema.js';
import { createTools } from '../agent/tool-factory.js';
import { liveService } from '../broker/tradestation.js';
import { getTrader } from '../config/traders.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { sendSystemAlert } from '../lib/alert.js';
import { checkRiskLimits } from '../orders/risk-check.js';
import { safeParseFloat } from '../lib/numbers.js';

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

    const liveTools = createTools({
      broker: liveService,
      getOpenPositions: async (filters) => {
        const conditions = [eq(schema.trades.status, 'OPEN')];
        if (filters.symbol) conditions.push(eq(schema.trades.symbol, filters.symbol));
        if (filters.trader) conditions.push(eq(schema.trades.trader, filters.trader));
        return await db.select().from(schema.trades).where(and(...conditions));
      },
      checkRiskLimits,
      calculatePositionSize: async (input) => {
        const traderConfig = await getTrader(input.trader);
        const maxAllocation = safeParseFloat(traderConfig?.maxAllocation, 5000);
        const balance = await liveService.getAccountBalance();

        const sizer = buildPositionSizer(
          traderConfig?.positionSizingConfig,
          (symbol, barsBack) => liveService.getBars({ symbol, interval: '1', barsBack }),
        );

        return await sizer.calculateSize({
          symbol: input.symbol,
          entryPrice: input.entryPrice,
          equity: balance.equity,
          maxAllocation,
          spreadMaxRisk: input.spreadMaxRisk,
        });
      },
    });

    const { steps, result, model } = await runAgent(context, liveTools);

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
      console.log(`[Runner] Task ${task.id} completed: ${result.decision}`);

      // If the agent executed a trade, record it
      if (result.decision === 'EXECUTE' && result.trade) {
        await recordTrade(task, context, result, `${model.provider}:${model.model}`);
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

async function recordTrade(task: Task, context: TaskContext, result: TaskResult, agentModel?: string): Promise<void> {
  const trade = result.trade;
  if (!trade) return;

  // 1B: Duplicate guard — skip if trade already recorded for this task
  const existingForTask = await db.select()
    .from(schema.trades)
    .where(eq(schema.trades.taskId, task.id))
    .limit(1);
  if (existingForTask.length > 0) {
    console.log(`[Runner] Trade already recorded for task ${task.id}, skipping`);
    return;
  }

  const metadata = { ...((trade.metadata as any) ?? {}), agentModel };
  const symbol = (trade.symbol as string) ?? context.symbols?.[0] ?? 'UNKNOWN';
  const trader = context.author ?? 'unknown';

  // Check for existing open position (for ADD and TRIM handling)
  const existingPositions = await db.select()
    .from(schema.trades)
    .where(and(
      eq(schema.trades.symbol, symbol),
      eq(schema.trades.trader, trader),
      eq(schema.trades.status, 'OPEN'),
    ))
    .limit(1);

  const existing = existingPositions[0];
  const actionHint = context.actionHint;
  let closeQuantity = (trade as any).closeQuantity as number | undefined;

  // TRIM: partial close — create child trade, set parent to PARTIAL
  if (actionHint === 'CLOSE' && closeQuantity && existing) {
    // 1F: closeQuantity validation — clamp to existing quantity
    const existingQty = existing.quantity ?? 1;
    if (closeQuantity > existingQty) {
      console.warn(`[Runner] closeQuantity ${closeQuantity} > existing ${existingQty}, clamping`);
      sendSystemAlert({
        title: 'Close quantity clamped',
        message: `Tried to close ${closeQuantity} of ${existingQty} ${symbol}. Clamped to ${existingQty}.`,
        severity: 'warning',
      });
      closeQuantity = existingQty;
    }

    const childId = crypto.randomUUID();
    await db.insert(schema.trades).values({
      id: childId,
      taskId: task.id,
      sourceMessageId: task.messageId ?? undefined,
      trader,
      symbol,
      direction: existing.direction,
      strategy: existing.strategy,
      legs: existing.legs,
      status: 'CLOSED',
      entryPrice: existing.entryPrice,
      exitPrice: trade.exitPrice != null ? String(trade.exitPrice) : null,
      exitPercent: existing.quantity ? closeQuantity / existing.quantity : null,
      quantity: closeQuantity,
      openedAt: existing.openedAt,
      closedAt: new Date().toISOString(),
      closeMessageId: task.messageId ?? undefined,
      parentTradeId: existing.id,
      isBacktest: false,
      metadata,
    });

    // Update parent: reduce quantity, set status to PARTIAL
    const remainingQty = (existing.quantity ?? 1) - closeQuantity;
    await db.update(schema.trades)
      .set({
        quantity: Math.max(0, remainingQty),
        status: remainingQty <= 0 ? 'CLOSED' : 'PARTIAL',
      })
      .where(eq(schema.trades.id, existing.id));

    console.log(`[Runner] Recorded partial close for ${trader}: ${symbol} (${closeQuantity} of ${existing.quantity})`);
    return;
  }

  // ADD: update existing position's quantity and avg entry price
  if (actionHint === 'OPEN' && existing) {
    const existingQty = existing.quantity ?? 1;
    const addQty = trade.quantity ?? 1;
    const existingPrice = safeParseFloat(existing.entryPrice);
    const addPrice = trade.entryPrice != null ? Number(trade.entryPrice) : 0;

    const totalQty = existingQty + addQty;
    const avgPrice = (existingPrice * existingQty + addPrice * addQty) / totalQty;

    await db.update(schema.trades)
      .set({
        quantity: totalQty,
        avgEntryPrice: String(avgPrice),
      })
      .where(eq(schema.trades.id, existing.id));

    console.log(`[Runner] Added to position for ${trader}: ${symbol} (+${addQty}, avg=${avgPrice.toFixed(2)})`);
    return;
  }

  // Default: new position
  await db.insert(schema.trades).values({
    taskId: task.id,
    sourceMessageId: task.messageId ?? undefined,
    trader,
    symbol,
    direction: (trade.direction as string) ?? context.directionHint ?? 'LONG',
    strategy: (trade.strategy as string) ?? 'STOCK',
    legs: (trade.legs as any) ?? [],
    status: 'OPEN',
    entryPrice: trade.entryPrice != null ? String(trade.entryPrice) : null,
    quantity: trade.quantity ?? 1,
    openedAt: new Date().toISOString(),
    metadata,
  });

  console.log(`[Runner] Recorded trade for ${trader}: ${symbol} ${trade.strategy}`);
}
