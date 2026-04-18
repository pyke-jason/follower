/**
 * Classify runner — parallel-safe orchestrator replay without execution.
 *
 * Loads historical messages via loadHistoricalMessages(), filters to tradable
 * messages, fans out across a worker pool, calls resolveOrchestrator() with
 * STUB_BROKER + empty positions, and emits one SETTLED row per message into
 * run_decisions under channelId = cls:<runId>.
 *
 * No pipeline, no order execution, no market data. The orchestrator's only
 * broker dependency (getQuote) is satisfied by the zero-quote stub.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@/db/client.js';
import { clsChannel, assertSafeRunId } from '@/lib/channel.js';
import { createLogger } from '@/lib/logger.js';
import { createAgent, getDefaultTradeModel } from '@/agent/factory.js';
import { resolveOrchestrator } from '@/intents/orchestrator/index.js';
import { createEmitter } from '@/decisions/emitter.js';
import { loadHistoricalMessages } from '@/backtest/historical-loader.js';
import { STUB_BROKER } from './stub-broker.js';
import { SignalSchema } from '@/agent/schemas.js';
import type { ModelProvider } from '@/agent/result.js';
import type { HistoricalMessage } from '@/backtest/types.js';
import type {
  ClassifyRunConfig,
  ClassifyRunSummary,
  Message,
} from '@/db/schema.js';

const ClassifierSignalsSchema = z.array(SignalSchema);

const log = createLogger('Classify');

const PROGRESS_INTERVAL_MSGS = 50;
const PROGRESS_INTERVAL_MS = 5_000;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 32;

type ClassifyReport = {
  config: ClassifyRunConfig;
  summary: ClassifyRunSummary;
};

export async function runClassify(
  config: ClassifyRunConfig,
  runId: string,
): Promise<ClassifyReport> {
  assertSafeRunId(runId);

  const startTime = Date.now();
  await db.update(schema.classifyRuns)
    .set({ status: 'RUNNING', startedAt: new Date().toISOString() })
    .where(eq(schema.classifyRuns.id, runId));

  try {
    const report = await runClassifyInner(config, runId, startTime);
    await db.update(schema.classifyRuns)
      .set({
        status: 'COMPLETED',
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        summary: report.summary,
      })
      .where(eq(schema.classifyRuns.id, runId));
    return report;
  } catch (err) {
    const [current] = await db.select({ status: schema.classifyRuns.status })
      .from(schema.classifyRuns)
      .where(eq(schema.classifyRuns.id, runId));
    if (current && current.status !== 'CANCELLED') {
      await db.update(schema.classifyRuns)
        .set({
          status: 'FAILED',
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(schema.classifyRuns.id, runId));
    }
    throw err;
  }
}

async function runClassifyInner(
  config: ClassifyRunConfig,
  runId: string,
  startTime: number,
): Promise<ClassifyReport> {
  const channelId = clsChannel(runId);
  const startDate = new Date(config.startDate);
  const endDate = new Date(config.endDate);

  log.info(`Loading messages for ${config.traders.join(', ')} (${startDate.toISOString()} → ${endDate.toISOString()})...`);
  const allMessages = await loadHistoricalMessages({
    startDate,
    endDate,
    traders: config.traders,
  });

  const tradableMessages = allMessages.filter(
    (m) => !m.isPaperTrade && m.symbols.length > 0,
  );
  log.info(`Loaded ${allMessages.length} messages (${tradableMessages.length} tradable)`);

  const summary: ClassifyRunSummary = {
    totalMessages: allMessages.length,
    tradableMessages: tradableMessages.length,
    processedMessages: 0,
    byOutcome: { EXECUTE: 0, SKIP: 0, MANUAL_REVIEW: 0, ERROR: 0 },
    byRoute: { 'hard-skip': 0, deterministic: 0, llm: 0 },
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    durationMs: 0,
  };

  await db.update(schema.classifyRuns)
    .set({ progressTotal: tradableMessages.length, summary })
    .where(eq(schema.classifyRuns.id, runId));

  if (tradableMessages.length === 0) {
    summary.durationMs = Date.now() - startTime;
    log.info('No tradable messages in range — done.');
    return { config, summary };
  }

  const agentIdentity = {
    provider: (config.agentProvider ?? getDefaultTradeModel().provider) as ModelProvider,
    model: config.agentModel ?? getDefaultTradeModel().model,
  };
  const agent = await createAgent(agentIdentity);
  log.info(`Agent: ${agentIdentity.provider}/${agentIdentity.model}`);

  const concurrency = Math.max(1, Math.min(config.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY));
  const queue = [...tradableMessages];
  let lastProgressFlush = Date.now();
  let processedSinceFlush = 0;
  let cancelled = false;

  // Serialize the first message so the xAI cache prefix lands before parallel workers race.
  if (queue.length > 1 && concurrency > 1 && !cancelled) {
    const warmMsg = queue.shift();
    if (warmMsg) {
      try {
        const route = await classifyMessage(warmMsg, channelId, agent, summary);
        summary.byRoute[route]++;
      } catch (err) {
        summary.byOutcome.ERROR++;
        log.warn(`classify failed for ${warmMsg.id} (warmup): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
      }
      summary.processedMessages++;
      processedSinceFlush++;
    }
  }

  const onSigterm = () => {
    log.info('Received SIGTERM — draining workers.');
    cancelled = true;
  };
  process.on('SIGTERM', onSigterm);

  async function worker(): Promise<void> {
    while (queue.length > 0 && !cancelled) {
      const msg = queue.shift();
      if (!msg) break;
      try {
        const route = await classifyMessage(msg, channelId, agent, summary);
        summary.byRoute[route]++;
      } catch (err) {
        summary.byOutcome.ERROR++;
        log.warn(`classify failed for ${msg.id}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
      }
      summary.processedMessages++;
      processedSinceFlush++;

      const now = Date.now();
      if (
        processedSinceFlush >= PROGRESS_INTERVAL_MSGS ||
        now - lastProgressFlush > PROGRESS_INTERVAL_MS
      ) {
        await db.update(schema.classifyRuns)
          .set({
            progressIndex: summary.processedMessages,
            lastMessageTs: msg.timestamp.toISOString(),
            lastMessageId: msg.id,
            summary,
          })
          .where(eq(schema.classifyRuns.id, runId));
        lastProgressFlush = now;
        processedSinceFlush = 0;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    process.off('SIGTERM', onSigterm);
  }

  summary.durationMs = Date.now() - startTime;
  await db.update(schema.classifyRuns)
    .set({ progressIndex: summary.processedMessages, summary })
    .where(eq(schema.classifyRuns.id, runId));

  log.info(
    `Done. ${summary.processedMessages}/${tradableMessages.length} processed. ` +
    `EXECUTE=${summary.byOutcome.EXECUTE} SKIP=${summary.byOutcome.SKIP} ` +
    `MANUAL_REVIEW=${summary.byOutcome.MANUAL_REVIEW} ERROR=${summary.byOutcome.ERROR}`,
  );

  return { config, summary };
}

async function classifyMessage(
  msg: HistoricalMessage,
  channelId: string,
  agent: Awaited<ReturnType<typeof createAgent>>,
  summary: ClassifyRunSummary,
): Promise<'hard-skip' | 'deterministic' | 'llm'> {
  const emitter = createEmitter({ messageId: msg.id, channelId });
  const message = historicalToMessage(msg);

  const resolved = await resolveOrchestrator(message, {
    getPositions: async () => [],
    agent,
    broker: STUB_BROKER,
    emitter,
  });

  summary.totalInputTokens += resolved.usage?.inputTokens ?? 0;
  summary.totalOutputTokens += resolved.usage?.outputTokens ?? 0;
  summary.totalCacheReadInputTokens = (summary.totalCacheReadInputTokens ?? 0) + (resolved.usage?.cacheReadInputTokens ?? 0);
  summary.totalCacheCreationInputTokens = (summary.totalCacheCreationInputTokens ?? 0) + (resolved.usage?.cacheCreationInputTokens ?? 0);

  const route: 'hard-skip' | 'deterministic' | 'llm' =
    resolved.parseResult?.isHardSkip ? 'hard-skip'
    : (resolved.usage && resolved.usage.inputTokens > 0) ? 'llm'
    : 'deterministic';

  if (resolved.classifierSignals == null) {
    throw new Error(`classify runner: resolved.classifierSignals missing for message ${msg.id}`);
  }
  // Write-time validation: catches Signal shape drift before the snapshot lands in DB.
  const classifierSignals = ClassifierSignalsSchema.parse(resolved.classifierSignals);

  if (resolved.outcome === 'EXECUTE') {
    summary.byOutcome.EXECUTE++;
    const reasoning = resolved.signals
      .map((s) => `${s.orderType} ${s.legs.map((l) => l.symbol).join('+')}`)
      .join('; ');
    await emitter.emit(
      'SETTLED',
      {
        outcome: 'EXECUTE',
        phase: 'orchestrator',
        reasoning,
        inputTokens: resolved.usage?.inputTokens,
        outputTokens: resolved.usage?.outputTokens,
      },
      { resolved, classifierSignals },
    );
  } else {
    const outcome = resolved.outcome === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW' : 'SKIP';
    summary.byOutcome[outcome]++;
    const skipCategory = outcome === 'MANUAL_REVIEW' ? 'flagged' : 'skip';
    await emitter.emit(
      'SETTLED',
      {
        outcome,
        phase: 'orchestrator',
        reasoning: resolved.reason,
        skipCategory,
        inputTokens: resolved.usage?.inputTokens,
        outputTokens: resolved.usage?.outputTokens,
      },
      { resolved, classifierSignals },
    );
  }

  return route;
}

function historicalToMessage(m: HistoricalMessage): Message {
  return {
    id: m.id,
    author: m.author,
    timestamp: m.timestamp.toISOString(),
    rawHtml: m.rawHtml,
    cleanText: m.cleanText,
    badges: m.badges,
    symbols: m.symbols,
    actionHint: m.actionHint,
    directionHint: m.directionHint,
    detectedStrategies: m.detectedStrategies,
    isPaperTrade: m.isPaperTrade,
    confidence: Number.isFinite(m.confidence) ? String(m.confidence) : null,
    ingestedAt: null,
    contentHash: null,
    reactions: [],
  };
}
