/**
 * Task processor — bridges the task queue to the orchestrator + resolved-signal executor.
 *
 * processTask(task, env) is the single entry point for both live and backtest paths.
 * It builds its own emitter and position callback from the provided scope + getOpenPositions,
 * fetches the message, calls the orchestrator (which emits PARSED),
 * then either emits SETTLED (for non-EXECUTE) or calls the executor (which emits per-signal events).
 */

import type { Task, Trade } from '../db/schema.js';
import { TaskContextSchema } from '../db/schema.js';
import type { Agent } from '../agent/result.js';
import { TradePositionListSchema } from '../intents/orchestrator/types.js';
import type { OrchestratorResult, ResolvedSignal, SignalEventEmitter, SerializedParseResult, TradePosition } from '../intents/orchestrator/types.js';
import type { ResolvedPipelineDeps, ResolvedPipelineResult, ExecuteEnv } from './execute-resolved.js';
import type { TradeScope } from './build-deps.js';
import type { PositionFilters } from '../trades/filters.js';
import type { TraceContext } from '../lib/trace.js';
import type { TradeMetadata } from '../db/schema.js';
import { traced, maxEnd } from '../lib/trace.js';

import { db, schema } from '../db/client.js';

import { eq } from 'drizzle-orm';
import { resolveOrchestrator } from '../intents/orchestrator/index.js';
import { executeResolvedSignals } from './execute-resolved.js';
import { createEmitter } from '../decisions/emitter.js';
import { stampHasUpdate } from '../trades/trade-flags.js';
import { evaluateClassificationGate } from '../safety/classification-gate.js';
import { enqueueClassificationAudit } from '../safety/classification-audit.js';
import { classifierSignalsSnapshotFromResolved } from '../safety/schemas.js';
import type { ClassificationGateResult } from '../safety/schemas.js';

// ─── Types ──────────────────────────────────────────

type ProcessTaskResult =
  | Extract<OrchestratorResult, { outcome: 'SKIP' | 'MANUAL_REVIEW' }>
  | {
    outcome: 'EXECUTE';
    reason: string;
    signals: ResolvedSignal[];
    results: ResolvedPipelineResult[];
    classifierSignals: NonNullable<OrchestratorResult['classifierSignals']>;
    parseResult?: SerializedParseResult;
  };

type TaskEnv = {
  getOpenPositions: (filters?: PositionFilters) => Promise<Trade[]>;
  agent: Agent;
  pipeline: ResolvedPipelineDeps;
  scope: TradeScope;
  agentIdentity: { provider: string; model: string };
  onResult: (result: ProcessTaskResult, emitter: SignalEventEmitter) => Promise<void>;
  /** Classify non-EXECUTE outcomes for the SETTLED event. Returns skipCategory. */
  classifySkip?: (result: Extract<ProcessTaskResult, { outcome: 'SKIP' | 'MANUAL_REVIEW' }>) => string;
  trace?: TraceContext;
};

// ─── Main ───────────────────────────────────────────

export async function processTask(task: Task, env: TaskEnv): Promise<void> {
  const context = TaskContextSchema.parse(task.context ?? {});

  const messageId = task.messageId;
  if (!messageId) throw new Error(`Task ${task.id} has no messageId`);

  // Ensure task row exists (idempotent — live pre-creates, backtest does not)
  await db.insert(schema.tasks).values({
    id: task.id,
    messageId: task.messageId,
    taskType: task.taskType,
    status: task.status,
    assignee: task.assignee,
    context: task.context,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    channelId: env.scope,
  }).onConflictDoNothing();

  // Stamp model identity on the task row
  await db.update(schema.tasks)
    .set({ modelProvider: env.agentIdentity.provider, modelName: env.agentIdentity.model })
    .where(eq(schema.tasks.id, task.id));

  // Always wrap pipeline to inject taskId per-task.
  const pipeline = {
    ...env.pipeline,
    recordTrade: (input: Parameters<ResolvedPipelineDeps['recordTrade']>[0]) =>
      env.pipeline.recordTrade({ ...input, taskId: task.id }),
    onPending: (orderId: string, ctx: Parameters<ResolvedPipelineDeps['onPending']>[1]) =>
      env.pipeline.onPending(orderId, { ...ctx, taskId: task.id }),
  };

  // Derive position lookup from getOpenPositions + context.author
  const getPositions = async (symbol?: string): Promise<TradePosition[]> => {
    const filters: PositionFilters = symbol ? { symbol } : {};
    const positions = await env.getOpenPositions({ ...filters, trader: context.author ?? undefined });
    return TradePositionListSchema.parse(positions);
  };

  const [message] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);

  if (!message) throw new Error(`Message ${messageId} not found for task ${task.id}`);

  let gateResult: ClassificationGateResult | null = null;

  // Derive emitter from scope. Audit work is fire-and-forget so SETTLED writes
  // never wait on the critic or alert delivery.
  const emitter = createEmitter({
    messageId,
    channelId: env.scope,
    taskId: task.id,
    onDecision: (runDecision) => {
      if (runDecision.event !== 'SETTLED') return;
      enqueueClassificationAudit({
        message,
        task,
        runDecision,
        agent: env.agent,
        gateResult,
        sendAlert: env.pipeline.sendAlert,
      });
    },
  });

  const executeEnv: ExecuteEnv = {
    getPositions,
    agent: env.agent,
    pipeline,
    emitter,
  };

  // Orchestrator emits PARSED (always) + SIGNAL_RESOLVED (for executes)
  const resolved = await traced(env.trace, 'orchestrator', 'sync', () =>
    resolveOrchestrator(message, {
      getPositions,
      agent: env.agent,
      broker: env.pipeline.broker,
      emitter,
      trace: env.trace,
    }),
  );

  const symbols = message.symbols;
  const maybeAlertSkippedHeldSymbols = async (reason: string): Promise<void> => {
    if (!env.pipeline.sendAlert || !context.author || symbols.length === 0) return;

    const heldSummaries: string[] = [];
    for (const symbol of [...new Set(symbols)]) {
      const positions = await getPositions(symbol);
      if (positions.length === 0) continue;
      heldSummaries.push(`${symbol} (${positions.length} open)`);
    }
    if (heldSummaries.length === 0) return;

    const text = message.cleanText.replace(/\s+/g, ' ').trim();
    const clippedText = text.length > 160 ? `${text.slice(0, 157)}...` : text;
    await env.pipeline.sendAlert({
      title: 'Skipped message on open position',
      message: `${context.author} mentioned held symbol(s) ${heldSummaries.join(', ')} but no trade was taken. Reason: ${reason}. Message: "${clippedText}" [${env.scope}]`,
      severity: 'warning',
    });
  };

  if (resolved.outcome !== 'EXECUTE') {
    const result = {
      outcome: resolved.outcome,
      reason: resolved.reason,
      parseResult: resolved.parseResult,
      usage: resolved.usage,
      ...(resolved.outcome === 'SKIP' && resolved.skipCategory ? { skipCategory: resolved.skipCategory } : {}),
    } as Extract<ProcessTaskResult, { outcome: 'SKIP' | 'MANUAL_REVIEW' }>;

    const mappedOutcome = resolved.outcome === 'MANUAL_REVIEW' ? 'SKIP' : resolved.outcome;
    const deterministicSkipCategory = resolved.outcome === 'SKIP' ? resolved.skipCategory : undefined;
    const skipCategory = env.classifySkip?.(result)
      ?? deterministicSkipCategory
      ?? (resolved.outcome === 'MANUAL_REVIEW' ? 'flagged' : 'skip');

    await emitter.emit('SETTLED',
      { outcome: mappedOutcome, phase: 'orchestrator', reasoning: resolved.reason, skipCategory, inputTokens: resolved.usage?.inputTokens, outputTokens: resolved.usage?.outputTokens },
      { resolved, ...classifierSignalsSnapshotFromResolved(resolved) },
    );

    await maybeAlertSkippedHeldSymbols(resolved.reason);

    // Stamp hasUpdate on open trades — no execution happened so open trades are unchanged
    if (symbols.length > 0 && context.author) {
      await stampHasUpdate({ symbols, trader: context.author, channelId: env.scope, messageId });
    }

    if (env.trace) {
      await emitter.emit('TRACE', {}, { spans: env.trace.getSpans() });
    }
    await env.onResult(result, emitter);
    return;
  }

  const gateOpenPositions = await env.getOpenPositions({ trader: context.author ?? message.author });
  gateResult = evaluateClassificationGate({
    message,
    resolved,
    openPositions: gateOpenPositions,
  });

  if (gateResult.findings.length > 0) {
    await emitter.emit('SAFETY_GATE',
      { outcome: gateResult.decision === 'block' ? 'SKIP' : 'EXECUTE', phase: 'safety_gate', reasoning: gateResult.reason },
      { gate: gateResult, resolved },
    );
  }

  if (gateResult.decision === 'block') {
    await env.pipeline.sendAlert?.({
      title: 'Safety gate blocked trade',
      message: `${message.author}: ${gateResult.reason}. Message: "${message.cleanText.slice(0, 240)}" [${env.scope}]`,
      severity: 'critical',
    });

    await emitter.emit('SETTLED',
      {
        outcome: 'SKIP',
        phase: 'safety_gate',
        reasoning: gateResult.reason,
        skipCategory: 'safety_block',
        inputTokens: resolved.usage?.inputTokens,
        outputTokens: resolved.usage?.outputTokens,
      },
      { gate: gateResult, resolved, ...classifierSignalsSnapshotFromResolved(resolved) },
    );

    if (symbols.length > 0 && context.author) {
      await stampHasUpdate({ symbols, trader: context.author, channelId: env.scope, messageId });
    }

    if (env.trace) {
      await emitter.emit('TRACE', {}, { spans: env.trace.getSpans() });
    }
    await env.onResult({
      outcome: 'SKIP',
      reason: gateResult.reason,
      parseResult: resolved.parseResult,
      usage: resolved.usage,
    }, emitter);
    return;
  }

  // Executor emits per-signal SETTLED events via emitter
  const results = await traced(env.trace, 'execute', 'broker', () =>
    executeResolvedSignals({
      resolved,
      message,
      env: { ...executeEnv, trace: env.trace },
    }),
  );

  // Stamp hasUpdate AFTER execution so trades just closed/trimmed are excluded by isOpen filter.
  // Also exclude trades targeted by pending close orders (not yet filled due to chase).
  if (symbols.length > 0 && context.author) {
    const pendingTradeIds = resolved.signals
      .filter(s => s.tradeId)
      .map(s => s.tradeId!);
    await stampHasUpdate({ symbols, trader: context.author, channelId: env.scope, messageId, excludeTradeIds: pendingTradeIds });
  }

  if (env.trace) {
    const spans = env.trace.getSpans();
    await emitter.emit('TRACE', {}, { spans });

    // Stamp executionMs on any trades produced by this task
    const executionMs = Math.round(maxEnd(spans));
    if (executionMs > 0) {
      const tradeIds = results.map(r => r.tradeId).filter((id): id is string => !!id);
      for (const tradeId of tradeIds) {
        const [row] = await db.select({ metadata: schema.trades.metadata })
          .from(schema.trades)
          .where(eq(schema.trades.id, tradeId))
          .limit(1);
        if (row) {
          await db.update(schema.trades)
            .set({ metadata: { ...row.metadata, executionMs } satisfies TradeMetadata })
            .where(eq(schema.trades.id, tradeId));
        }
      }
    }
  }
  await env.onResult({
    outcome: 'EXECUTE',
    reason: `${resolved.signals.length} signal(s)`,
    signals: resolved.signals,
    results,
    classifierSignals: classifierSignalsSnapshotFromResolved(resolved).classifierSignals,
    parseResult: resolved.parseResult,
  }, emitter);
}
