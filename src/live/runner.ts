import { db, schema } from '../db/client.js';
import { eq, and, sql, asc } from 'drizzle-orm';
import { completeTask, handleTaskError } from '../pipeline/task-lifecycle.js';
import type { Task } from '../db/schema.js';
import { createProvider, DEFAULT_TRADE_MODEL } from '../agent/providers.js';
import type { LLMProvider } from '../agent/providers.js';
import { processTask as processTaskShared } from '../pipeline/process-task.js';
import { liveService as tsService } from '../broker/tradestation/index.js';
import { ibkrService, startWsListener, stopWsListener } from '../broker/ibkr/index.js';
import { sendSystemAlert } from '../lib/alert.js';
import { checkExpiryWarnings } from '../lib/expiry-warning.js';
import { LIVE_RISK_DEFAULTS } from '../config/risk-defaults.js';
import { BrokerCircuitBreaker } from '../lib/circuit-breaker.js';
import { buildPipelineDeps } from '../pipeline/build-deps.js';
import type { BrokerService } from '../broker/interface.js';

function selectBroker(): BrokerService {
  const broker = process.env.BROKER ?? 'tradestation';
  if (broker === 'ibkr') return ibkrService;
  if (broker === 'tradestation') return tsService;
  throw new Error(`Unknown BROKER env value: "${broker}" (expected "ibkr" or "tradestation")`);
}

const liveService = selectBroker();

// ─── Lazy LLM provider (single instance reused across tasks) ───

let _provider: LLMProvider | null = null;
async function getProvider(): Promise<LLMProvider> {
  if (!_provider) _provider = await createProvider(DEFAULT_TRADE_MODEL);
  return _provider;
}

// ─── Pipeline bundle (shared across tasks) ───

const bundle = buildPipelineDeps({
  broker: liveService,
  env: {
    clock: () => new Date(),
    scope: { kind: 'live' },
    sendAlert: sendSystemAlert,
  },
  config: {
    riskConfig: { ...LIVE_RISK_DEFAULTS },
    agentIdentity: DEFAULT_TRADE_MODEL,
  },
});
const { orderManager, pipelineDeps, getOpenPositions } = bundle;

// Start IBKR WebSocket listener for faster fill notifications (supplementary to polling)
if (process.env.BROKER === 'ibkr') {
  startWsListener(() => { orderManager.tick(new Date()); });
}

export function destroyOrderManager(): void {
  if (process.env.BROKER === 'ibkr') stopWsListener();
  bundle.destroy();
}

const POLL_INTERVAL = 3000; // 3 seconds
let running = false;
let currentTaskPromise: Promise<void> | null = null;

const circuitBreaker = new BrokerCircuitBreaker(
  { isHealthy: () => liveService.isHealthy(), sendAlert: sendSystemAlert },
);

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
      circuitBreaker.recordSuccess();
    } catch (err) {
      circuitBreaker.recordFailure(err);
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

  // ── Circuit breaker gate ──
  if (!await circuitBreaker.checkHealth()) return;

  // Atomic task claim — transaction SELECT+UPDATE avoids race
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
    await processTaskShared(task, {
      getOpenPositions,
      llm: await getProvider(),
      pipeline: pipelineDeps,
      scope: { kind: 'live' },
      agentIdentity: DEFAULT_TRADE_MODEL,
      onResult: async (result, _emitter) => {
        await completeTask(task.id, { outcome: result.outcome });
        console.log(`[Runner] Task ${task.id} completed: ${result.outcome}`);
      },
    });
  } catch (err) {
    await handleTaskError(task.id, err);
  }
}
