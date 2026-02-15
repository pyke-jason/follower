import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { runAgent } from '../agent/trade-agent.js';
import { startTask, completeTask, failTask, recordStep } from './recorder.js';
import type { Task, TaskContext, TaskResult } from '../db/schema.js';
import { createTools } from '../agent/tool-factory.js';
import { liveService } from '../broker/tradestation.js';
import { getTrader } from '../config/traders.js';
import { getTodayStartingBalance } from '../reconciliation/daily-balance.js';
import { buildPositionSizer } from '../position-sizing/index.js';

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

    const liveTools = createTools({
      broker: liveService,
      getOpenPositions: async (filters) => {
        const conditions = [eq(schema.trades.status, 'OPEN')];
        if (filters.symbol) conditions.push(eq(schema.trades.symbol, filters.symbol));
        if (filters.trader) conditions.push(eq(schema.trades.trader, filters.trader));
        return await db.select().from(schema.trades).where(and(...conditions));
      },
      checkRiskLimits: async (input) => {
        const traderConfig = await db.select()
          .from(schema.trackedTraders)
          .where(eq(schema.trackedTraders.name, input.trader));

        const todayPnl = await db.select({
          total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
        })
          .from(schema.trades)
          .where(and(
            eq(schema.trades.trader, input.trader),
            sql`opened_at >= date('now')`,
          ));

        const openPositions = await db.select({
          count: sql<number>`COUNT(*)`,
        })
          .from(schema.trades)
          .where(and(
            eq(schema.trades.symbol, input.symbol),
            eq(schema.trades.status, 'OPEN'),
          ));

        const maxAlloc = traderConfig[0]?.maxAllocation
          ? parseFloat(traderConfig[0].maxAllocation)
          : null;
        const maxDailyAlloc = traderConfig[0]?.maxDailyAlloc
          ? parseFloat(traderConfig[0].maxDailyAlloc)
          : null;
        const dailyPnl = parseFloat(todayPnl[0]?.total ?? '0');

        const startingBalance = await getTodayStartingBalance();
        let currentDrawdownPct: number | undefined;
        if (startingBalance && startingBalance.equity > 0) {
          currentDrawdownPct = Math.round((Math.abs(dailyPnl) / startingBalance.equity) * 10000) / 100;
        }

        const allowed = (
          (!maxDailyAlloc || Math.abs(dailyPnl) < maxDailyAlloc) &&
          (openPositions[0]?.count ?? 0) < 5
        );

        return {
          allowed,
          traderDailyPnl: dailyPnl,
          openPositionsOnSymbol: openPositions[0]?.count ?? 0,
          traderMaxAllocation: maxAlloc,
          traderMaxDailyAllocation: maxDailyAlloc,
          startingEquity: startingBalance?.equity,
          currentDrawdownPct,
        };
      },
      calculatePositionSize: async (input) => {
        const traderConfig = await getTrader(input.trader);
        const maxAllocation = traderConfig?.maxAllocation ? parseFloat(traderConfig.maxAllocation) : 5000;
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

  const metadata = { ...((trade.metadata as any) ?? {}), agentModel };

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
    metadata,
  });

  console.log(`[Runner] Recorded trade for ${context.author}: ${trade.symbol} ${trade.strategy}`);
}
