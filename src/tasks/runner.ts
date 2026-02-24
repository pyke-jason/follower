import { db, schema } from '../db/client.js';
import { eq, and, sql, asc } from 'drizzle-orm';
import { prefetchForAgent } from '../agent/prefetch.js';
import { shouldSkipDeterministic } from '../agent/deterministic-skips.js';
import { completeTask, failTask } from './recorder.js';
import type { Task, TaskContext, Message } from '../db/schema.js';
import type { TradeLeg } from '../db/schema.js';
import type { LLMProvider } from '../agent/providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from '../agent/providers.js';
import { resolveOrchestrator } from '../intents/orchestrator/index.js';
import type { OrchestratorContext, OpenPosition } from '../intents/orchestrator/types.js';
import { executeResolvedSignals } from '../pipeline/execute-resolved.js';
import type { ResolvedPipelineDeps, ResolvedPendingContext } from '../pipeline/execute-resolved.js';
import { OrderManager } from '../orders/order-manager.js';
import { liveService } from '../broker/tradestation.js';
import { getTrader } from '../config/traders.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { sendSystemAlert } from '../lib/alert.js';
import { alertIfSkippedWithActivePosition } from '../lib/skip-position-alert.js';
import { checkExpiryWarnings } from '../lib/expiry-warning.js';
import { checkRiskLimits, type RiskCheckConfig, type RiskCheckDeps } from '../orders/risk-check.js';
import { getTodayStartingBalance } from '../reconciliation/daily-balance.js';
import { safeParseFloat } from '../lib/numbers.js';
import { isOpen, isClosed, notBacktest, forSymbol, forTrader, forStrategy, type PositionFilters } from '../trades/filters.js';
import { recordTrade } from '../trades/record-trade.js';
import { getRecentChatMessages, formatChatContext } from '../intents/trader-context.js';
import { LIVE_RISK_DEFAULTS, MAX_CONTRACTS } from '../config/risk-defaults.js';

const riskConfig: RiskCheckConfig = { ...LIVE_RISK_DEFAULTS };

// ─── Lazy LLM provider (single instance reused across tasks) ───

let _provider: LLMProvider | null = null;
async function getProvider(): Promise<LLMProvider> {
  if (!_provider) _provider = await createProvider(DEFAULT_TRADE_MODEL);
  return _provider;
}

// ─── Order Manager (shared across tasks, persists working orders) ───

const pendingIntents = new Map<string, ResolvedPendingContext>();

const orderManager = new OrderManager({
  broker: liveService,
  clock: () => new Date(),
  onFill: async (order) => {
    const pending = pendingIntents.get(order.orderId);
    if (!pending) return;
    pendingIntents.delete(order.orderId);
    await pending.recordFill(order.filledPrice, order.filledAt);
  },
  onCancel: (order) => {
    pendingIntents.delete(order.orderId);
  },
});

export function destroyOrderManager(): void {
  orderManager.destroy();
  pendingIntents.clear();
}

const getOpenPositions = async (filters: PositionFilters = {}) => {
  const conditions = [isOpen, notBacktest];
  if (filters.symbol) conditions.push(forSymbol(filters.symbol));
  if (filters.trader) conditions.push(forTrader(filters.trader));
  if (filters.strategy) conditions.push(forStrategy(filters.strategy));
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

/** Throttle expiry checks to once per 5 minutes. */
let lastExpiryCheck = 0;
const EXPIRY_CHECK_INTERVAL = 5 * 60 * 1000;

async function processPendingTasks(): Promise<void> {
  // Layer 3: Periodically check for positions approaching expiration
  if (Date.now() - lastExpiryCheck > EXPIRY_CHECK_INTERVAL) {
    lastExpiryCheck = Date.now();
    checkExpiryWarnings(() => getOpenPositions()).catch(() => {});
  }

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
      });
    } catch (err) {
      console.warn(`[Runner] Prefetch failed for task ${task.id}: ${err instanceof Error ? err.message : err}`);
    }

    // Deterministic pre-checks — skip without agent call if safe
    const skip = shouldSkipDeterministic(context, prefetched, {
      maxOnSymbol: riskConfig.maxOnSymbol,
      maxTotalPositions: riskConfig.maxTotalPositions,
    });
    if (skip) {
      // Layer 2: Alert if skipping a message where trader has an active position
      alertIfSkippedWithActivePosition({
        context,
        prefetched,
        skipReason: `[deterministic] ${skip.reason}`,
        messageId: task.messageId ?? '',
        taskId: task.id,
      }).catch(() => {});
      await completeTask(task.id, { decision: 'SKIP', reasoning: `[deterministic] ${skip.reason}` });
      console.log(`[Runner] Task ${task.id} skipped (deterministic): ${skip.reason}`);
      return;
    }

    // Fetch Message row for orchestrator
    const [message] = await db.select().from(schema.messages)
      .where(eq(schema.messages.id, task.messageId!))
      .limit(1) as Message[];

    if (!message) {
      await failTask(task.id, `Message ${task.messageId} not found`);
      console.log(`[Runner] Task ${task.id} failed: message not found`);
      return;
    }

    // Build orchestrator context from message + live providers
    const traderConfig = await getTrader(context.author ?? '');
    const orchCtx: OrchestratorContext = {
      messageId: message.id,
      rawHtml: message.rawHtml,
      cleanText: message.cleanText,
      badges: (message.badges as string[]) ?? [],
      symbols: (message.symbols as string[]) ?? [],
      timestamp: message.timestamp,
      author: message.author,
      marketData: {
        getQuote: (symbol) => liveService.getQuote(symbol),
        getOptionChain: async () => null, // live chain not yet wired
        getExpiryDates: async () => [],   // live expiry dates not yet wired
      },
      positions: {
        getPositions: async (symbol) => {
          const filters: PositionFilters = symbol ? { symbol } : {};
          const rows = await getOpenPositions({ ...filters, trader: context.author ?? undefined });
          return rows.map(tradeToOpenPosition);
        },
      },
      chatHistory: {
        getRecentMessages: async (author, limit) => {
          const messages = await getRecentChatMessages(message.timestamp, author, limit);
          return formatChatContext(messages);
        },
      },
      traderConfig: {
        strategies: traderConfig?.strategies ?? [],
        notes: traderConfig?.notes ?? null,
      },
    };

    // Resolve via orchestrator
    const provider = await getProvider();
    const orchResult = await resolveOrchestrator(orchCtx, provider);

    // Write model info to task
    await db.update(schema.tasks)
      .set({ modelProvider: DEFAULT_TRADE_MODEL.provider, modelName: DEFAULT_TRADE_MODEL.model })
      .where(eq(schema.tasks.id, task.id));

    if (orchResult.outcome === 'SKIP') {
      alertIfSkippedWithActivePosition({
        context,
        prefetched,
        skipReason: orchResult.reason,
        messageId: task.messageId ?? '',
        taskId: task.id,
      }).catch(() => {});
      await completeTask(task.id, { decision: 'SKIP', reasoning: orchResult.reason });
      console.log(`[Runner] Task ${task.id} skipped (orchestrator): ${orchResult.reason}`);
      return;
    }

    if (orchResult.outcome === 'FLAG_FOR_REVIEW') {
      await completeTask(task.id, { decision: 'MANUAL_REVIEW', reasoning: orchResult.reason });
      console.log(`[Runner] Task ${task.id} flagged: ${orchResult.reason}`);
      return;
    }

    // EXECUTE path — resolved signals from orchestrator
    const resolvedSignals = orchResult.signals;
    if (resolvedSignals.length === 0) {
      await completeTask(task.id, { decision: 'SKIP', reasoning: 'Orchestrator returned empty signals' });
      console.log(`[Runner] Task ${task.id} completed: no signals`);
      return;
    }

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

    const pipelineDeps: ResolvedPipelineDeps = {
      broker: liveService,
      orderManager,
      calculatePositionSize: async (input) => {
        const tc = await getTrader(input.trader);
        const balance = await liveService.getAccountBalance();
        const sizer = buildPositionSizer(tc?.positionSizingConfig);
        return sizer.calculateSize({
          symbol: input.symbol,
          entryPrice: input.entryPrice,
          equity: balance.equity,
          maxQuantity: MAX_CONTRACTS[input.strategy],
        });
      },
      checkRiskLimits: (input) => checkRiskLimits(input, riskDeps, riskConfig),
      recordTrade: (input) => recordTrade({
        ...input,
        taskId: task.id,
        isBacktest: false,
      }),
      onPending: (orderId, ctx) => {
        pendingIntents.set(orderId, ctx);
      },
    };

    const pipelineResults = await executeResolvedSignals(
      resolvedSignals,
      context.author ?? 'unknown',
      pipelineDeps,
      {
        messageId: task.messageId ?? undefined,
        taskId: task.id,
      },
    );

    const executedTrades = pipelineResults.filter(r => r.executed);
    const tradeIds = executedTrades.map(r => r.tradeId).filter(Boolean);

    await completeTask(task.id, { decision: 'EXECUTE', reasoning: `${resolvedSignals.length} signal(s) resolved` });
    console.log(
      `[Runner] Task ${task.id} completed: EXECUTE` +
      (tradeIds.length > 0 ? ` (trades: ${tradeIds.map(id => id!.slice(0, 8)).join(', ')})` : '') +
      (pipelineResults.some(r => !r.executed) ? ` (some signals skipped)` : ''),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failTask(task.id, msg);
    console.error(`[Runner] Task ${task.id} failed:`, msg);
  }
}

// ─── Adapter: DB Trade → OpenPosition for orchestrator ───

function tradeToOpenPosition(row: typeof schema.trades.$inferSelect): OpenPosition {
  const legs = (row.legs as TradeLeg[]).map(leg => ({
    symbol: leg.symbol,
    side: leg.action as 'BUY' | 'SELL',
    quantity: leg.quantity ?? 1,
    expiry: leg.expiry ?? '',
    strike: leg.strike ?? 0,
    type: (leg.type === 'STOCK' ? 'stock' : 'option') as 'stock' | 'option',
    ...(leg.type !== 'STOCK' && { optionType: leg.type as 'CALL' | 'PUT' }),
  }));

  return {
    id: row.id,
    symbol: row.symbol,
    strategy: row.strategy,
    direction: row.direction,
    legs,
    quantity: row.quantity ?? 1,
  };
}
