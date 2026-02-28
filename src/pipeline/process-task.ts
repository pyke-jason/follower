/**
 * Task processor — bridges the task queue to the orchestrator + resolved-signal executor.
 *
 * processTask(task, env) is the single entry point for both live and backtest paths.
 * It fetches the message, calls the orchestrator (which emits PARSED/SETTLED),
 * then calls the executor (which emits per-signal events).
 */

import type { Task } from '../db/schema.js';
import type { LLMProvider } from '../agent/providers.js';
import type { OrchestratorResult, ResolvedSignal, OpenPosition, SignalEventEmitter } from '../intents/orchestrator/types.js';
import type { ResolvedPipelineDeps, ResolvedPipelineResult } from './execute-resolved.js';

import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { resolveOrchestrator } from '../intents/orchestrator/index.js';
import { executeResolvedSignals } from './execute-resolved.js';

// ─── Types ──────────────────────────────────────────

export type ProcessTaskResult =
  | Extract<OrchestratorResult, { outcome: 'SKIP' | 'MANUAL_REVIEW' }>
  | { outcome: 'EXECUTE'; reason: string; signals: ResolvedSignal[]; results: ResolvedPipelineResult[] };

export type TaskEnv = {
  getPositions: (symbol?: string) => Promise<OpenPosition[]>;
  llm: LLMProvider;
  pipeline: ResolvedPipelineDeps;
  emitter: SignalEventEmitter;
  onResult: (result: ProcessTaskResult) => Promise<void>;
};

// ─── Main ───────────────────────────────────────────

export async function processTask(task: Task, env: TaskEnv): Promise<void> {
  const messageId = task.messageId;
  if (!messageId) throw new Error(`Task ${task.id} has no messageId`);

  const [message] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);

  if (!message) throw new Error(`Message ${messageId} not found for task ${task.id}`);

  // Orchestrator emits PARSED + SETTLED (for skips) or SIGNAL_RESOLVED (for executes)
  const resolved = await resolveOrchestrator(message, {
    getPositions: env.getPositions,
    llm: env.llm,
    broker: env.pipeline.broker,
    emitter: env.emitter,
  });

  if (resolved.outcome !== 'EXECUTE') {
    await env.onResult({
      outcome: resolved.outcome,
      reason: resolved.reason,
      parseResult: resolved.parseResult,
      usage: resolved.usage,
    });
    return;
  }

  // Executor emits per-signal SETTLED events via env.emitter
  const results = await executeResolvedSignals({
    resolved,
    message,
    env,
  });

  await env.onResult({
    outcome: 'EXECUTE',
    reason: `${resolved.signals.length} signal(s)`,
    signals: resolved.signals,
    results,
  });
}
