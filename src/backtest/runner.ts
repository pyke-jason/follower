import { SimClock } from './clock.js';
import { DatabentoMarketDataProvider } from './market-data.js';
import type { BacktestPriceProvider } from './market-data.js';
import { SimBroker } from './sim-broker.js';
import { checkRiskLimits, type RiskCheckConfig, type RiskCheckDeps } from '../orders/risk-check.js';
import { loadHistoricalMessages } from './historical-loader.js';
import { generateReportFromTrades } from './report.js';
import type { MtmSnapshot } from './report.js';
import { toDateKeyET } from '../lib/et-date.js';
import { formatOccSymbol } from './occ-symbology.js';
import { createClassificationTools } from '../agent/tool-factory.js';
import { executeSignals } from '../pipeline/execute.js';
import type { PipelineDeps, PendingOrderContext } from '../pipeline/execute.js';
import { runAgent } from '../agent/trade-agent.js';
import { prefetchForAgent } from '../agent/prefetch.js';
import type { PrefetchedData } from '../agent/prefetch.js';
import { shouldSkipDeterministic } from '../agent/deterministic-skips.js';
import type { LLMProvider } from '../agent/providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from '../agent/providers.js';
import { getTrader } from '../config/traders.js';
import { OrderManager } from '../orders/order-manager.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { recordTrade } from '../trades/record-trade.js';
import { isOpen, isClosed, forRun, forSymbol, forTrader } from '../trades/filters.js';
import type { BacktestConfig, BacktestReport, FillModel, HistoricalMessage, LiveMetrics } from './types.js';
import type { TaskContext } from '../db/schema.js';
import type { Trade } from '../db/schema.js';
import type { LLMUsage } from '../agent/providers.js';
import { getApiStats, resetApiStats } from './databento-tape.js';
import { createLogger } from '../lib/logger.js';
import { safeParseFloat, roundCents } from '../lib/numbers.js';
import { extractBatchIntents } from '../intents/extract-batch.js';
import type { IntentExtractionDeps } from '../intents/extract-intent.js';
import { INTENT_VERSION } from '../intents/extract-intent.js';
import { replayMessageWithIntent } from './replay.js';
import type { ReplayDeps } from './replay.js';
import type { MessageIntent, Message } from '../db/schema.js';
import { inArray } from 'drizzle-orm';

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
  maxOnSymbol: number;
  maxTotalPositions: number;
};

const log = createLogger('Backtest');

/**
 * Build a map of trade ID -> current mark price for all open positions.
 * For stocks: mid price. For options: re-quote each leg and compute net premium.
 * Errors are caught per-position (no data = skip).
 */
async function buildMarkPrices(
  runId: string,
  priceProvider: BacktestPriceProvider,
  at: Date,
): Promise<Map<string, number>> {
  const markPrices = new Map<string, number>();

  const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(runId)));

  for (const t of openTrades) {
    try {
      if (t.strategy === 'STOCK') {
        const quote = await priceProvider.getQuote(t.symbol, at);
        markPrices.set(t.id, (quote.bid + quote.ask) / 2);
      } else if (Array.isArray(t.legs) && (t.legs as any[]).length > 0) {
        // Options/spreads: re-quote each leg and compute net premium
        let netPremium = 0;
        let allLegsQuoted = true;
        const legs = t.legs as { symbol: string; strike: number; expiry: string; type: string; action: string; quantity: number; fillPrice: number }[];
        for (const leg of legs) {
          try {
            const occSymbol = formatOccSymbol({
              underlying: t.symbol,
              expiration: leg.expiry,
              type: leg.type === 'STOCK' ? 'CALL' : leg.type as 'CALL' | 'PUT',
              strike: leg.strike,
            });
            const quote = await priceProvider.getQuote(occSymbol, at);
            const legMid = (quote.bid + quote.ask) / 2;
            // BUY legs are assets (positive value), SELL legs are liabilities (negative)
            netPremium += leg.action === 'BUY' ? legMid : -legMid;
          } catch {
            allLegsQuoted = false;
            break;
          }
        }
        if (allLegsQuoted) {
          markPrices.set(t.id, netPremium);
        }
      } else {
        // Single-leg option without legs array — quote the position symbol directly
        const quote = await priceProvider.getQuote(t.symbol, at);
        markPrices.set(t.id, (quote.bid + quote.ask) / 2);
      }
    } catch {
      // No data for this position — skip (unrealized = $0 for this position)
    }
  }

  return markPrices;
}

/**
 * Compute unrealized PnL from trade rows and mark prices.
 */
function computeUnrealizedPnl(trades: Trade[], markPrices: Map<string, number>): number {
  let total = 0;
  for (const t of trades) {
    const markPrice = markPrices.get(t.id);
    if (markPrice == null) continue;
    const diff = markPrice - safeParseFloat(t.entryPrice);
    const multiplier = t.direction === 'LONG' ? 1 : -1;
    const contractMultiplier = t.strategy === 'STOCK' ? 1 : 100;
    total += diff * multiplier * (t.quantity ?? 1) * contractMultiplier;
  }
  return roundCents(total);
}

/**
 * Sweep expired options: at each day boundary, check all open option positions
 * and close any with expired legs at intrinsic value (ITM) or $0 (OTM).
 */
async function sweepExpiredOptions(
  runId: string,
  priceProvider: BacktestPriceProvider,
  currentDate: string, // YYYY-MM-DD
): Promise<number> {
  let closedCount = 0;

  const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(runId)));

  for (const t of openTrades) {
    if (t.strategy === 'STOCK') continue;
    const legs = Array.isArray(t.legs) ? t.legs as { symbol: string; strike: number; expiry: string; type: string; action: string; quantity: number; fillPrice: number }[] : [];
    if (legs.length === 0) continue;

    // Check if any leg has expired
    const hasExpiredLeg = legs.some((leg) => leg.expiry <= currentDate);
    if (!hasExpiredLeg) continue;

    // Compute intrinsic value of the position at expiry
    let netIntrinsic = 0;
    for (const leg of legs) {
      if (leg.expiry > currentDate) continue; // only process expired legs
      if (leg.type === 'STOCK') continue;

      let underlyingPrice: number;
      try {
        // Get underlying quote at the expired date
        const expiryDate = new Date(leg.expiry + 'T20:00:00Z'); // 4pm ET
        const quote = await priceProvider.getQuote(t.symbol, expiryDate);
        underlyingPrice = (quote.bid + quote.ask) / 2;
      } catch {
        // No underlying data — assume $0 intrinsic (conservative)
        underlyingPrice = leg.type === 'CALL' ? 0 : Infinity;
      }

      const intrinsic = leg.type === 'CALL'
        ? Math.max(0, underlyingPrice - leg.strike)
        : Math.max(0, leg.strike - underlyingPrice);

      // BUY legs are positive (we receive intrinsic), SELL legs negative (we pay)
      netIntrinsic += leg.action === 'BUY' ? intrinsic : -intrinsic;
    }

    // Close the position at net intrinsic value
    const exitPrice = Math.max(0, netIntrinsic); // floor at 0 for net debit positions
    const expiryTimestamp = new Date(currentDate + 'T20:00:00Z');

    // Compute PnL
    const entry = safeParseFloat(t.entryPrice);
    const diff = exitPrice - entry;
    const multiplier = t.direction === 'LONG' ? 1 : -1;
    const contractMultiplier = t.strategy === 'STOCK' ? 1 : 100;
    const pnl = roundCents(diff * multiplier * (t.quantity ?? 1) * contractMultiplier);

    await db.update(schema.trades)
      .set({
        status: 'CLOSED',
        exitPrice: String(exitPrice),
        pnl: String(pnl),
        closedAt: expiryTimestamp.toISOString(),
      })
      .where(eq(schema.trades.id, t.id));

    log.debug(`EXPIRE: ${t.id} ${t.symbol} ${t.strategy} intrinsic=$${netIntrinsic.toFixed(2)} exit=$${exitPrice.toFixed(2)} PnL=$${pnl.toFixed(2)}`);
    closedCount++;
  }

  return closedCount;
}

/**
 * Backtest orchestrator.
 * Loads messages, initializes sim components, and replays chronologically.
 * When runId is provided, persists all results to the DB.
 */
export async function runBacktest(config: BacktestConfig, runId?: string): Promise<BacktestReport> {
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

async function runBacktestInner(config: BacktestConfig, runId?: string): Promise<BacktestReport> {
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

  const sizer = buildPositionSizer(
    null, // default ATR config: 5% risk, 2x ATR, 14 period
    (symbol, barsBack) => broker.getBars({ symbol, interval: '1', barsBack }),
  );

  const MAX_CONTRACTS: Record<string, number> = {
    CALL: 20, PUT: 20, CDS: 20, PDS: 20,
  };

  const sizingService = {
    async calculateSize(input: { trader: string; symbol: string; entryPrice: number; strategy: string; spreadMaxRisk?: number }) {
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

  const getOpenPositions = async (filters: { symbol?: string; trader?: string } = {}) => {
    const conditions = [isOpen, forRun(runId)];
    if (filters.symbol) conditions.push(forSymbol(filters.symbol));
    if (filters.trader) conditions.push(forTrader(filters.trader));
    return db.select().from(schema.trades).where(and(...conditions));
  };

  const riskConfig: RiskCheckConfig = config.disableRiskLimits
    ? { maxOnSymbol: 999, maxTotalPositions: 999, maxDrawdownPct: 100, maxNotionalMultiplier: 100 }
    : {
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
    onFill: async (order) => {
      const pending = pendingIntents.get(order.orderId);
      if (!pending) return;
      pendingIntents.delete(order.orderId);
      await pending.recordFill(order.filledPrice!, order.filledAt);
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

  // Build PipelineDeps once — shared across all messages
  const pipelineDeps: PipelineDeps = {
    broker,
    orderManager,
    getOpenPositions,
    calculatePositionSize: async (input) => sizingService.calculateSize(input),
    checkRiskLimits: (input) => checkRiskLimits(input, riskDeps, riskConfig),
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

  const btCtx: BacktestContext = {
    runId,
    config,
    priceProvider,
    agentProvider,
    pipelineDeps,
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
    getOptionsChain: (symbol, expiry, optionType, at) => priceProvider.getOptionsChain(symbol, expiry, optionType, at),
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
      concurrency: config.intentConcurrency ?? 5,
      version: INTENT_VERSION,
      onProgress: (progress) => {
        // Update live metrics during Phase 1 so the UI shows progress
        if (progress.processed % 5 === 0 || progress.processed === progress.total) {
          db.update(schema.backtestRuns)
            .set({
              liveMetrics: {
                unrealizedPnl: null,
                openPositionCount: 0,
                databentoApiFetches: 0,
                databentoApiBytesRead: 0,
                updatedAt: new Date().toISOString(),
              } satisfies LiveMetrics,
            })
            .where(eq(schema.backtestRuns.id, runId))
            .catch(() => {}); // fire and forget
        }
      },
    },
  );
  const cachedIntents = batchResult.intents;
  log.info(`Phase 1 complete: ${batchResult.progress.cached} cached, ${batchResult.progress.fresh} fresh, ${batchResult.progress.errors} errors`);

  // Build replay deps for Phase 2
  const replayDeps: ReplayDeps = {
    runId,
    pipelineDeps,
    maxOnSymbol: riskConfig.maxOnSymbol,
    maxTotalPositions: riskConfig.maxTotalPositions,
  };

  // Stats tracking
  let agentCallsUsed = 0;
  let agentTrades = 0;
  let skipped = 0;
  const skipReasons = new Map<string, number>();

  // Day-boundary tracking for MTM snapshots and option expiration sweeps
  let lastMsgDay = '';
  const mtmSnapshots: MtmSnapshot[] = [];

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
      const openCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isOpen, forRun(runId)));
      if (openCount[0].count > 0) {
        // 1. Sweep expired options first (they become closed trades)
        const expiredCount = await sweepExpiredOptions(runId, priceProvider, lastMsgDay);
        if (expiredCount > 0) {
          log.debug(`Day ${lastMsgDay}: expired ${expiredCount} option position(s)`);
        }

        // 2. MTM snapshot for remaining open positions
        const eodTime = new Date(lastMsgDay + 'T20:00:00Z'); // 4pm ET
        const markPrices = await buildMarkPrices(runId, priceProvider, eodTime);
        const openTradesForMtm = await db.select().from(schema.trades).where(and(isOpen, forRun(runId)));
        const unrealizedPnl = computeUnrealizedPnl(openTradesForMtm, markPrices);
        mtmSnapshots.push({ date: lastMsgDay, unrealizedPnl });
        log.debug(`MTM ${lastMsgDay}: unrealized=$${unrealizedPnl.toFixed(2)} (${markPrices.size}/${openTradesForMtm.length} positions marked)`);
      }
    }

    lastMsgDay = msgDay;
    clock.advance(msg.timestamp);
    await broker.advanceTo(msg.timestamp);
    await orderManager.tick(msg.timestamp);

    if (i > 0 && i % 100 === 0) {
      const openTradesCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isOpen, forRun(runId)));
      const closedTradesCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isClosed, forRun(runId)));
      const totalPnlResult = await db.select({ total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)` }).from(schema.trades).where(and(isClosed, forRun(runId)));
      log.info(`Processed ${i}/${tradableMessages.length} messages | open=${openTradesCount[0].count} closed=${closedTradesCount[0].count} PnL=$${safeParseFloat(totalPnlResult[0].total).toFixed(2)}`);
    }

    // Use cached intent (Phase 2 replay) if available, otherwise fall back to agent
    const cachedIntent = cachedIntents.get(msg.id);
    if (cachedIntent) {
      const decisionStart = Date.now();
      const replayResult = await replayMessageWithIntent(msg, cachedIntent, replayDeps);
      const durationMs = Date.now() - decisionStart;

      if (replayResult.traded) {
        agentTrades++;
        await db.insert(schema.runDecisions).values({
          backtestRunId: runId,
          messageId: msg.id,
          path: 'intent',
          decision: 'EXECUTE',
          reasoning: replayResult.reasoning,
          tradeId: replayResult.tradeId,
          durationMs,
          inputTokens: cachedIntent.inputTokens,
          outputTokens: cachedIntent.outputTokens,
        });
      } else {
        skipped++;
        const category = replayResult.pipelineFailure ? 'pipeline failure' : (replayResult.intentDecision === 'EXECUTE' ? 'replay skip' : 'intent skip');
        const reason = replayResult.pipelineFailure
          ? `[pipeline] ${replayResult.pipelineFailure} | Intent: ${replayResult.reasoning}`
          : replayResult.reasoning;
        skipReasons.set(category, (skipReasons.get(category) ?? 0) + 1);
        await db.insert(schema.runDecisions).values({
          backtestRunId: runId,
          messageId: msg.id,
          path: replayResult.pipelineFailure ? 'pipeline_failure' : 'intent',
          decision: 'SKIP',
          reasoning: reason,
          durationMs,
          inputTokens: cachedIntent.inputTokens,
          outputTokens: cachedIntent.outputTokens,
        });
      }
    } else {
      // Fallback: no cached intent — run the full agent path
      await processMessage(
        msg, btCtx,
        { agentCallsUsed, agentTrades, skipped, skipReasons },
        (stats) => { agentCallsUsed = stats.agentCallsUsed; agentTrades = stats.agentTrades; skipped = stats.skipped; },
      );
    }

    // ── Write liveMetrics after every message ──
    // MTM is expensive (price lookups per position) — throttle it
    const shouldRecomputeMtm =
      (i === 0) ||
      (i === tradableMessages.length - 1) ||
      (i % MTM_INTERVAL_MSGS === 0) ||
      (Date.now() - lastMtmTime > MTM_INTERVAL_MS);

    if (shouldRecomputeMtm) {
      try {
        const markPrices = await buildMarkPrices(runId, priceProvider, clock.now());
        const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(runId)));
        lastMtmValue = computeUnrealizedPnl(openTrades, markPrices);
        lastOpenCount = openTrades.length;
        lastMtmTime = Date.now();
      } catch {
        // Failed to compute MTM — carry forward last known value.
        // This prevents an unexpected Databento fetch from slowing the loop.
      }
    }

    const apiStats = getApiStats();
    await db.update(schema.backtestRuns)
      .set({
        liveMetrics: {
          unrealizedPnl: lastMtmValue,
          openPositionCount: lastOpenCount,
          databentoApiFetches: apiStats.fetches,
          databentoApiBytesRead: apiStats.bytesRead,
          updatedAt: new Date().toISOString(),
        } satisfies LiveMetrics,
      })
      .where(eq(schema.backtestRuns.id, runId));
  }

  // Final day: sweep + MTM for the last trading day
  if (lastMsgDay) {
    const openCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isOpen, forRun(runId)));
    if (openCount[0].count > 0) {
      const expiredCount = await sweepExpiredOptions(runId, priceProvider, lastMsgDay);
      if (expiredCount > 0) {
        log.debug(`Day ${lastMsgDay} (final): expired ${expiredCount} option position(s)`);
      }

      const eodTime = new Date(lastMsgDay + 'T20:00:00Z');
      const markPrices = await buildMarkPrices(runId, priceProvider, eodTime);
      const openTradesForMtm = await db.select().from(schema.trades).where(and(isOpen, forRun(runId)));
      const unrealizedPnl = computeUnrealizedPnl(openTradesForMtm, markPrices);
      mtmSnapshots.push({ date: lastMsgDay, unrealizedPnl });
      log.debug(`MTM ${lastMsgDay} (final): unrealized=$${unrealizedPnl.toFixed(2)} (${markPrices.size}/${openTradesForMtm.length} positions marked)`);
    }
  }

  orderManager.destroy();

  // Print market data quality summary
  priceProvider.printDataSummary();

  // Print end-of-run summary
  const finalOpenCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isOpen, forRun(runId)));
  const finalClosedCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isClosed, forRun(runId)));
  const finalPnlResult = await db.select({ total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)` }).from(schema.trades).where(and(isClosed, forRun(runId)));
  const totalPnl = safeParseFloat(finalPnlResult[0].total);
  log.info(`Done. trades=${agentTrades} skipped=${skipped} open=${finalOpenCount[0].count} closed=${finalClosedCount[0].count} PnL=$${totalPnl.toFixed(2)}`);
  if (skipReasons.size > 0) {
    const sorted = Array.from(skipReasons.entries()).sort((a, b) => b[1] - a[1]);
    log.info(`Skip reasons: ${sorted.map(([r, n]) => `${r}=${n}`).join(', ')}`);
  }
  log.info(`Generating report...`);

  const allTrades = await db.select().from(schema.trades).where(forRun(runId));
  const allDecisions = await db.select().from(schema.runDecisions).where(eq(schema.runDecisions.backtestRunId, runId));

  const reportData = generateReportFromTrades({ trades: allTrades, decisions: allDecisions, mtmSnapshots });
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
      SELECT t.pnl FROM trades t
      WHERE t.source_message_id = run_decisions.message_id
        AND t.backtest_run_id = ${runId}
        AND t.pnl IS NOT NULL
      LIMIT 1
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
    reasoning: reason,
    durationMs: Date.now() - ctx.decisionStart,
    ...(usage && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
  });
}

/** Record an execute decision */
async function recordExecute(
  ctx: MessageContext,
  reasoning: string,
  tradeId?: string,
  usage?: LLMUsage,
): Promise<void> {
  log.debug(`  → EXECUTE: ${reasoning} (${Date.now() - ctx.decisionStart}ms)`);
  ctx.stats.agentTrades++;
  await db.insert(schema.runDecisions).values({
    backtestRunId: ctx.runId,
    messageId: ctx.msg.id,
    path: 'agent',
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
): Promise<void> {
  const ctx: MessageContext = { msg, runId: btCtx.runId, stats, updateStats, decisionStart: Date.now() };

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

  // Prefetch quotes, positions, and trader profile.
  let prefetched: PrefetchedData | undefined;
  try {
    prefetched = await prefetchForAgent(taskContext, {
      broker: btCtx.pipelineDeps.broker,
      getOpenPositions: btCtx.pipelineDeps.getOpenPositions,
      getTraderConfig: getTrader,
    });
  } catch (err) {
    log.warn(`  prefetch failed: ${err instanceof Error ? err.message : err}`);
  }

  // Deterministic pre-checks using prefetched data
  const skip = shouldSkipDeterministic(taskContext, prefetched, {
    maxOnSymbol: btCtx.maxOnSymbol,
    maxTotalPositions: btCtx.maxTotalPositions,
    agentCallsUsed: stats.agentCallsUsed,
    maxAgentCalls: btCtx.config.maxAgentCalls,
  });
  if (skip) {
    await recordSkip(ctx, 'skipped', skip.category, skip.reason);
    updateStats(stats);
    return;
  }

  const callNum = stats.agentCallsUsed + 1;
  const maxCalls = btCtx.config.maxAgentCalls ?? '∞';
  const agentModel = btCtx.config.agentModel ?? 'default';
  log.debug(`  path: AGENT (call ${callNum}/${maxCalls}, model=${agentModel})`);
  const agentStart = Date.now();

  const agentResult = await runAgentForBacktest(msg, btCtx, taskContext, prefetched);
  const agentDuration = Date.now() - agentStart;
  stats.agentCallsUsed++;
  const tokenStr = `, ${((agentResult.usage.inputTokens + agentResult.usage.outputTokens) / 1000).toFixed(1)}k tokens`;
  if (agentResult.traded) {
    log.debug(`  agent: EXECUTE in ${agentDuration}ms (${agentResult.turns} turns${tokenStr})`);
    await recordExecute(ctx, agentResult.reasoning, agentResult.tradeId, agentResult.usage);
  } else if (agentResult.pipelineFailure) {
    const failReason = `[pipeline] ${agentResult.pipelineFailure} | Agent: ${agentResult.reasoning}`;
    log.warn(`  agent: EXECUTE → pipeline failed in ${agentDuration}ms: ${agentResult.pipelineFailure}`);
    await recordSkip(ctx, 'pipeline_failure', 'pipeline failure', failReason, agentResult.usage);
  } else {
    log.debug(`  agent: skip in ${agentDuration}ms (${agentResult.turns} turns${tokenStr})`);
    await recordSkip(ctx, 'agent', 'agent skip', agentResult.reasoning, agentResult.usage);
  }
  updateStats(stats);
}

async function runAgentForBacktest(
  msg: HistoricalMessage,
  btCtx: BacktestContext,
  taskContext: TaskContext,
  prefetched?: PrefetchedData,
): Promise<{ traded: boolean; tradeId?: string; reasoning: string; usage: LLMUsage; turns: number; pipelineFailure?: string }> {
  // Prefetch Databento data for the symbols in this message
  await btCtx.priceProvider.prefetch(msg.symbols, msg.timestamp);

  // Classification-only tools — no execution capabilities
  const classificationTools = createClassificationTools({
    broker: btCtx.pipelineDeps.broker,
    getOpenPositions: btCtx.pipelineDeps.getOpenPositions,
  });

  try {
    const agentResult = await runAgent(taskContext, classificationTools, btCtx.agentProvider, prefetched);
    const { steps, result, usage } = agentResult;
    const model = agentResult.model;
    const toolTurns = steps.filter(s => s.tool).length;

    const traded = result?.decision === 'EXECUTE' && result.signals && result.signals.length > 0;
    const reasoning = result?.reasoning ?? 'Agent decided to skip';

    let executedResults: { executed: boolean; tradeId?: string }[] = [];
    let firstTradeId: string | undefined;
    let pipelineFailures: string[] = [];

    if (traded) {
      const pipelineResults = await executeSignals(
        result.signals!,
        msg.author,
        btCtx.pipelineDeps,
        { messageId: msg.id, backtestRunId: btCtx.runId, isBacktest: true },
      );

      executedResults = pipelineResults.filter(r => r.executed);
      firstTradeId = executedResults[0]?.tradeId;

      // Collect pipeline failure reasons for logging
      pipelineFailures = pipelineResults
        .filter(r => !r.executed && r.reason)
        .map(r => `${r.signal.action} ${r.signal.symbol}: ${r.reason}`);
    }

    // Persist task + steps for ALL agent decisions (not just executes)
    const btTaskId = crypto.randomUUID();
    const didExecute = executedResults.length > 0 && firstTradeId;
    await db.insert(schema.tasks).values({
      id: btTaskId,
      messageId: msg.id,
      taskType: didExecute ? 'EXECUTE_TRADE' : 'REVIEW_MESSAGE',
      status: didExecute ? 'COMPLETED' : 'SKIPPED',
      assignee: 'agent',
      modelProvider: model.provider,
      modelName: model.model,
      context: taskContext,
      result: { decision: didExecute ? 'EXECUTE' : 'SKIP', reasoning },
      createdAt: msg.timestamp.toISOString(),
      completedAt: msg.timestamp.toISOString(),
      backtestRunId: btCtx.runId,
    });

    if (didExecute) {
      for (const pr of executedResults) {
        if (pr.tradeId) {
          await db.update(schema.trades)
            .set({ taskId: btTaskId })
            .where(eq(schema.trades.id, pr.tradeId));
        }
      }
    }

    for (let si = 0; si < steps.length; si++) {
      const step = steps[si];
      await db.insert(schema.taskSteps).values({
        taskId: btTaskId,
        stepNumber: si + 1,
        toolName: step.tool ?? null,
        toolInput: step.input ?? null,
        toolOutput: step.output ?? null,
        reasoning: step.reasoning ?? null,
        durationMs: step.durationMs ?? null,
      });
    }

    return {
      traded: executedResults.length > 0,
      tradeId: firstTradeId,
      reasoning,
      usage,
      turns: toolTurns,
      pipelineFailure: traded && executedResults.length === 0 && pipelineFailures.length > 0
        ? pipelineFailures.join('; ')
        : undefined,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`  agent error: ${errMsg}`);
    throw err;
  }
}
