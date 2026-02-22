import { SimClock } from './clock.js';
import { DatabentoMarketDataProvider } from './market-data.js';
import type { BacktestPriceProvider } from './market-data.js';
import { SimBroker } from './sim-broker.js';
import type { RiskCheckConfig, RiskCheckDeps } from '../orders/risk-check.js';
import { loadHistoricalMessages } from './historical-loader.js';
import { generateReportFromTrades } from './report.js';
import { toDateKeyET } from '../lib/et-date.js';
import { executeSignals } from '../pipeline/execute.js';
import type { PipelineDeps, PendingOrderContext } from '../pipeline/execute.js';
import { prefetchForAgent, type PrefetchedData } from '../agent/prefetch.js';
import type { LLMProvider } from '../agent/providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from '../agent/providers.js';
import { getTrader } from '../config/traders.js';
import { OrderManager } from '../orders/order-manager.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { recordTrade } from '../trades/record-trade.js';
import { isClosed, forRun, type PositionFilters } from '../trades/filters.js';
import type { BacktestConfig, BacktestReport, FillModel, HistoricalMessage } from './types.js';
import { buildLiveMetrics } from './live-metrics.js';
import type { TaskContext } from '../db/schema.js';
import type { LLMUsage } from '../agent/providers.js';
import { resetApiStats } from './databento-tape.js';
import { createLogger } from '../lib/logger.js';
import { safeParseFloat } from '../lib/numbers.js';
import { extractBatchIntents } from '../intents/extract-batch.js';
import type { IntentExtractionDeps } from '../intents/extract-intent.js';
import { INTENT_VERSION } from '../intents/extract-intent.js';
import type { MessageIntent, Message } from '../db/schema.js';
import { inArray } from 'drizzle-orm';
import { RuleBasedTradeAgent } from '../trading/trade-agent.js';
import type { TradeAgent, Action } from '../trading/trade-agent.js';

/**
 * Bundles all backtest-scoped dependencies so processMessage and
 * runAgentForBacktest don't need 16 positional parameters.
 */
type BacktestContext = {
  runId: string;
  config: BacktestConfig;
  priceProvider: BacktestPriceProvider;
  agentProvider: LLMProvider;
  pipelineDeps: PipelineDeps;
  tradeAgent: TradeAgent;
  maxOnSymbol: number;
  maxTotalPositions: number;
};

const log = createLogger('Backtest');

/**
 * Backtest orchestrator.
 * Loads messages, initializes sim components, and replays chronologically.
 * When runId is provided, persists all results to the DB.
 */
export async function runBacktest(config: BacktestConfig, runId: string): Promise<BacktestReport> {
  const startTime = Date.now();

  // Mark run as RUNNING
  if (runId) {
    await db.update(schema.backtestRuns)
      .set({ status: 'RUNNING', startedAt: new Date().toISOString() })
      .where(eq(schema.backtestRuns.id, runId));
  }

  try {
    const report = await runBacktestInner(config, runId);

    // Persist results on success
    if (runId) {
      await db.update(schema.backtestRuns)
        .set({
          status: 'COMPLETED',
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
          summary: report.summary,
          byTrader: report.byTrader,
          byStrategy: report.byStrategy,
          equityCurve: report.equityCurve,
          extendedMetrics: report.extendedMetrics,
        })
        .where(eq(schema.backtestRuns.id, runId));
    }

    return report;
  } catch (err) {
    if (runId) {
      // Check if already cancelled — don't overwrite CANCELLED status
      const [current] = await db
        .select({ status: schema.backtestRuns.status })
        .from(schema.backtestRuns)
        .where(eq(schema.backtestRuns.id, runId));

      if (!current || current.status !== 'CANCELLED') {
        await db.update(schema.backtestRuns)
          .set({
            status: 'FAILED',
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            error: err instanceof Error ? err.message : String(err),
          })
          .where(eq(schema.backtestRuns.id, runId));
      }
    }
    throw err;
  }
}

async function runBacktestInner(config: BacktestConfig, runId: string): Promise<BacktestReport> {
  if (!runId) throw new Error('runId is required for backtest');

  log.info(`Loading messages for ${config.traders.join(', ')}...`);
  const startDate = new Date(config.startDate);
  const endDate = new Date(config.endDate);
  log.info(`Date range: ${config.startDate.split('T')[0]} to ${config.endDate.split('T')[0]}`);
 
  // Load messages
  const allMessages = await loadHistoricalMessages({
    startDate,
    endDate,
    traders: config.traders,
  });

  log.info(`Loaded ${allMessages.length} messages`);

  // Filter to messages with badges and not paper trades
  const tradableMessages = allMessages.filter(
    (m) => m.badges.length > 0 && !m.isPaperTrade,
  );

  log.info(`${tradableMessages.length} tradable messages (with badges, not paper)`);

  // Write totalMessages to summary early so the web page knows the progress denominator
  if (runId) {
    await db.update(schema.backtestRuns)
      .set({
        summary: {
          totalMessages: allMessages.length,
          tradedMessages: tradableMessages.length,
          totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0,
          avgWin: 0, avgLoss: 0, maxDrawdown: 0, profitFactor: 0,
          agentCallsUsed: 0, agentTrades: 0, skipped: 0, openAtEnd: 0,
        },
      })
      .where(eq(schema.backtestRuns.id, runId));
  }

  // Init components
  if (!config.databentoApiKey) {
    throw new Error('Backtest requires a Databento API key. Set databentoApiKey in config.');
  }
  const clock = new SimClock(startDate);
  const priceProvider = new DatabentoMarketDataProvider(config.databentoApiKey, config.databentoDataset ?? 'DBEQ.BASIC', config.refreshQuoteCache ?? false, 'OPRA.PILLAR');
  const fillModel = config.fillModel ?? 'orats';
  const startingEquity = config.startingEquity ?? 100_000;
  const broker = new SimBroker(priceProvider, clock, runId, fillModel, startingEquity);

  const fetchBars = (symbol: string, barsBack: number) =>
    broker.getBars({ symbol, interval: '1', barsBack });

  const MAX_CONTRACTS: Record<string, number> = {
    CALL: 20, PUT: 20, CDS: 20, PDS: 20,
  };

  const sizingService = {
    async calculateSize(input: { trader: string; symbol: string; entryPrice: number; strategy: string; spreadMaxRisk?: number }) {
      const traderConfig = await getTrader(input.trader);
      const sizer = buildPositionSizer(traderConfig?.positionSizingConfig, fetchBars);
      const balance = await broker.getAccountBalance();
      return sizer.calculateSize({
        symbol: input.symbol,
        entryPrice: input.entryPrice,
        equity: balance.equity,
        spreadMaxRisk: input.spreadMaxRisk,
        maxQuantity: MAX_CONTRACTS[input.strategy],
      });
    },
  };

  const getOpenPositions = async (filters: PositionFilters = {}) =>
    broker.getOpenTrades(filters);

  const riskConfig: RiskCheckConfig = {
    maxOnSymbol: config.maxOnSymbol ?? 3,
    maxTotalPositions: config.maxTotalPositions ?? 20,
    maxDrawdownPct: config.maxDrawdownPct ?? 5,
    maxNotionalMultiplier: config.maxNotionalMultiplier ?? 2,
  };

  const riskDeps: RiskCheckDeps = {
    getOpenTrades: getOpenPositions,
    getDailyClosedPnl: async () => {
      const dateStr = clock.now().toISOString().split('T')[0];
      const result = await db.select({
        total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
      }).from(schema.trades).where(and(
        isClosed, forRun(runId),
        sql`closed_at LIKE ${dateStr + '%'}`,
      ));
      return safeParseFloat(result[0]?.total);
    },
    getStartingEquity: async () => startingEquity,
    getCurrentEquity: async () => (await broker.getAccountBalance()).equity,
  };

  // Map of working order IDs to their pending context for async fill recording.
  // Each PendingOrderContext includes a `recordFill` closure that captures all
  // pipeline metadata, so the onFill handler doesn't reconstruct recording payloads.
  const pendingIntents = new Map<string, PendingOrderContext>();

  const orderManager = new OrderManager({
    broker,
    clock: () => clock.now(),
    manualTick: true,
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

  // Create LLM provider for agent calls
  const agentIdentity = {
    provider: (config.agentProvider ?? DEFAULT_TRADE_MODEL.provider) as 'anthropic' | 'xai',
    model: config.agentModel ?? DEFAULT_TRADE_MODEL.model,
  };
  const agentProvider = await createProvider(agentIdentity);
  log.info(`Agent: ${agentIdentity.provider}/${agentIdentity.model}`);

  // Build PipelineDeps once — shared across all messages.
  // Risk checks are a no-op: the TradeAgent already ran checkRiskLimits
  // before any signal reaches the pipeline, so re-checking here would be
  // redundant work (same deps, same config, same result).
  const pipelineDeps: PipelineDeps = {
    broker,
    orderManager,
    getOpenPositions,
    calculatePositionSize: async (input) => sizingService.calculateSize(input),
    checkRiskLimits: async () => ({
      allowed: true as boolean, dailyPnl: 0,
      openPositionsOnSymbol: 0, totalOpenPositions: 0,
      maxTotalPositions: 0, totalNotional: 0, maxNotional: 0,
    }),
    recordTrade: (input) => recordTrade({
      ...input,
      backtestRunId: runId,
      isBacktest: true,
      metadata: { ...input.metadata, agentModel: `${agentIdentity.provider}:${agentIdentity.model}` },
    }),
    onPending: (orderId, context) => {
      pendingIntents.set(orderId, context);
    },
  };

  // Build the rule-based trade agent — wraps skip checks, risk, and sizing
  const tradeAgent = new RuleBasedTradeAgent({
    skipOpts: {
      maxOnSymbol: riskConfig.maxOnSymbol,
      maxTotalPositions: riskConfig.maxTotalPositions,
    },
    riskDeps,
    riskConfig,
    disableRiskLimits: config.disableRiskLimits,
    calculateSize: (input) => sizingService.calculateSize(input),
  });

  const btCtx: BacktestContext = {
    runId,
    config,
    priceProvider,
    agentProvider,
    pipelineDeps,
    tradeAgent,
    maxOnSymbol: riskConfig.maxOnSymbol,
    maxTotalPositions: riskConfig.maxTotalPositions,
  };

  // ── Phase 1: Batch intent extraction ──
  // Extract intents for all tradable messages up front (parallelized, cached).
  // This is the expensive LLM phase — subsequent replays reuse cached intents.
  const tradableIds = tradableMessages.map((m) => m.id);
  let rawMessages: Message[] = [];
  if (tradableIds.length > 0) {
    // SQLite has a variable limit; chunk if needed
    const CHUNK_SIZE = 500;
    for (let c = 0; c < tradableIds.length; c += CHUNK_SIZE) {
      const chunk = tradableIds.slice(c, c + CHUNK_SIZE);
      const rows = await db.select().from(schema.messages).where(inArray(schema.messages.id, chunk));
      rawMessages.push(...rows);
    }
  }

  const intentDeps: IntentExtractionDeps = {
    getQuote: (symbol, at) => priceProvider.getQuote(symbol, at),
    prefetch: (symbols, at) => priceProvider.prefetch(symbols, at),
    getTraderConfig: getTrader,
  };

  log.info(`Phase 1: Extracting intents for ${rawMessages.length} messages...`);
  const batchResult = await extractBatchIntents(
    rawMessages,
    agentIdentity.model,
    agentProvider,
    intentDeps,
    {
      version: INTENT_VERSION,
      onProgress: (progress) => {
        // Update live metrics during Phase 1 so the UI shows extraction progress
        if (progress.processed % 5 === 0 || progress.processed === progress.total) {
          db.update(schema.backtestRuns)
            .set({
              liveMetrics: buildLiveMetrics({
                unrealizedPnl: null,
                openPositionCount: 0,
                lastProcessedMessageTs: null,
                phase: 'EXTRACTING',
                extractedMessages: progress.processed,
                totalExtractMessages: progress.total,
              }),
            })
            .where(eq(schema.backtestRuns.id, runId))
            .catch(() => {}); // fire and forget
        }
      },
    },
  );
  const cachedIntents = batchResult.intents;
  log.info(`Phase 1 complete: ${batchResult.progress.cached} cached, ${batchResult.progress.fresh} fresh, ${batchResult.progress.errors} errors`);

  // Stats tracking
  let agentCallsUsed = 0;
  let agentTrades = 0;
  let skipped = 0;
  const skipReasons = new Map<string, number>();

  // Day-boundary tracking for MTM snapshots and option expiration sweeps
  let lastMsgDay = '';

  // Live metrics tracking — written to DB after every message
  resetApiStats();
  const MTM_INTERVAL_MS = 30_000;
  const MTM_INTERVAL_MSGS = 100;
  let lastMtmTime = 0;
  let lastMtmValue: number | null = null;
  let lastOpenCount = 0;

  // ── Phase 2: Deterministic replay ──
  log.info(`Phase 2: Replaying ${tradableMessages.length} messages...`);
  for (let i = 0; i < tradableMessages.length; i++) {
    const msg = tradableMessages[i];
    const msgDay = toDateKeyET(msg.timestamp);

    // ── Day boundary: sweep expired options + MTM snapshot ──
    if (lastMsgDay && msgDay !== lastMsgDay) {
      const openCount = await broker.getOpenPositionCount();
      if (openCount > 0) {
        // 1. Sweep expired options first (they become closed trades)
        const expiredCount = await broker.sweepExpired(lastMsgDay);
        if (expiredCount > 0) {
          log.debug(`Day ${lastMsgDay}: expired ${expiredCount} option position(s)`);
        }

        // 2. MTM snapshot for remaining open positions
        const eodTime = new Date(lastMsgDay + 'T20:00:00Z'); // 4pm ET
        const unrealizedPnl = await broker.getUnrealizedPnl(eodTime);
        await db.insert(schema.backtestMtmSnapshots).values({
          backtestRunId: runId,
          date: lastMsgDay,
          unrealizedPnl,
        });
        log.debug(`MTM ${lastMsgDay}: unrealized=$${unrealizedPnl.toFixed(2)}`);

        // 3. Margin call check
        const balance = await broker.getAccountBalance();
        if (balance.maintenanceMargin != null && balance.equity < balance.maintenanceMargin) {
          log.warn(`MARGIN CALL ${lastMsgDay}: equity $${balance.equity.toFixed(0)} < maintenance $${balance.maintenanceMargin.toFixed(0)}`);
        }
      }
    }

    lastMsgDay = msgDay;
    clock.advance(msg.timestamp);
    await broker.advanceTo(msg.timestamp);
    await orderManager.tick(msg.timestamp);

    if (i > 0 && i % 100 === 0) {
      const openTradesCount = await broker.getOpenPositionCount();
      const closedTradesCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isClosed, forRun(runId)));
      const totalPnlResult = await db.select({ total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)` }).from(schema.trades).where(and(isClosed, forRun(runId)));
      log.info(`Processed ${i}/${tradableMessages.length} messages | open=${openTradesCount} closed=${closedTradesCount[0].count} PnL=$${safeParseFloat(totalPnlResult[0].total).toFixed(2)}`);
    }

    // Unified: processMessage handles both cached intent and live agent paths
    await processMessage(
      msg, btCtx,
      { agentCallsUsed, agentTrades, skipped, skipReasons },
      (stats) => { agentCallsUsed = stats.agentCallsUsed; agentTrades = stats.agentTrades; skipped = stats.skipped; },
      cachedIntents.get(msg.id),
    );

    // ── Write liveMetrics after every message ──
    // MTM is expensive (price lookups per position) — throttle it
    const shouldRecomputeMtm =
      (i === 0) ||
      (i === tradableMessages.length - 1) ||
      (i % MTM_INTERVAL_MSGS === 0) ||
      (Date.now() - lastMtmTime > MTM_INTERVAL_MS);

    if (shouldRecomputeMtm) {
      try {
        lastMtmValue = await broker.getUnrealizedPnl();
        lastOpenCount = await broker.getOpenPositionCount();
        lastMtmTime = Date.now();
      } catch {
        // Failed to compute MTM — carry forward last known value.
        // This prevents an unexpected Databento fetch from slowing the loop.
      }
    }

    await db.update(schema.backtestRuns)
      .set({
        liveMetrics: buildLiveMetrics({
          unrealizedPnl: lastMtmValue,
          openPositionCount: lastOpenCount,
          lastProcessedMessageTs: msg.timestamp.toISOString(),
          phase: 'REPLAYING',
          extractedMessages: 0,
          totalExtractMessages: 0,
        }),
      })
      .where(eq(schema.backtestRuns.id, runId));
  }

  // Final day: sweep + MTM for the last trading day
  if (lastMsgDay) {
    const openCount = await broker.getOpenPositionCount();
    if (openCount > 0) {
      const expiredCount = await broker.sweepExpired(lastMsgDay);
      if (expiredCount > 0) {
        log.debug(`Day ${lastMsgDay} (final): expired ${expiredCount} option position(s)`);
      }

      const eodTime = new Date(lastMsgDay + 'T20:00:00Z');
      const unrealizedPnl = await broker.getUnrealizedPnl(eodTime);
      await db.insert(schema.backtestMtmSnapshots).values({
        backtestRunId: runId,
        date: lastMsgDay,
        unrealizedPnl,
      });
      log.debug(`MTM ${lastMsgDay} (final): unrealized=$${unrealizedPnl.toFixed(2)}`);
    }
  }

  orderManager.destroy();

  // Print market data quality summary
  priceProvider.printDataSummary();

  // Print end-of-run summary
  const finalOpenCount = await broker.getOpenPositionCount();
  const finalClosedCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isClosed, forRun(runId)));
  const finalPnlResult = await db.select({ total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)` }).from(schema.trades).where(and(isClosed, forRun(runId)));
  const totalPnl = safeParseFloat(finalPnlResult[0].total);
  log.info(`Done. trades=${agentTrades} skipped=${skipped} open=${finalOpenCount} closed=${finalClosedCount[0].count} PnL=$${totalPnl.toFixed(2)}`);
  if (skipReasons.size > 0) {
    const sorted = Array.from(skipReasons.entries()).sort((a, b) => b[1] - a[1]);
    log.info(`Skip reasons: ${sorted.map(([r, n]) => `${r}=${n}`).join(', ')}`);
  }
  log.info(`Generating report...`);

  const allTrades = await db.select().from(schema.trades).where(forRun(runId));
  const allDecisions = await db.select().from(schema.runDecisions).where(eq(schema.runDecisions.backtestRunId, runId));
  const mtmRows = await db.select().from(schema.backtestMtmSnapshots).where(eq(schema.backtestMtmSnapshots.backtestRunId, runId));

  const reportData = generateReportFromTrades({ trades: allTrades, decisions: allDecisions, mtmSnapshots: mtmRows, startingEquity, commissionSchedule: config.commissionSchedule });
  const report: BacktestReport = {
    config,
    ...reportData,
    skipReasons: Object.fromEntries(skipReasons),
  };
  report.summary.totalMessages = allMessages.length;
  report.summary.tradedMessages = tradableMessages.length;

  // Backfill PnL on runDecisions from the trades table (safety net)
  await backfillDecisionPnl(runId);

  return report;
}

/**
 * Backfill PnL on run_decisions from the trades table in a single UPDATE.
 */
async function backfillDecisionPnl(runId: string): Promise<void> {
  await db.run(sql`
    UPDATE run_decisions
    SET pnl = (
      SELECT CAST(SUM(CAST(t.pnl AS REAL)) AS TEXT) FROM trades t
      WHERE t.source_message_id = run_decisions.message_id
        AND t.backtest_run_id = ${runId}
        AND t.pnl IS NOT NULL
    )
    WHERE backtest_run_id = ${runId}
      AND decision = 'EXECUTE'
  `);
}

type Stats = {
  agentCallsUsed: number;
  agentTrades: number;
  skipped: number;
  skipReasons: Map<string, number>;
};

// referencesFutures moved to shared deterministic-skips.ts

/**
 * Context object passed through processMessage to avoid long parameter lists.
 * Captures everything needed for skip/execute/record decisions.
 */
type MessageContext = {
  msg: HistoricalMessage;
  runId: string;
  stats: Stats;
  updateStats: (stats: Stats) => void;
  decisionStart: number;
};

/** Record a skip decision — single place for the skip bookkeeping */
async function recordSkip(ctx: MessageContext, path: string, category: string, reason: string, usage?: LLMUsage): Promise<void> {
  log.debug(`  → skipped (${reason}) (${Date.now() - ctx.decisionStart}ms)`);
  ctx.stats.skipped++;
  ctx.stats.skipReasons.set(category, (ctx.stats.skipReasons.get(category) ?? 0) + 1);
  await db.insert(schema.runDecisions).values({
    backtestRunId: ctx.runId,
    messageId: ctx.msg.id,
    path,
    decision: 'SKIP',
    skipCategory: category,
    reasoning: reason,
    durationMs: Date.now() - ctx.decisionStart,
    ...(usage && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
  });
}

/** Record an execute decision */
async function recordExecute(
  ctx: MessageContext,
  path: string,
  reasoning: string,
  tradeId?: string,
  usage?: LLMUsage,
): Promise<void> {
  log.debug(`  → EXECUTE: ${reasoning} (${Date.now() - ctx.decisionStart}ms)`);
  ctx.stats.agentTrades++;
  await db.insert(schema.runDecisions).values({
    backtestRunId: ctx.runId,
    messageId: ctx.msg.id,
    path,
    decision: 'EXECUTE',
    reasoning,
    tradeId,
    durationMs: Date.now() - ctx.decisionStart,
    ...(usage && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
  });
}

// shouldSkipDeterministic moved to shared ../agent/deterministic-skips.ts

async function processMessage(
  msg: HistoricalMessage,
  btCtx: BacktestContext,
  stats: Stats,
  updateStats: (stats: Stats) => void,
  cachedIntent?: MessageIntent,
): Promise<void> {
  const ctx: MessageContext = { msg, runId: btCtx.runId, stats, updateStats, decisionStart: Date.now() };

  // ── 1. Shared logging ──
  log.debug(
    `msg ${msg.id.slice(0, 8)} | ${msg.author} | ${msg.symbols.join(',')} | ` +
    `action=${msg.actionHint ?? '?'} dir=${msg.directionHint ?? '?'} conf=${msg.confidence.toFixed(2)} ` +
    `badges=[${msg.badges.join(',')}]`,
  );
  if (msg.detectedStrategies.length > 0) {
    const stratStr = msg.detectedStrategies.map(s =>
      `${s.strategy}${s.strikes?.length ? ` strikes=${s.strikes.join('/')}` : ''}${s.expiry ? ` exp=${s.expiry}` : ''}`,
    ).join('; ');
    log.debug(`  strategies: ${stratStr}`);
  }
  log.debug(`  text: "${msg.cleanText.slice(0, 200)}${msg.cleanText.length > 200 ? '...' : ''}"`);

  // ── 2. Build TaskContext ──
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

  // ── 3. Extract signals from cached intent ──
  if (!cachedIntent) {
    // No cached intent — skip this message (intent extraction should always
    // happen in Phase 1 batch; this is a safety fallback)
    await recordSkip(ctx, 'skipped', 'no intent', 'No cached intent for message');
    updateStats(stats);
    return;
  }

  const decision = cachedIntent.decision;
  const signals = cachedIntent.signals ?? null;
  const reasoning = cachedIntent.reasoning ?? 'No reasoning';
  const usage: LLMUsage = { inputTokens: cachedIntent.inputTokens ?? 0, outputTokens: cachedIntent.outputTokens ?? 0 };

  // ── 4. Handle non-EXECUTE decisions ──
  if (decision !== 'EXECUTE' || !signals || signals.length === 0) {
    await recordSkip(ctx, 'intent', 'intent skip', reasoning, usage);
    updateStats(stats);
    return;
  }

  // ── 5. Prefetch quotes + positions for deterministic skip checks ──
  await btCtx.priceProvider.prefetch(msg.symbols, msg.timestamp);
  let prefetched: PrefetchedData | undefined;
  try {
    prefetched = await prefetchForAgent(
      { symbols: msg.symbols, author: msg.author },
      {
        broker: btCtx.pipelineDeps.broker,
        getOpenPositions: btCtx.pipelineDeps.getOpenPositions,
      },
    );
  } catch {
    prefetched = undefined;
  }

  // ── 6. Run trade agent (deterministic skip + risk + sizing) ──

  // Process each signal through the trade agent
  const allActions: Action[] = [];
  for (const signal of signals) {
    const actions = await btCtx.tradeAgent.onSignal(signal, msg.author, taskContext, prefetched);
    allActions.push(...actions);
  }

  // ── 7. Execute actions through the pipeline ──
  const executeableSignals = allActions
    .filter((a): a is Extract<Action, { type: 'PLACE_ORDER' }> => a.type === 'PLACE_ORDER')
    .map(a => a.signal);

  const noOps = allActions.filter(a => a.type === 'NO_OP');

  if (executeableSignals.length === 0) {
    const noOpReason = noOps.length > 0
      ? noOps.map(a => a.reasoning).join('; ')
      : reasoning;
    await recordSkip(ctx, 'intent', 'agent skip', noOpReason, usage);
    updateStats(stats);
    return;
  }

  const pipelineResults = await executeSignals(
    executeableSignals,
    msg.author,
    btCtx.pipelineDeps,
    {
      messageId: msg.id,
      backtestRunId: btCtx.runId,
      isBacktest: true,
      allowedStrategies: (await getTrader(msg.author))?.strategies ?? undefined,
    },
  );

  const executedResults = pipelineResults.filter(r => r.executed);
  const pendingResults = pipelineResults.filter(r => !r.executed && r.orderId);
  const firstTradeId = executedResults[0]?.tradeId;

  const pipelineFailures = pipelineResults
    .filter(r => !r.executed && !r.orderId && r.reason)
    .map(r => `${r.signal.action} ${r.signal.symbol}: ${r.reason}`);

  // ── 8. Record result ──
  // Working orders (pendingResults) count as executions — they'll fill via
  // advanceTo() and get recorded through the onFill callback.
  if (executedResults.length > 0 || pendingResults.length > 0) {
    await recordExecute(ctx, 'intent', reasoning, firstTradeId, usage);
  } else if (pipelineFailures.length > 0) {
    const failReason = `[pipeline] ${pipelineFailures.join('; ')} | Intent: ${reasoning}`;
    log.warn(`  intent: EXECUTE → pipeline failed: ${pipelineFailures.join('; ')}`);
    await recordSkip(ctx, 'pipeline_failure', 'pipeline failure', failReason, usage);
  } else {
    await recordSkip(ctx, 'intent', 'intent skip', reasoning, usage);
  }

  // ── 9. Update stats ──
  updateStats(stats);
}
