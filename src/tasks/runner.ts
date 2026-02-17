import { db, schema } from '../db/client.js';
import { eq, and, sql, asc } from 'drizzle-orm';
import { runAgent } from '../agent/trade-agent.js';
import { prefetchForAgent } from '../agent/prefetch.js';
import { shouldSkipDeterministic } from '../agent/deterministic-skips.js';
import { completeTask, failTask, recordStep } from './recorder.js';
import type { Task, TaskContext } from '../db/schema.js';
import {
  getQuoteTool,
  getOptionsChainTool,
  flagForReviewTool,
  submitDecisionTool,
  getOpenPositionsTool,
} from '../agent/tool-factory.js';
import { executeSignals } from '../pipeline/execute.js';
import type { PipelineDeps } from '../pipeline/execute.js';
import { liveService } from '../broker/tradestation.js';
import { getTrader } from '../config/traders.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { sendSystemAlert } from '../lib/alert.js';
import { checkRiskLimits, type RiskCheckConfig, type RiskCheckDeps } from '../orders/risk-check.js';
import { getTodayStartingBalance } from '../reconciliation/daily-balance.js';
import { safeParseFloat } from '../lib/numbers.js';
import { isOpen, isClosed, notBacktest, forSymbol, forTrader } from '../trades/filters.js';
import { recordTrade } from '../trades/record-trade.js';

const riskConfig: RiskCheckConfig = {
  maxOnSymbol: 5,
  maxTotalPositions: 20,
  maxDrawdownPct: 5,
  maxNotionalMultiplier: 2,
};

const getOpenPositions = async (filters: { symbol?: string; trader?: string } = {}) => {
  const conditions = [isOpen, notBacktest];
  if (filters.symbol) conditions.push(forSymbol(filters.symbol));
  if (filters.trader) conditions.push(forTrader(filters.trader));
  return db.select().from(schema.trades).where(and(...conditions));
};

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

  try {
    const context = (task.context || {}) as TaskContext;

    // Prefetch quotes, positions, and trader profile before the agent call.
    let prefetched;
    try {
      prefetched = await prefetchForAgent(context, {
        broker: liveService,
        getOpenPositions,
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

    // Classification-only tools — no execution capabilities
    const classificationTools = [
      getQuoteTool(liveService),
      getOptionsChainTool(liveService),
      flagForReviewTool(),
      submitDecisionTool(),
      getOpenPositionsTool(getOpenPositions),
    ];

    // Run classification agent
    const { steps, result, model } = await runAgent(context, classificationTools, undefined, prefetched);

    // Write model info to task
    await db.update(schema.tasks)
      .set({ modelProvider: model.provider, modelName: model.model })
      .where(eq(schema.tasks.id, task.id));

    // Record each agent step
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

    if (!result) {
      await failTask(task.id, 'Agent returned no result');
      console.log(`[Runner] Task ${task.id} failed: no result from agent`);
      return;
    }

    // Execute signals through the deterministic pipeline
    if (result.decision === 'EXECUTE' && result.signals && result.signals.length > 0) {
      const riskDeps: RiskCheckDeps = {
        getOpenTrades: getOpenPositions,
        getDailyClosedPnl: async () => {
          const res = await db.select({
            total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
          }).from(schema.trades).where(and(
            isClosed, notBacktest,
            sql`closed_at >= date('now')`,
          ));
          return safeParseFloat(res[0]?.total);
        },
        getStartingEquity: async () => {
          const bal = await getTodayStartingBalance();
          return bal?.equity ?? null;
        },
        getCurrentEquity: async () => {
          const balance = await liveService.getAccountBalance();
          return balance.equity;
        },
        getReconciliationAlertCount: async () => {
          const alerts = await db.select({ count: sql<number>`COUNT(*)` })
            .from(schema.reconciliationAlerts)
            .where(and(
              eq(schema.reconciliationAlerts.resolved, false),
              eq(schema.reconciliationAlerts.type, 'DB_ONLY'),
            ));
          return alerts[0]?.count ?? 0;
        },
      };

      const pipelineDeps: PipelineDeps = {
        broker: liveService,
        getOpenPositions,
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
        checkRiskLimits: (input) => checkRiskLimits(input, riskDeps, riskConfig),
        recordTrade: (input) => recordTrade({
          ...input,
          taskId: task.id,
          isBacktest: false,
        }),
      };

      const pipelineResults = await executeSignals(
        result.signals,
        context.author ?? 'unknown',
        pipelineDeps,
        { messageId: task.messageId ?? undefined, taskId: task.id },
      );

      const executedTrades = pipelineResults.filter(r => r.executed);
      const tradeIds = executedTrades.map(r => r.tradeId).filter(Boolean);

      await completeTask(task.id, result);
      console.log(
        `[Runner] Task ${task.id} completed: ${result.decision}` +
        (tradeIds.length > 0 ? ` (trades: ${tradeIds.map(id => id!.slice(0, 8)).join(', ')})` : '') +
        (pipelineResults.some(r => !r.executed) ? ` (some signals skipped)` : ''),
      );
    } else {
      await completeTask(task.id, result);
      console.log(`[Runner] Task ${task.id} completed: ${result.decision}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failTask(task.id, msg);
    console.error(`[Runner] Task ${task.id} failed:`, msg);
  }
}
