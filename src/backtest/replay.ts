/**
 * Phase 2: Deterministic replay using cached intents.
 *
 * Processes a message by looking up its pre-extracted intent (from Phase 1)
 * and executing the signals through the deterministic pipeline. No LLM calls.
 *
 * Still performs:
 * - Position-based deterministic pre-checks (max positions, no open position for CLOSE, etc.)
 * - Full pipeline execution (sizing, risk check, order placement, trade recording)
 *
 * Skips:
 * - Agent/LLM classification (already done in Phase 1)
 * - Quote prefetching for agent (not needed — intent already has signals)
 */
import { db, schema } from '../db/client.js';
import { and, eq } from 'drizzle-orm';
import type { MessageIntent, TaskContext, Trade } from '../db/schema.js';
import type { Signal } from '../agent/schemas.js';
import type { PrefetchedData, PrefetchedPositions } from '../agent/prefetch.js';
import { shouldSkipDeterministic } from '../agent/deterministic-skips.js';
import { executeSignals } from '../pipeline/execute.js';
import type { PipelineDeps } from '../pipeline/execute.js';
import type { HistoricalMessage } from './types.js';
import { isOpen, forRun, forSymbol, forTrader } from '../trades/filters.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Replay');

export type ReplayResult = {
  traded: boolean;
  tradeId?: string;
  reasoning: string;
  /** The intent decision that drove this result */
  intentDecision: string;
  /** Pipeline failure reason, if intent said EXECUTE but pipeline blocked it */
  pipelineFailure?: string;
};

export type ReplayDeps = {
  runId: string;
  pipelineDeps: PipelineDeps;
  maxOnSymbol: number;
  maxTotalPositions: number;
};

/**
 * Build minimal position data for deterministic skip checks.
 * Unlike the full prefetchForAgent, this ONLY fetches positions
 * (no quotes, no trader profile, no agent context).
 */
async function fetchPositionsForSkipCheck(
  author: string,
  symbols: string[],
  getOpenPositions: (filters: { symbol?: string; trader?: string }) => Promise<Trade[]>,
): Promise<PrefetchedData> {
  let positions: PrefetchedPositions;
  try {
    const allForTrader = await getOpenPositions({ trader: author });
    const symbolSet = new Set(symbols);
    positions = {
      forSymbol: allForTrader.filter((t) => symbolSet.has(t.symbol)),
      allForTrader,
      totalCount: allForTrader.length,
      failed: false,
    };
  } catch {
    positions = { forSymbol: [], allForTrader: [], totalCount: -1, failed: true };
  }

  return { quotes: {}, positions, traderProfile: null };
}

/**
 * Process a single message using a cached intent.
 * Returns the result of replay — the caller handles stats/decision recording.
 */
export async function replayMessageWithIntent(
  msg: HistoricalMessage,
  intent: MessageIntent,
  deps: ReplayDeps,
): Promise<ReplayResult> {
  const reasoning = intent.reasoning ?? 'No reasoning';

  // Intent says SKIP or MANUAL_REVIEW → skip immediately
  if (intent.decision !== 'EXECUTE') {
    log.debug(`  replay: ${intent.decision} (${reasoning.slice(0, 80)})`);
    return { traded: false, reasoning, intentDecision: intent.decision };
  }

  // Intent says EXECUTE — verify we have signals
  const signals = intent.signals as Signal[] | null;
  if (!signals || signals.length === 0) {
    log.debug(`  replay: EXECUTE but no signals`);
    return { traded: false, reasoning: 'Intent EXECUTE but no signals', intentDecision: intent.decision };
  }

  // Build task context for deterministic checks
  const taskContext: TaskContext = {
    messageId: msg.id,
    messageTimestamp: msg.timestamp.toISOString(),
    author: msg.author,
    cleanText: msg.cleanText,
    badges: msg.badges,
    symbols: msg.symbols,
    actionHint: msg.actionHint,
    directionHint: msg.directionHint,
    detectedStrategies: msg.detectedStrategies,
    confidence: msg.confidence,
  };

  // Fetch ONLY position data for deterministic checks
  const prefetched = await fetchPositionsForSkipCheck(
    msg.author,
    msg.symbols,
    deps.pipelineDeps.getOpenPositions,
  );

  // Deterministic pre-checks (max positions, no open position for CLOSE, etc.)
  // Don't include agent budget checks — no agent calls in replay
  const skip = shouldSkipDeterministic(taskContext, prefetched, {
    maxOnSymbol: deps.maxOnSymbol,
    maxTotalPositions: deps.maxTotalPositions,
  });

  if (skip) {
    log.debug(`  replay: deterministic skip (${skip.reason})`);
    return { traded: false, reasoning: `[replay skip] ${skip.reason}`, intentDecision: intent.decision };
  }

  // Execute signals through the deterministic pipeline
  const pipelineResults = await executeSignals(
    signals,
    msg.author,
    deps.pipelineDeps,
    { messageId: msg.id, backtestRunId: deps.runId, isBacktest: true },
  );

  const executedResults = pipelineResults.filter((r) => r.executed);
  const firstTradeId = executedResults[0]?.tradeId;

  // Collect pipeline failure reasons
  const pipelineFailures = pipelineResults
    .filter((r) => !r.executed && r.reason)
    .map((r) => `${r.signal.action} ${r.signal.symbol}: ${r.reason}`);

  if (executedResults.length > 0) {
    log.debug(`  replay: EXECUTE ${executedResults.length} signal(s)`);
    return { traded: true, tradeId: firstTradeId, reasoning, intentDecision: intent.decision };
  }

  if (pipelineFailures.length > 0) {
    const failReason = pipelineFailures.join('; ');
    log.debug(`  replay: pipeline blocked (${failReason})`);
    return { traded: false, reasoning, intentDecision: intent.decision, pipelineFailure: failReason };
  }

  return { traded: false, reasoning, intentDecision: intent.decision };
}
