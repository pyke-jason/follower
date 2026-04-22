import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { completeTask, handleTaskError, expireTask } from '../pipeline/task-lifecycle.js';
import type { Task } from '../db/schema.js';
import { createAgent, getDefaultTradeModel } from '../agent/factory.js';
import type { Agent } from '../agent/result.js';
import { processTask as processTaskShared } from '../pipeline/process-task.js';
import { createTrace } from '../lib/trace.js';
import {
  getRuntimeChannelServices,
  type RuntimeChannelService,
} from '../broker/select.js';
import { sendSystemAlert } from '../lib/alert.js';
import { checkExpiryWarnings } from '../lib/expiry-warning.js';
import { LIVE_RISK_DEFAULTS } from '../config/risk-defaults.js';
import { BrokerCircuitBreaker } from '../lib/circuit-breaker.js';
import { buildPipelineDeps } from '../pipeline/build-deps.js';
import type { PipelineBundle } from '../pipeline/build-deps.js';
import { upsertRuntimeHealth } from './runtime-health.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('runner');

type ChannelRunnerState = {
  service: RuntimeChannelService;
  bundle: PipelineBundle;
  circuitBreaker: BrokerCircuitBreaker;
  queue: Task[];
  draining: boolean;
  currentTaskPromise: Promise<void> | null;
};

const channels = new Map<string, ChannelRunnerState>();
let channelServices: RuntimeChannelService[] = [];
let _initialized = false;

// ─── Independent timers ───

let expiryTimer: ReturnType<typeof setInterval> | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;

function readRiskOverrides(): Partial<typeof LIVE_RISK_DEFAULTS> {
  const overrides: Partial<typeof LIVE_RISK_DEFAULTS> = {};
  const raw = process.env.LIVE_MAX_TOTAL_POSITIONS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      overrides.maxTotalPositions = parsed;
    } else {
      log.warn({ raw }, 'Ignoring invalid LIVE_MAX_TOTAL_POSITIONS');
    }
  }
  return overrides;
}

// ─── Lazy agent (single instance reused across tasks) ───

let _agent: Agent | null = null;
async function getAgent(): Promise<Agent> {
  if (!_agent) _agent = await createAgent(getDefaultTradeModel());
  return _agent;
}

// ─── Push-based task queue ───

const STALE_THRESHOLD_MS = 60_000;
let accepting = true;

export function submitTask(task: Task): void {
  if (!accepting) return;
  if (!task.channelId) {
    console.warn(`[Runner] Dropping task ${task.id}: missing channelId`);
    return;
  }
  const state = channels.get(task.channelId);
  if (!state) {
    console.warn(`[Runner] Dropping task ${task.id}: unknown channel ${task.channelId}`);
    return;
  }
  state.queue.push(task);
  if (!state.draining) void drainQueue(state);
}

export function stopRunner(): void {
  accepting = false;
  console.log('[Runner] Stopped accepting tasks');
}

export async function awaitDrain(): Promise<void> {
  while ([...channels.values()].some((state) => state.draining || state.currentTaskPromise)) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function drainQueue(state: ChannelRunnerState): Promise<void> {
  state.draining = true;
  while (state.queue.length > 0) {
    const task = state.queue.shift()!;
    state.currentTaskPromise = claimAndProcess(state, task);
    await state.currentTaskPromise;
    state.currentTaskPromise = null;
  }
  state.draining = false;
}

async function claimAndProcess(state: ChannelRunnerState, task: Task): Promise<void> {
  const ageMs = Date.now() - new Date(task.createdAt ?? Date.now()).getTime();
  if (ageMs > STALE_THRESHOLD_MS) {
    const reason = `stale: created ${Math.round(ageMs / 1000)}s ago`;
    await expireTask(task.id, reason);
    sendSystemAlert({
      title: 'Task expired (stale)',
      message: `Task ${task.id} expired: ${reason}. Check runner health.`,
      severity: 'warning',
    });
    return;
  }

  if (!await state.circuitBreaker.checkHealth()) {
    upsertRuntimeHealth(state.service.channelId, {
      brokerHealthy: false,
      circuitOpen: state.circuitBreaker.isOpen(),
      lastError: 'Broker health check failed',
    });
    setTimeout(() => submitTask(task), 10_000);
    return;
  }

  // Atomic claim — guards against web UI skipTask() racing
  const claimed = await db.update(schema.tasks)
    .set({ status: 'IN_PROGRESS', startedAt: new Date().toISOString() })
    .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.status, 'PENDING')))
    .returning();

  if (claimed.length === 0) return;

  await handleTask(state, task);
}

async function handleTask(state: ChannelRunnerState, task: Task): Promise<void> {
  console.log(`[Runner ${state.service.channelId}] Processing task ${task.id} (${task.taskType})`);
  const trace = createTrace();
  try {
    await processTaskShared(task, {
      getOpenPositions: state.bundle.getOpenPositions,
      agent: await getAgent(),
      pipeline: state.bundle.pipelineDeps,
      scope: state.service.channelId,
      agentIdentity: getDefaultTradeModel(),
      trace,
      onResult: async (result, _emitter) => {
        await completeTask(task.id);
        console.log(`[Runner ${state.service.channelId}] Task ${task.id} completed: ${result.outcome}`);
      },
    });
    state.circuitBreaker.recordSuccess();
    upsertRuntimeHealth(state.service.channelId, {
      brokerHealthy: true,
      circuitOpen: false,
    });
  } catch (err) {
    try { await handleTaskError(task.id, err); } catch (inner) { log.error({ err: inner, taskId: task.id }, 'handleTaskError failed'); }
    state.circuitBreaker.recordFailure(err);
    const errMsg = err instanceof Error ? err.message : String(err);
    upsertRuntimeHealth(state.service.channelId, {
      brokerHealthy: false,
      circuitOpen: state.circuitBreaker.isOpen(),
      lastError: errMsg.slice(0, 500),
    });
  }
}

// ─── Initialization ───

/**
 * Initialize the live runner. Must be called after loadSecrets().
 * Sets up per-channel broker pipelines, expires stale tasks, starts timers.
 */
export async function initRunner(): Promise<{ channels: RuntimeChannelService[] }> {
  if (_initialized) return { channels: channelServices };

  channelServices = getRuntimeChannelServices();
  if (channelServices.length === 0) {
    throw new Error('No enabled runtime channels found for runner initialization.');
  }

  const riskConfig = { ...LIVE_RISK_DEFAULTS, ...readRiskOverrides() };

  for (const service of channelServices) {
    const bundle = buildPipelineDeps({
      broker: service.broker,
      env: {
        clock: () => new Date(),
        scope: service.channelId,
        sendAlert: sendSystemAlert,
      },
      config: {
        riskConfig,
        agentIdentity: getDefaultTradeModel(),
        isBacktestScope: false,
        requireExplicitTimestamps: false,
      },
    });

    const circuitBreaker = new BrokerCircuitBreaker({
      isHealthy: () => service.broker.isHealthy(),
      sendAlert: sendSystemAlert,
    });

    channels.set(service.channelId, {
      service,
      bundle,
      circuitBreaker,
      queue: [],
      draining: false,
      currentTaskPromise: null,
    });

    // Baseline health row — runner initialized, broker assumed healthy
    upsertRuntimeHealth(service.channelId, { brokerHealthy: true, circuitOpen: false });
  }

  // Expire stale tasks from previous runs
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  const now = new Date().toISOString();
  let expiredCount = 0;

  for (const service of channelServices) {
    const pendingExpired = await db.update(schema.tasks)
      .set({ status: 'EXPIRED', error: 'stale: process restarted', completedAt: now })
      .where(and(
        eq(schema.tasks.status, 'PENDING'),
        sql`created_at < ${staleThreshold}`,
        eq(schema.tasks.channelId, service.channelId),
      ))
      .returning();

    const inProgressExpired = await db.update(schema.tasks)
      .set({ status: 'EXPIRED', error: 'stale: interrupted by restart', completedAt: now })
      .where(and(
        eq(schema.tasks.status, 'IN_PROGRESS'),
        eq(schema.tasks.channelId, service.channelId),
      ))
      .returning();

    const count = pendingExpired.length + inProgressExpired.length;
    expiredCount += count;
    if (count > 0) {
      console.warn(`[Runner ${service.channelId}] Expired ${count} stale task(s) on startup`);
    }
  }

  if (expiredCount > 0) {
    sendSystemAlert({
      title: 'Stale tasks expired on startup',
      message: `${expiredCount} task(s) expired across ${channelServices.length} channel(s). Signals were missed during downtime.`,
      severity: 'warning',
    });
  }

  // Independent timers for expiry warnings and circuit breaker health
  expiryTimer = setInterval(() => {
    for (const state of channels.values()) {
      checkExpiryWarnings(() => state.bundle.getOpenPositions()).catch(() => {});
    }
  }, 5 * 60 * 1000);

  healthTimer = setInterval(async () => {
    for (const state of channels.values()) {
      const healthy = await state.circuitBreaker.checkHealth();
      upsertRuntimeHealth(state.service.channelId, {
        brokerHealthy: healthy,
        circuitOpen: state.circuitBreaker.isOpen(),
        lastError: healthy ? null : 'Broker health check failed',
      });
    }
  }, 30_000);

  _initialized = true;
  console.log(`[Runner] Initialized (${channelServices.map((c) => c.channelId).join(', ')})`);
  return { channels: channelServices };
}

export function destroyOrderManager(): void {
  if (!_initialized) return;
  if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null; }
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  for (const state of channels.values()) {
    state.bundle.destroy();
  }
  channels.clear();
  channelServices = [];
  _initialized = false;
}
