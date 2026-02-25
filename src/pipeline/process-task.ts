/**
 * Task processor — bridges the task queue to the orchestrator + resolved-signal executor.
 *
 * processTask(task, env) is the single entry point for both live and backtest paths.
 * It fetches the message, builds orchestrator context, resolves signals, and executes.
 */

import type { Task, Message } from '../db/schema.js';
import type { LLMProvider } from '../agent/providers.js';
import type { OrchestratorContext } from '../intents/orchestrator/types.js';
import type { ResolvedSignal, OpenPosition } from '../intents/orchestrator/types.js';
import type { ResolvedPipelineDeps, ResolvedPipelineResult } from './execute-resolved.js';

import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { resolveOrchestrator } from '../intents/orchestrator/index.js';
import { executeResolvedSignals } from './execute-resolved.js';
import { getRecentChatMessages, formatChatContext } from '../intents/trader-context.js';
import { getTrader } from '../config/traders.js';

// ─── Types ──────────────────────────────────────────

export type TaskResult =
  | { outcome: 'SKIP'; reason: string }
  | { outcome: 'MANUAL_REVIEW'; reason: string }
  | { outcome: 'EXECUTE'; reason: string; signals: ResolvedSignal[]; results: ResolvedPipelineResult[] };

export type TaskEnv = {
  getPositions: (symbol?: string) => Promise<OpenPosition[]>;
  llm: LLMProvider;
  pipeline: ResolvedPipelineDeps;
  onResult: (result: TaskResult) => Promise<void>;
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

  const orchCtx = await buildOrchestratorContext(message, env);
  const resolved = await resolveOrchestrator(orchCtx, env.llm);

  if (resolved.outcome !== 'EXECUTE') {
    await env.onResult({ outcome: resolved.outcome, reason: resolved.reason });
    return;
  }

  const results = await executeResolvedSignals(
    resolved.signals,
    message.author,
    env.pipeline,
    { messageId: message.id },
  );

  await env.onResult({
    outcome: 'EXECUTE',
    reason: `${resolved.signals.length} signal(s)`,
    signals: resolved.signals,
    results,
  });
}

// ─── Helpers ────────────────────────────────────────

async function buildOrchestratorContext(
  message: Message,
  env: TaskEnv,
): Promise<OrchestratorContext> {
  const traderConfig = await getTrader(message.author);

  return {
    messageId: message.id,
    rawHtml: message.rawHtml,
    cleanText: message.cleanText,
    badges: (message.badges as string[]) ?? [],
    symbols: (message.symbols as string[]) ?? [],
    timestamp: message.timestamp,
    author: message.author,
    marketData: {
      getQuote: (s) => env.pipeline.broker.getQuote(s),
      getOptionChain: async () => null,
      getExpiryDates: async () => [],
    },
    positions: {
      getPositions: env.getPositions,
    },
    chatHistory: {
      getRecentMessages: async (author?: string, limit?: number) => {
        const msgs = await getRecentChatMessages(message.timestamp, author, limit);
        return formatChatContext(msgs);
      },
    },
    traderConfig: {
      strategies: traderConfig?.strategies ?? [],
      notes: traderConfig?.notes ?? null,
    },
  };
}
