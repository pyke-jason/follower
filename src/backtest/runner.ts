import { SimClock } from './clock.js';
import { DatabentoMarketDataProvider } from './market-data.js';
import { SimBroker, cutoffMinus15Min } from './sim-broker.js';
import type { AutoCloseResult } from './sim-broker.js';
import type { Trade } from '../db/schema.js';
import type { ResolvedPipelineDeps } from '../pipeline/execute-resolved.js';
import type { OrderManager } from '../orders/order-manager.js';
import { BACKTEST_RISK_DEFAULTS } from '../config/risk-defaults.js';
import { loadHistoricalMessages } from './historical-loader.js';
import { generateReportFromTrades } from './report.js';
import { toDateKeyET, parseDateKey, isoToDateKey, marketCloseUTC } from '../lib/et-date.js';
import type { LLMProvider } from '../agent/providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from '../agent/providers.js';
import { processTask as processTaskShared } from '../pipeline/process-task.js';
import { ShadowTracker } from './shadow-tracker.js';
import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { createEmitter } from '../decisions/emitter.js';
import { isClosed, forChannel, type PositionFilters } from '../trades/filters.js';
import type { BacktestConfig, BacktestReport, HistoricalMessage } from './types.js';
import { buildLiveMetrics } from './live-metrics.js';
import { resetApiStats, getApiStats } from './databento-tape.js';
import { tickCacheDb } from '../db/tick-cache-client.js';
import { createLogger } from '../lib/logger.js';
import { safeParseFloat } from '../lib/numbers.js';
import { logExpiryNotices } from '../lib/expiry-warning.js';
import type { Task } from '../db/schema.js';
import { getLegs } from '../db/accessors.js';
import { buildPipelineDeps } from '../pipeline/build-deps.js';
import { btChannel } from '../lib/channel.js';

const log = createLogger('Backtest');

/**
 * Bundles all backtest-scoped dependencies so processMessage doesn't
 * need a dozen positional parameters.
 */
type BacktestContext = {
  runId: string;
  agentProvider: LLMProvider;
  agentIdentity: { provider: string; model: string };
  pipelineDeps: ResolvedPipelineDeps;
  getOpenPositions: (filters?: PositionFilters) => Promise<Trade[]>;
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
  log.info(`Date range: ${isoToDateKey(config.startDate)} to ${isoToDateKey(config.endDate)}`);

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
  const startingEquity = config.startingEquity;
  const broker = new SimBroker(priceProvider, clock, btChannel(runId), fillModel, startingEquity);

  const riskConfig = {
    maxOnSymbol: config.maxOnSymbol ?? BACKTEST_RISK_DEFAULTS.maxOnSymbol,
    maxTotalPositions: config.maxTotalPositions ?? BACKTEST_RISK_DEFAULTS.maxTotalPositions,
    maxDrawdownPct: config.maxDrawdownPct ?? BACKTEST_RISK_DEFAULTS.maxDrawdownPct,
    maxNotionalMultiplier: config.maxNotionalMultiplier ?? BACKTEST_RISK_DEFAULTS.maxNotionalMultiplier,
  };

  const agentIdentity = {
    provider: (config.agentProvider ?? DEFAULT_TRADE_MODEL.provider) as 'anthropic' | 'xai',
    model: config.agentModel ?? DEFAULT_TRADE_MODEL.model,
  };
  const agentProvider = await createProvider(agentIdentity);
  log.info(`Agent: ${agentIdentity.provider}/${agentIdentity.model}`);

  const bundle = buildPipelineDeps({
    broker,
    env: {
      clock: () => clock.now(),
      scope: btChannel(runId),
    },
    config: {
      riskConfig,
      agentIdentity,
      disableRiskLimits: config.disableRiskLimits,
      startingEquity,
      manualTick: true,
    },
  });
  const { orderManager, pipelineDeps, pendingIntents, getOpenPositions } = bundle;

  const btCtx: BacktestContext = {
    runId,
    agentProvider,
    agentIdentity,
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
  const shadows = new ShadowTracker();

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

      // Give working orders a final chance to fill against remaining intraday ticks.
      // The backtest is event-driven (time only moves on tradable messages), so orders
      // placed during the last message of the day get zero tick evaluations without this.
      const prevDayClose = marketCloseUTC(parseDateKey(lastMsgDay));
      await advanceWithChaseInterleaving(broker, orderManager, clock.now(), prevDayClose);

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
        } else {
          const hasExpiredLeg = wo.params.legs.some(leg =>
            leg.type !== 'STOCK' && leg.expiry && leg.expiry < msgDay
          );
          if (hasExpiredLeg) {
            log.info(`Day boundary: cancelling expired-leg order ${wo.orderId} ${wo.params.symbol} (legs expired before ${msgDay})`);
            await broker.cancelOrder(wo.orderId);
          }
        }
      }
      await orderManager.tick(clock.now());

      const openCount = await broker.getOpenPositionCount();
      if (openCount > 0) {
        const sweepThrough = new Date(parseDateKey(msgDay).getTime() - 86_400_000)
          .toISOString().slice(0, 10);

        const autoClosed = await broker.autoCloseExpiring(lastMsgDay, cutoffMinus15Min, cancelledCloseCallbacks);
        if (autoClosed.length > 0) {
          log.info(`Auto-closed ${autoClosed.length} expiring position(s) on ${lastMsgDay} at market price`);
          await emitAutoCloseDecisions(autoClosed, runId);
        }

        const openPositions = await getOpenPositions();
        logExpiryNotices(openPositions, sweepThrough);

        for (const pos of openPositions) {
          if (pos.strategy === 'STOCK') continue;
          const hasExpiredLeg = getLegs(pos).some((l) => l.expiry <= sweepThrough);
          if (hasExpiredLeg && !pos.closeMessageId) expiredWithoutSignal++;
        }

        const expiredCount = await broker.sweepExpired(sweepThrough);
        if (expiredCount > 0) {
          log.info(`Swept ${expiredCount} expired option(s) through ${sweepThrough}`);
        }

        const eodTime = marketCloseUTC(parseDateKey(lastMsgDay));
        const unrealizedPnl = await broker.getUnrealizedPnl(eodTime);
        await db.insert(schema.backtestMtmSnapshots).values({
          channelId: btChannel(runId),
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
    const prevSimTime = clock.now();
    clock.advance(msg.timestamp);
    await advanceWithChaseInterleaving(broker, orderManager, prevSimTime, msg.timestamp);

    if (i > 0 && i % 100 === 0) {
      const openTradesCount = await broker.getOpenPositionCount();
      const closedTradesCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isClosed, forChannel(btChannel(runId))));
      const totalPnlResult = await db.select({ total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)` }).from(schema.trades).where(and(isClosed, forChannel(btChannel(runId))));
      log.info(`Processed ${i}/${tradableMessages.length} messages | open=${openTradesCount} closed=${closedTradesCount[0].count} PnL=$${safeParseFloat(totalPnlResult[0].total).toFixed(2)}`);
    }

    await processMessage(
      msg, btCtx, shadows,
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
      if (autoClosedFinal.length > 0) {
        log.info(`Auto-closed ${autoClosedFinal.length} expiring position(s) on ${lastMsgDay} at market price (final)`);
        await emitAutoCloseDecisions(autoClosedFinal, runId);
      }

      const finalOpenPositions = await getOpenPositions();
      logExpiryNotices(finalOpenPositions, lastMsgDay);

      for (const pos of finalOpenPositions) {
        if (pos.strategy === 'STOCK') continue;
        const hasExpiredLeg = getLegs(pos).some((l) => l.expiry <= lastMsgDay);
        if (hasExpiredLeg && !pos.closeMessageId) expiredWithoutSignal++;
      }

      const expiredCount = await broker.sweepExpired(lastMsgDay);
      if (expiredCount > 0) {
        log.info(`Swept ${expiredCount} expired option(s) on ${lastMsgDay} (final)`);
      }

      const eodTime = marketCloseUTC(parseDateKey(lastMsgDay));
      const unrealizedPnl = await broker.getUnrealizedPnl(eodTime);
      await db.insert(schema.backtestMtmSnapshots).values({
        channelId: btChannel(runId),
        date: lastMsgDay,
        unrealizedPnl,
      });
      log.debug(`MTM ${lastMsgDay} (final): unrealized=$${unrealizedPnl.toFixed(2)}`);
    }
  }

  bundle.destroy();

  const apiStats = getApiStats();
  if (apiStats.fetches > 0) {
    log.info(`API: ${apiStats.fetches} fetches, ${(apiStats.bytesRead / 1024).toFixed(0)} KB, ${apiStats.records} records`);
  }

  priceProvider.printDataSummary();

  const finalOpenCount = await broker.getOpenPositionCount();
  const finalClosedCount = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isClosed, forChannel(btChannel(runId))));
  const finalPnlResult = await db.select({ total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)` }).from(schema.trades).where(and(isClosed, forChannel(btChannel(runId))));
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

  const allTrades = await db.select().from(schema.trades).where(forChannel(btChannel(runId)));
  const allDecisions = await db.select().from(schema.runDecisions).where(eq(schema.runDecisions.channelId, btChannel(runId)));
  const mtmRows = await db.select().from(schema.backtestMtmSnapshots).where(eq(schema.backtestMtmSnapshots.channelId, btChannel(runId)));

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
        AND t.channel_id = ${btChannel(runId)}
        AND t.pnl IS NOT NULL
    )
    WHERE channel_id = ${btChannel(runId)}
      AND outcome = 'EXECUTE'
  `);
}

type Stats = {
  agentTrades: number;
  skipped: number;
  skipReasons: Map<string, number>;
  failedEntrySignals: number;
  failedExitSignals: number;
};

// ── Adapter: HistoricalMessage → Task for processTask ───

function taskFromMessage(msg: HistoricalMessage, channelId: string): Task {
  const id = `${channelId}:${msg.id}`;
  const ts = msg.timestamp.toISOString();
  return {
    id,
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
    createdAt: ts,
    startedAt: ts,
    completedAt: null,
    error: null,
    modelProvider: null,
    modelName: null,
    channelId,
  } as Task;
}

// ── Per-message processing ──

async function processMessage(
  msg: HistoricalMessage,
  btCtx: BacktestContext,
  shadows: ShadowTracker,
  stats: Stats,
  updateStats: (stats: Stats) => void,
): Promise<void> {
  const task = taskFromMessage(msg, btChannel(btCtx.runId));

  await processTaskShared(task, {
    getOpenPositions: btCtx.getOpenPositions,
    llm: btCtx.agentProvider,
    pipeline: btCtx.pipelineDeps,
    scope: btChannel(btCtx.runId),
    agentIdentity: btCtx.agentIdentity,
    classifySkip: (result) => {
      const isUnfollowed = shadows.isUnfollowedExit(
        msg.author,
        result.parseResult?.action ?? null,
        result.parseResult?.symbol ?? null,
      );
      if (isUnfollowed) return 'unfollowed_exit';
      return result.outcome === 'MANUAL_REVIEW' ? 'flagged' : 'skip';
    },
    onResult: async (result, emitter) => {
      if (result.outcome === 'EXECUTE') {
        const executedResults = result.results.filter(r => r.executed);
        const pendingResults = result.results.filter(r => !r.executed && !r.reason);
        const firstTradeId = executedResults[0]?.tradeId;
        const failedResults = result.results.filter(r => !r.executed && r.reason);

        for (const r of failedResults) {
          if (r.signal.tradeId) stats.failedExitSignals++;
          else stats.failedEntrySignals++;
        }

        if (executedResults.length > 0 || pendingResults.length > 0) {
          const reasoning = result.signals.map(s => `${s.orderType} ${s.legs.map(l => l.symbol).join('+')}`).join('; ');
          stats.agentTrades++;
          // Record followed open
          if (result.parseResult?.action === 'OPEN' && result.parseResult?.symbol) {
            shadows.recordFollowedOpen(msg.author, result.parseResult.symbol);
          }
          await emitter.emit('SETTLED', { outcome: 'EXECUTE' }, { outcome: 'EXECUTE', phase: 'orchestrator', reasoning, tradeId: firstTradeId });
        } else if (failedResults.length > 0) {
          const failReason = failedResults.map(r => r.reason).join('; ');
          log.debug(`  pipeline failed: ${failReason.slice(0, 200)}`);
          stats.skipped++;
          stats.skipReasons.set('pipeline failure', (stats.skipReasons.get('pipeline failure') ?? 0) + 1);
          await emitter.emit('SETTLED', { outcome: 'FAIL' }, { outcome: 'FAIL', phase: 'pipeline_failure', reasoning: failReason, skipCategory: 'pipeline failure' });
        } else {
          stats.skipped++;
          stats.skipReasons.set('no execution', (stats.skipReasons.get('no execution') ?? 0) + 1);
          await emitter.emit('SETTLED', { outcome: 'SKIP' }, { outcome: 'SKIP', phase: 'orchestrator', reasoning: 'Signals produced but none executed', skipCategory: 'no execution' });
        }
      } else {
        // SKIP or MANUAL_REVIEW — classified by classifySkip, SETTLED emitted by processTask
        const isUnfollowed = shadows.isUnfollowedExit(
          msg.author,
          result.parseResult?.action ?? null,
          result.parseResult?.symbol ?? null,
        );
        const category = isUnfollowed ? 'unfollowed_exit' : (result.outcome === 'MANUAL_REVIEW' ? 'flagged' : 'skip');
        stats.skipped++;
        stats.skipReasons.set(category, (stats.skipReasons.get(category) ?? 0) + 1);

        // Track skipped opens for shadow registry
        if (result.parseResult?.action === 'OPEN' && result.parseResult?.symbol) {
          shadows.recordSkippedOpen(msg.author, result.parseResult.symbol);
        }
      }
      updateStats(stats);
    },
  });
}

/** Emit an AUTO_CLOSE run_decision for each auto-closed position that has a source message. */
async function emitAutoCloseDecisions(results: AutoCloseResult[], runId: string): Promise<void> {
  for (const ac of results) {
    if (!ac.sourceMessageId) continue;
    const emitter = createEmitter({ messageId: ac.sourceMessageId, channelId: btChannel(runId) });
    await emitter.emit('AUTO_CLOSE', {
      exitPrice: ac.exitPrice,
      closeAt: ac.closeAt.toISOString(),
      symbol: ac.symbol,
      strategy: ac.strategy,
      expiryDate: ac.expiryDate,
    }, {
      outcome: 'EXECUTE',
      phase: 'expiry',
      tradeId: ac.tradeId,
      reasoning: `Option expiring ${ac.expiryDate}, auto-closed at $${ac.exitPrice.toFixed(2)}`,
    });
  }
}

async function advanceWithChaseInterleaving(
  broker: SimBroker,
  orderManager: OrderManager,
  from: Date,
  to: Date,
): Promise<void> {
  // Fast path: no active chase orders — single advance
  const workingOrders = orderManager.getWorkingOrders();
  const hasChaseRules = workingOrders.some(wo =>
    wo.status === 'OPEN' &&
    wo.params.adjustmentRules?.some(r => r.type === 'PRICE_CHASE')
  );

  if (!hasChaseRules) {
    await broker.advanceTo(to);
    await orderManager.tick(to);
    return;
  }

  // Find minimum chase interval across all active orders
  let minIntervalMs = Infinity;
  for (const wo of workingOrders) {
    if (wo.status !== 'OPEN') continue;
    for (const rule of (wo.params.adjustmentRules ?? [])) {
      if (rule.type === 'PRICE_CHASE') {
        minIntervalMs = Math.min(minIntervalMs, rule.intervalSec * 1000);
      }
    }
  }

  // Sub-step through time at chase intervals
  let t = from.getTime();
  const target = to.getTime();

  while (t < target) {
    const nextT = Math.min(t + minIntervalMs, target);
    const nextDate = new Date(nextT);

    await broker.advanceTo(nextDate);   // ticks in [lastAdvance, nextDate]
    await orderManager.tick(nextDate);  // applies 1 chase step, updates limit

    t = nextT;

    // Early exit: all chase orders resolved (filled/cancelled)
    const remaining = orderManager.getWorkingOrders()
      .filter(wo => wo.status === 'OPEN' &&
        wo.params.adjustmentRules?.some(r => r.type === 'PRICE_CHASE'));
    if (remaining.length === 0) {
      if (nextT < target) {
        await broker.advanceTo(to);
        await orderManager.tick(to);
      }
      break;
    }
  }
}
