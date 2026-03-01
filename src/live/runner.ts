import { db, schema } from '../db/client.js';
import { eq, and, sql, asc } from 'drizzle-orm';
import { completeTask, failTask } from './recorder.js';
import type { Task, TaskContext } from '../db/schema.js';
import type { LLMProvider } from '../agent/providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from '../agent/providers.js';
import type { ResolvedPipelineDeps, ResolvedPendingContext } from '../pipeline/execute-resolved.js';
import { processTask as processTaskShared } from '../pipeline/process-task.js';
import { OrderManager } from '../orders/order-manager.js';
import { buildOrderCallbacks } from '../orders/build-order-callbacks.js';
import type { BrokerService } from '../broker/interface.js';
import { liveService as tsService } from '../broker/tradestation/index.js';
import { ibkrService, startWsListener, stopWsListener } from '../broker/ibkr/index.js';
import { getTrader } from '../config/traders.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { sendSystemAlert } from '../lib/alert.js';
import { checkExpiryWarnings } from '../lib/expiry-warning.js';
import { checkRiskLimits, type RiskCheckConfig, type RiskCheckDeps } from '../orders/risk-check.js';
import { getTodayStartingBalance } from '../reconciliation/daily-balance.js';
import { safeParseFloat } from '../lib/numbers.js';
import { isOpen, isClosed, notBacktest, forSymbol, forTrader, forStrategy, type PositionFilters } from '../trades/filters.js';
import { recordTrade } from '../trades/record-trade.js';
import { createEmitter } from '../decisions/emitter.js';
import { tradeToOpenPosition } from '../trades/adapters.js';
import { LIVE_RISK_DEFAULTS, MAX_CONTRACTS } from '../config/risk-defaults.js';

function selectBroker(): BrokerService {
  const broker = process.env.BROKER ?? 'tradestation';
  if (broker === 'ibkr') return ibkrService;
  if (broker === 'tradestation') return tsService;
  throw new Error(`Unknown BROKER env value: "${broker}" (expected "ibkr" or "tradestation")`);
}

const liveService = selectBroker();

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
  ...buildOrderCallbacks({
    pendingIntents,
    createScopedEmitter: (messageId) =>
      createEmitter({ messageId, taskId: undefined }),
  }),
});

// Start IBKR WebSocket listener for faster fill notifications (supplementary to polling)
if (process.env.BROKER === 'ibkr') {
  startWsListener(() => { orderManager.tick(new Date()); });
}

export function destroyOrderManager(): void {
  if (process.env.BROKER === 'ibkr') stopWsListener();
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

  currentTaskPromise = handleTask(task);
  await currentTaskPromise;
  currentTaskPromise = null;
}

async function handleTask(task: Task): Promise<void> {
  console.log(`[Runner] Processing task ${task.id} (${task.taskType})`);

  try {
    const context = (task.context || {}) as TaskContext;
    const provider = await getProvider();

    // Write model info to task
    await db.update(schema.tasks)
      .set({ modelProvider: DEFAULT_TRADE_MODEL.provider, modelName: DEFAULT_TRADE_MODEL.model })
      .where(eq(schema.tasks.id, task.id));

    // Build live-specific risk + pipeline deps
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
          strategy: input.strategy,
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

    const emitter = createEmitter({
      messageId: task.messageId!,
      taskId: task.id,
    });

    await processTaskShared(task, {
      getPositions: async (symbol) => {
        const filters: PositionFilters = symbol ? { symbol } : {};
        const rows = await getOpenPositions({ ...filters, trader: context.author ?? undefined });
        return rows.map(tradeToOpenPosition);
      },
      llm: provider,
      pipeline: pipelineDeps,
      emitter,
      onResult: async (result) => {
        await completeTask(task.id, { outcome: result.outcome });
        console.log(`[Runner] Task ${task.id} completed: ${result.outcome}`);
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failTask(task.id, msg);
    throw err;
  }
}
