import { SimClock } from './clock.js';
import { DatabentoMarketDataProvider } from './market-data.js';
import type { BacktestPriceProvider } from './market-data.js';
import { SimBroker, cutoffMinus15Min } from './sim-broker.js';
import type { RiskCheckConfig, RiskCheckDeps } from '../orders/risk-check.js';
import { checkRiskLimits } from '../orders/risk-check.js';
import { BACKTEST_RISK_DEFAULTS, MAX_CONTRACTS, DEFAULT_STARTING_EQUITY } from '../config/risk-defaults.js';
import { loadHistoricalMessages } from './historical-loader.js';
import { generateReportFromTrades } from './report.js';
import { toDateKeyET, parseDateKey } from '../lib/et-date.js';
import type { ResolvedPipelineDeps, ResolvedPendingContext } from '../pipeline/execute-resolved.js';
import type { LLMProvider } from '../agent/providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from '../agent/providers.js';
import { processTask as processTaskShared } from '../pipeline/process-task.js';
import { tradeToOpenPosition } from '../trades/adapters.js';
import { getTrader } from '../config/traders.js';
import { OrderManager } from '../orders/order-manager.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { recordTrade } from '../trades/record-trade.js';
import { isClosed, forRun, type PositionFilters } from '../trades/filters.js';
import type { BacktestConfig, BacktestReport, HistoricalMessage } from './types.js';
import { buildLiveMetrics } from './live-metrics.js';
import type { LLMUsage } from '../agent/providers.js';
import { resetApiStats, getApiStats } from './databento-tape.js';
import { tickCacheDb } from '../db/tick-cache-client.js';
import { createLogger } from '../lib/logger.js';
import { safeParseFloat } from '../lib/numbers.js';
import { logExpiryNotices } from '../lib/expiry-warning.js';
import type { Task, TradeLeg } from '../db/schema.js';

const log = createLogger('Backtest');

/**
 * Bundles all backtest-scoped dependencies so processMessage doesn't
 * need a dozen positional parameters.
 */
type BacktestContext = {
  runId: string;
  config: BacktestConfig;
  priceProvider: BacktestPriceProvider;
  agentProvider: LLMProvider;
  pipelineDeps: ResolvedPipelineDeps;
  getOpenPositions: (filters?: PositionFilters) => Promise<typeof schema.trades.$inferSelect[]>;
};

/**
 * Backtest orchestrator.
 * Loads messages, initializes sim components, and replays chronologically.
 */
export async function runBacktest(config: BacktestConfig, runId: string): Promise<BacktestReport> {
  const startTime = Date.now();

  if (runId) {
    await db.update(schema.backtestRuns)
      .set({ status: 'RUNNING', startedAt: new Date().toISOString() })
      .where(eq(schema.backtestRuns.id, runId));
  }

  try {
    const report = await runBacktestInner(config, runId);

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

  const allMessages = await loadHistoricalMessages({
    startDate,
    endDate,
    traders: config.traders,
  });

  log.info(`Loaded ${allMessages.length} messages`);

  const tradableMessages = allMessages.filter(
    (m) => m.symbols.length > 0 && !m.isPaperTrade,
  );

  log.info(`${tradableMessages.length} tradable messages (with symbols, not paper)`);

  // Write totalMessages early so web UI knows the progress denominator
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
  const priceProvider = new DatabentoMarketDataProvider(config.databentoApiKey, tickCacheDb, config.databentoDataset ?? 'DBEQ.BASIC', config.refreshQuoteCache ?? false, 'OPRA.PILLAR');
  const fillModel = config.fillModel ?? 'orats';
  const startingEquity = config.startingEquity ?? DEFAULT_STARTING_EQUITY;
  const broker = new SimBroker(priceProvider, clock, runId, fillModel, startingEquity);

  const sizingService = {
    async calculateSize(input: { trader: string; symbol: string; entryPrice: number; strategy: string; spreadMaxRisk?: number }) {
      const traderConfig = await getTrader(input.trader);
      const sizer = buildPositionSizer(traderConfig?.positionSizingConfig);
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
    maxOnSymbol: config.maxOnSymbol ?? BACKTEST_RISK_DEFAULTS.maxOnSymbol,
    maxTotalPositions: config.maxTotalPositions ?? BACKTEST_RISK_DEFAULTS.maxTotalPositions,
    maxDrawdownPct: config.maxDrawdownPct ?? BACKTEST_RISK_DEFAULTS.maxDrawdownPct,
    maxNotionalMultiplier: config.maxNotionalMultiplier ?? BACKTEST_RISK_DEFAULTS.maxNotionalMultiplier,
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

  const pendingIntents = new Map<string, ResolvedPendingContext>();

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

  const agentIdentity = {
    provider: (config.agentProvider ?? DEFAULT_TRADE_MODEL.provider) as 'anthropic' | 'xai',
    model: config.agentModel ?? DEFAULT_TRADE_MODEL.model,
  };
  const agentProvider = await createProvider(agentIdentity);
  log.info(`Agent: ${agentIdentity.provider}/${agentIdentity.model}`);

  const pipelineDeps: ResolvedPipelineDeps = {
    broker,
    orderManager,
    calculatePositionSize: async (input) => sizingService.calculateSize(input),
    checkRiskLimits: config.disableRiskLimits
      ? async () => ({ allowed: true as boolean, dailyPnl: 0, openPositionsOnSymbol: 0, totalOpenPositions: 0, maxTotalPositions: 0, totalNotional: 0, maxNotional: 0 })
      : (input) => checkRiskLimits(input, riskDeps, riskConfig),
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
    getOpenPositions,
  };

  // Stats tracking
  let agentTrades = 0;
  let skipped = 0;
  const skipReasons = new Map<string, number>();
  let failedEntrySignals = 0;
  let failedExitSignals = 0;
  let expiredWithoutSignal = 0;

  // Day-boundary tracking for MTM snapshots and option expiration sweeps
  let lastMsgDay = '';

  // Live metrics tracking — written to DB after every message
  const MTM_INTERVAL_MS = 30_000;
  const MTM_INTERVAL_MSGS = 100;
  let lastMtmTime = 0;
  let lastMtmValue: number | null = null;
  let lastOpenCount = 0;

  // ── Replay ──
  log.info(`Replaying ${tradableMessages.length} messages...`);
  resetApiStats();

  for (let i = 0; i < tradableMessages.length; i++) {
    const msg = tradableMessages[i];
    const msgDay = toDateKeyET(msg.timestamp);

    // ── Day boundary: cancel stale close orders + sweep expired + MTM snapshot ──
    if (lastMsgDay && msgDay !== lastMsgDay) {
      log.info(`Day ${lastMsgDay} → ${msgDay}`);

      const cancelledCloseCallbacks = new Map<string, (price: number, at: Date) => Promise<void>>();
      const workingOrders = orderManager.getWorkingOrders();
      for (const wo of workingOrders) {
        if (wo.status !== 'OPEN') continue;

        if (wo.params.isClosing) {
          const ctx = pendingIntents.get(wo.orderId);
          if (ctx?.tradeId) {
            cancelledCloseCallbacks.set(ctx.tradeId, (price, at) => ctx.recordFill(price, at).then(() => undefined));
          }
          log.info(`Day boundary: cancelling unfilled close order ${wo.orderId} ${wo.params.symbol}`);
          await broker.cancelOrder(wo.orderId);
          pendingIntents.delete(wo.orderId);
        } else {
          const hasExpiredLeg = wo.params.legs.some(leg =>
            leg.type !== 'STOCK' && leg.expiry && leg.expiry < msgDay
          );
          if (hasExpiredLeg) {
            log.info(`Day boundary: cancelling expired-leg order ${wo.orderId} ${wo.params.symbol} (legs expired before ${msgDay})`);
            await broker.cancelOrder(wo.orderId);
            pendingIntents.delete(wo.orderId);
          }
        }
      }
      await orderManager.tick(clock.now());

      const openCount = await broker.getOpenPositionCount();
      if (openCount > 0) {
        const sweepThrough = new Date(parseDateKey(msgDay).getTime() - 86_400_000)
          .toISOString().slice(0, 10);

        const autoClosedCount = await broker.autoCloseExpiring(lastMsgDay, cutoffMinus15Min, cancelledCloseCallbacks);
        if (autoClosedCount > 0) {
          log.info(`Auto-closed ${autoClosedCount} expiring position(s) on ${lastMsgDay} at market price`);
        }

        const openPositions = await broker.getOpenTrades();
        logExpiryNotices(openPositions, sweepThrough);

        for (const pos of openPositions) {
          if (pos.strategy === 'STOCK') continue;
          const hasExpiredLeg = (pos.legs as TradeLeg[] ?? []).some((l: TradeLeg) => l.expiry <= sweepThrough);
          if (hasExpiredLeg && !pos.closeMessageId) expiredWithoutSignal++;
        }

        const expiredCount = await broker.sweepExpired(sweepThrough);
        if (expiredCount > 0) {
          log.info(`Swept ${expiredCount} expired option(s) through ${sweepThrough}`);
        }

        const eodTime = new Date(lastMsgDay + 'T20:00:00Z');
        const unrealizedPnl = await broker.getUnrealizedPnl(eodTime);
        await db.insert(schema.backtestMtmSnapshots).values({
          backtestRunId: runId,
          date: lastMsgDay,
          unrealizedPnl,
        });
        log.debug(`MTM ${lastMsgDay}: unrealized=$${unrealizedPnl.toFixed(2)}`);

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

    await processMessage(
      msg, btCtx,
      { agentTrades, skipped, skipReasons, failedEntrySignals, failedExitSignals },
      (stats) => { agentTrades = stats.agentTrades; skipped = stats.skipped; failedEntrySignals = stats.failedEntrySignals; failedExitSignals = stats.failedExitSignals; },
    );

    // ── Write liveMetrics after every message ──
    const shouldRecomputeMtm =
      (i === 0) ||
      (i === tradableMessages.length - 1) ||
      (i % MTM_INTERVAL_MSGS === 0) ||
      (Date.now() - lastMtmTime > MTM_INTERVAL_MS);

    if (shouldRecomputeMtm) {
      lastMtmValue = await broker.getUnrealizedPnl();
      lastMtmTime = Date.now();
    }

    lastOpenCount = await broker.getOpenPositionCount();

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
      const autoClosedFinal = await broker.autoCloseExpiring(lastMsgDay, cutoffMinus15Min);
      if (autoClosedFinal > 0) {
        log.info(`Auto-closed ${autoClosedFinal} expiring position(s) on ${lastMsgDay} at market price (final)`);
      }

      const finalOpenPositions = await broker.getOpenTrades();
      logExpiryNotices(finalOpenPositions, lastMsgDay);

      for (const pos of finalOpenPositions) {
        if (pos.strategy === 'STOCK') continue;
        const hasExpiredLeg = (pos.legs as TradeLeg[] ?? []).some((l: TradeLeg) => l.expiry <= lastMsgDay);
        if (hasExpiredLeg && !pos.closeMessageId) expiredWithoutSignal++;
      }

      const expiredCount = await broker.sweepExpired(lastMsgDay);
      if (expiredCount > 0) {
        log.info(`Swept ${expiredCount} expired option(s) on ${lastMsgDay} (final)`);
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

  const apiStats = getApiStats();
  if (apiStats.fetches > 0) {
    log.info(`API: ${apiStats.fetches} fetches, ${(apiStats.bytesRead / 1024).toFixed(0)} KB, ${apiStats.records} records`);
  }

  priceProvider.printDataSummary();

  const finalOpenCount = await broker.getOpenPositionCount();
  const finalClosedCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isClosed, forRun(runId)));
  const finalPnlResult = await db.select({ total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)` }).from(schema.trades).where(and(isClosed, forRun(runId)));
  const totalPnl = safeParseFloat(finalPnlResult[0].total);
  log.info(`Done. trades=${agentTrades} skipped=${skipped} open=${finalOpenCount} closed=${finalClosedCount[0].count} PnL=$${totalPnl.toFixed(2)}`);
  if (failedEntrySignals > 0 || failedExitSignals > 0) {
    log.info(`Pipeline failures: entry=${failedEntrySignals} exit=${failedExitSignals}`);
  }
  if (expiredWithoutSignal > 0) {
    log.info(`Expired without close signal: ${expiredWithoutSignal}`);
  }
  if (skipReasons.size > 0) {
    const sorted = Array.from(skipReasons.entries()).sort((a, b) => b[1] - a[1]);
    log.info(`Skip reasons: ${sorted.map(([r, n]) => `${r}=${n}`).join(', ')}`);
  }
  log.info(`Generating report...`);

  const allTrades = await db.select().from(schema.trades).where(forRun(runId));
  const allDecisions = await db.select().from(schema.runDecisions).where(eq(schema.runDecisions.backtestRunId, runId));
  const mtmRows = await db.select().from(schema.backtestMtmSnapshots).where(eq(schema.backtestMtmSnapshots.backtestRunId, runId));

  const reportData = generateReportFromTrades({ trades: allTrades, decisions: allDecisions, mtmSnapshots: mtmRows, startingEquity, commissionSchedule: config.commissionSchedule });

  if (failedEntrySignals > 0) skipReasons.set('failed entry signals', failedEntrySignals);
  if (failedExitSignals > 0) skipReasons.set('failed exit signals', failedExitSignals);
  if (expiredWithoutSignal > 0) skipReasons.set('expired without signal', expiredWithoutSignal);

  const report: BacktestReport = {
    config,
    ...reportData,
    skipReasons: Object.fromEntries(skipReasons),
  };
  report.summary.totalMessages = allMessages.length;
  report.summary.tradedMessages = tradableMessages.length;

  await backfillDecisionPnl(runId);

  return report;
}

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
  agentTrades: number;
  skipped: number;
  skipReasons: Map<string, number>;
  failedEntrySignals: number;
  failedExitSignals: number;
};

type MessageContext = {
  msg: HistoricalMessage;
  runId: string;
  stats: Stats;
  updateStats: (stats: Stats) => void;
  decisionStart: number;
};

async function recordSkip(ctx: MessageContext, path: string, category: string, reason: string, usage?: LLMUsage): Promise<void> {
  log.debug(`  → skipped (${reason.slice(0, 100)}) (${Date.now() - ctx.decisionStart}ms)`);
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

async function recordExecute(
  ctx: MessageContext,
  path: string,
  reasoning: string,
  tradeId?: string,
  usage?: LLMUsage,
): Promise<void> {
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

// ── Adapter: HistoricalMessage → Task for processTask ───

function taskFromMessage(msg: HistoricalMessage): Task {
  return {
    id: msg.id,
    messageId: msg.id,
    taskType: 'REVIEW_MESSAGE',
    status: 'IN_PROGRESS',
    assignee: 'agent',
    priority: 0,
    context: {
      author: msg.author,
      symbols: msg.symbols,
      badges: msg.badges,
    },
    result: null,
    createdAt: msg.timestamp.toISOString(),
    startedAt: msg.timestamp.toISOString(),
    completedAt: null,
    error: null,
    modelProvider: null,
    modelName: null,
  } as Task;
}

// ── Per-message processing ──

async function processMessage(
  msg: HistoricalMessage,
  btCtx: BacktestContext,
  stats: Stats,
  updateStats: (stats: Stats) => void,
): Promise<void> {
  const ctx: MessageContext = { msg, runId: btCtx.runId, stats, updateStats, decisionStart: Date.now() };
  const task = taskFromMessage(msg);

  await processTaskShared(task, {
    getPositions: async (symbol) => {
      const filters: PositionFilters = symbol ? { symbol } : {};
      const rows = await btCtx.getOpenPositions({ ...filters, trader: msg.author });
      return rows.map(tradeToOpenPosition);
    },
    llm: btCtx.agentProvider,
    pipeline: btCtx.pipelineDeps,
    onResult: async (result) => {
      if (result.outcome === 'EXECUTE') {
        const executedResults = result.results.filter(r => r.executed);
        const pendingResults = result.results.filter(r => !r.executed && r.orderId);
        const firstTradeId = executedResults[0]?.tradeId;
        const failedResults = result.results.filter(r => !r.executed && !r.orderId && r.reason);

        for (const r of failedResults) {
          if (r.signal.tradeId) stats.failedExitSignals++;
          else stats.failedEntrySignals++;
        }

        if (executedResults.length > 0 || pendingResults.length > 0) {
          const reasoning = result.signals.map(s => `${s.orderType} ${s.legs.map(l => l.symbol).join('+')}`).join('; ');
          await recordExecute(ctx, 'orchestrator', reasoning, firstTradeId);
        } else if (failedResults.length > 0) {
          const failReason = failedResults.map(r => r.reason).join('; ');
          log.debug(`  pipeline failed: ${failReason.slice(0, 200)}`);
          await recordSkip(ctx, 'pipeline_failure', 'pipeline failure', failReason);
        } else {
          await recordSkip(ctx, 'orchestrator', 'no execution', 'Signals produced but none executed');
        }
      } else if (result.outcome === 'MANUAL_REVIEW') {
        await recordSkip(ctx, 'orchestrator', 'flagged', result.reason);
      } else {
        await recordSkip(ctx, 'orchestrator', 'skip', result.reason);
      }
      updateStats(stats);
    },
  });
}
