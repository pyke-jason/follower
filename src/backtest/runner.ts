import { SimClock } from './clock.js';
import { DatabentoMarketDataProvider } from './market-data.js';
import type { BacktestPriceProvider } from './market-data.js';
import { SimBroker } from './sim-broker.js';
import type { SizingService, RiskService } from './types.js';
import { loadHistoricalMessages } from './historical-loader.js';
import { generateReportFromTrades } from './report.js';
import type { MtmSnapshot } from './report.js';
import { formatOccSymbol } from './occ-symbology.js';
import { createTools } from '../agent/tool-factory.js';
import type { FillInfo, ToolDependencies } from '../agent/tool-factory.js';
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
import { eq, and, inArray, sql } from 'drizzle-orm';
import { recordTrade } from '../trades/record-trade.js';
import { isOpen, isClosed, forRun, forSymbol, forTrader } from '../trades/filters.js';
import type { BacktestConfig, BacktestReport, HistoricalMessage, LiveMetrics } from './types.js';
import type { TaskContext } from '../db/schema.js';
import type { Trade } from '../db/schema.js';
import type { LLMUsage } from '../agent/providers.js';
import { getApiStats, resetApiStats } from './databento-tape.js';
import { createLogger } from '../lib/logger.js';
import { safeParseFloat, roundCents } from '../lib/numbers.js';

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
  log.info(`Date range: ${config.startDate.toISOString().split('T')[0]} to ${config.endDate.toISOString().split('T')[0]}`);

  // Load messages
  const allMessages = await loadHistoricalMessages({
    startDate: config.startDate,
    endDate: config.endDate,
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
  const clock = new SimClock(config.startDate);
  const priceProvider = new DatabentoMarketDataProvider(config.databentoApiKey, config.databentoDataset ?? 'DBEQ.BASIC', config.refreshQuoteCache ?? false, 'OPRA.PILLAR');
  const fillModel = config.fillModel ?? 'orats';
  const startingEquity = 100_000;
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

  const riskService = {
    async check(input: { symbol: string; strategy: string; trader: string }) {
      const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(runId)));
      const openOnSymbol = openTrades.filter(t => t.symbol === input.symbol).length;
      const totalOpen = openTrades.length;
      const maxOnSymbol = 3;
      const maxTotal = 20;
      const totalOpenNotional = openTrades.reduce(
        (sum, t) => sum + Math.abs(safeParseFloat(t.entryPrice) * (t.quantity ?? 1) * (t.strategy !== 'STOCK' ? 100 : 1)), 0,
      );

      // Daily PnL from closed trades today
      const dateStr = clock.now().toISOString().split('T')[0];
      const dailyClosedResult = await db.select({
        total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
      }).from(schema.trades).where(and(
        isClosed, forRun(runId),
        sql`closed_at LIKE ${dateStr + '%'}`,
      ));
      const dailyPnl = safeParseFloat(dailyClosedResult[0]?.total);

      const balance = await broker.getAccountBalance();
      const maxNotional = balance.equity * 2;
      const stats = { openOnSymbol, maxOnSymbol, totalOpen, maxTotal, totalNotional: totalOpenNotional, maxNotional };

      if (openOnSymbol >= maxOnSymbol) {
        return { allowed: false, reason: `${openOnSymbol} positions already open on ${input.symbol}`, ...stats };
      }
      if (totalOpen >= maxTotal) {
        return { allowed: false, reason: `${totalOpen} total open positions (max ${maxTotal})`, ...stats };
      }
      if (totalOpenNotional > maxNotional) {
        const positions = openTrades
          .map(t => ({ sym: t.symbol, strat: t.strategy, dir: t.direction, qty: t.quantity ?? 1, entry: safeParseFloat(t.entryPrice), notional: Math.abs(safeParseFloat(t.entryPrice) * (t.quantity ?? 1) * (t.strategy !== 'STOCK' ? 100 : 1)) }))
          .sort((a, b) => b.notional - a.notional)
          .slice(0, 3);
        const posDetail = positions.map(p => `${p.dir} ${p.strat} ${p.sym} qty=${p.qty} @$${p.entry} ($${p.notional.toFixed(0)})`).join('; ');
        return { allowed: false, reason: `notional exposure $${totalOpenNotional.toFixed(0)} > 2x equity $${maxNotional.toFixed(0)} [top: ${posDetail}]`, ...stats };
      }
      if (dailyPnl < 0 && Math.abs(dailyPnl) > startingEquity * 0.05) {
        return { allowed: false, reason: `daily loss $${dailyPnl.toFixed(0)} > 5% of starting equity`, ...stats };
      }
      return { allowed: true, ...stats };
    },
  };

  // Map of working order IDs to their intent context for async fill recording
  const pendingIntents = new Map<string, {
    msg: HistoricalMessage;
    fill: FillInfo;
  }>();

  const orderManager = new OrderManager({
    broker,
    clock: () => clock.now(),
    onFill: async (order) => {
      const pending = pendingIntents.get(order.orderId);
      if (!pending) return;
      pendingIntents.delete(order.orderId);
      const action = pending.msg.actionHint === 'CLOSE' ? 'CLOSE' : 'OPEN';
      await recordTrade({
        action,
        symbol: pending.fill.symbol,
        trader: pending.msg.author,
        direction: pending.fill.direction,
        strategy: pending.fill.strategy,
        entryPrice: action === 'CLOSE' ? undefined : order.filledPrice,
        exitPrice: action === 'CLOSE' ? order.filledPrice : undefined,
        quantity: pending.fill.quantity,
        legs: pending.fill.legs,
        sourceMessageId: pending.msg.id,
        closeMessageId: action === 'CLOSE' ? pending.msg.id : undefined,
        openedAt: order.filledAt?.toISOString(),
        closedAt: action === 'CLOSE' ? order.filledAt?.toISOString() : undefined,
        backtestRunId: runId,
        isBacktest: true,
      });
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

  // Single message loop — broker.advanceTo() handles lazy tick replay for working orders
  for (let i = 0; i < tradableMessages.length; i++) {
    const msg = tradableMessages[i];
    const msgDay = msg.timestamp.toISOString().split('T')[0];

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

    await processMessage(
      msg, broker, priceProvider, clock,
      orderManager, config, { agentCallsUsed, agentTrades, skipped, skipReasons },
      (stats) => { agentCallsUsed = stats.agentCallsUsed; agentTrades = stats.agentTrades; skipped = stats.skipped; },
      agentProvider, sizingService, riskService, startingEquity, runId, pendingIntents,
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
  broker: SimBroker,
  priceProvider: BacktestPriceProvider,
  clock: SimClock,
  orderManager: OrderManager,
  config: BacktestConfig,
  stats: Stats,
  updateStats: (stats: Stats) => void,
  agentProvider: LLMProvider,
  sizingService: SizingService,
  riskService: RiskService,
  startingEquity: number,
  runId: string,
  pendingIntents: Map<string, { msg: HistoricalMessage; fill: FillInfo }>,
): Promise<void> {
  const ctx: MessageContext = { msg, runId, stats, updateStats, decisionStart: Date.now() };

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

  // Build task context early — needed for both prefetch and agent call
  const taskContext: TaskContext = {
    messageId: msg.id,
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
  // Runs AFTER clock.advance() and broker.advanceTo() / orderManager.tick(),
  // so broker.getQuote() uses sim clock at message time (no look-ahead) and
  // getOpenPositions sees post-fill DB state (same as agent's own tool calls).
  let prefetched: PrefetchedData | undefined;
  try {
    prefetched = await prefetchForAgent(taskContext, {
      broker,
      getOpenPositions: async (filters) => {
        const conditions = [isOpen, forRun(runId)];
        if (filters.symbol) conditions.push(forSymbol(filters.symbol));
        if (filters.trader) conditions.push(forTrader(filters.trader));
        return await db.select().from(schema.trades).where(and(...conditions));
      },
      getTraderConfig: getTrader,
    });
  } catch (err) {
    log.warn(`  prefetch failed: ${err instanceof Error ? err.message : err}`);
  }

  // Deterministic pre-checks using prefetched data
  const skip = shouldSkipDeterministic(taskContext, prefetched, {
    maxOnSymbol: 3,
    maxTotalPositions: 20,
    agentCallsUsed: stats.agentCallsUsed,
    maxAgentCalls: config.maxAgentCalls,
  });
  if (skip) {
    await recordSkip(ctx, 'skipped', skip.category, skip.reason);
    updateStats(stats);
    return;
  }

  const callNum = stats.agentCallsUsed + 1;
  const maxCalls = config.maxAgentCalls ?? '∞';
  const agentModel = config.agentModel ?? 'default';
  log.debug(`  path: AGENT (call ${callNum}/${maxCalls}, model=${agentModel})`);
  const agentStart = Date.now();

  const agentResult = await runAgentForBacktest(
    msg, broker, priceProvider, clock, orderManager,
    agentProvider, sizingService, riskService, startingEquity, runId, pendingIntents,
    taskContext, prefetched,
  );
  const agentDuration = Date.now() - agentStart;
  stats.agentCallsUsed++;
  const tokenStr = `, ${((agentResult.usage.inputTokens + agentResult.usage.outputTokens) / 1000).toFixed(1)}k tokens`;
  if (agentResult.traded) {
    log.debug(`  agent: EXECUTE in ${agentDuration}ms (${agentResult.turns} turns${tokenStr})`);
    await recordExecute(ctx, agentResult.reasoning, agentResult.tradeId, agentResult.usage);
  } else {
    log.debug(`  agent: skip in ${agentDuration}ms (${agentResult.turns} turns${tokenStr})`);
    await recordSkip(ctx, 'agent', 'agent skip', agentResult.reasoning, agentResult.usage);
  }
  updateStats(stats);
}

async function runAgentForBacktest(
  msg: HistoricalMessage,
  broker: SimBroker,
  priceProvider: BacktestPriceProvider,
  clock: SimClock,
  orderManager: OrderManager,
  agentProvider: LLMProvider,
  sizingService: SizingService,
  riskService: RiskService,
  startingEquity: number,
  runId: string,
  pendingIntents: Map<string, { msg: HistoricalMessage; fill: FillInfo }>,
  taskContext: TaskContext,
  prefetched?: PrefetchedData,
): Promise<{ traded: boolean; tradeId?: string; reasoning: string; usage: LLMUsage; turns: number }> {
  const ZERO_USAGE: LLMUsage = { inputTokens: 0, outputTokens: 0 };

  // Prefetch Databento data for the symbols in this message
  await priceProvider.prefetch(msg.symbols, msg.timestamp);

  // Track trade recorded via onFill callback
  let recordedTradeId: string | undefined;
  const model = { provider: '', model: '' }; // will be set after runAgent

  // Build injected tools using sim broker
  const simTools = createTools({
    broker,
    orderManager,
    getOpenPositions: async (filters) => {
      const conditions = [isOpen, forRun(runId)];
      if (filters.symbol) conditions.push(forSymbol(filters.symbol));
      if (filters.trader) conditions.push(forTrader(filters.trader));
      return await db.select().from(schema.trades).where(and(...conditions));
    },
    checkRiskLimits: async (input) => {
      const result = await riskService.check(input);
      const balance = await broker.getAccountBalance();
      const dateStr = clock.now().toISOString().split('T')[0];
      const dailyClosedResult = await db.select({
        total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
      }).from(schema.trades).where(and(
        isClosed, forRun(runId),
        sql`closed_at LIKE ${dateStr + '%'}`,
      ));
      const openOnSymbol = await db.select({ count: sql<number>`COUNT(*)` }).from(schema.trades).where(and(isOpen, forRun(runId), forSymbol(input.symbol)));
      return {
        ...result,
        traderDailyPnl: safeParseFloat(dailyClosedResult[0]?.total),
        openPositionsOnSymbol: openOnSymbol[0].count,
      };
    },
    calculatePositionSize: async (input) => sizingService.calculateSize(input),
    onFill: async (fill) => {
      const action = msg.actionHint === 'CLOSE' ? 'CLOSE' : 'OPEN';
      const result = await recordTrade({
        action,
        symbol: fill.symbol,
        trader: msg.author,
        direction: fill.direction,
        strategy: fill.strategy,
        entryPrice: action === 'CLOSE' ? undefined : fill.filledPrice,
        exitPrice: action === 'CLOSE' ? fill.filledPrice : undefined,
        quantity: fill.quantity,
        legs: fill.legs,
        sourceMessageId: msg.id,
        closeMessageId: action === 'CLOSE' ? msg.id : undefined,
        openedAt: fill.filledAt.toISOString(),
        closedAt: action === 'CLOSE' ? fill.filledAt.toISOString() : undefined,
        backtestRunId: runId,
        isBacktest: true,
        metadata: model.provider ? { agentModel: `${model.provider}:${model.model}` } : {},
      });
      if (result) recordedTradeId = result.tradeId;
      return result ? { tradeId: result.tradeId } : null;
    },
    onPending: (orderId, fillInfo) => {
      pendingIntents.set(orderId, { msg, fill: fillInfo });
    },
  });

  try {
    const agentResult = await runAgent(taskContext, simTools, agentProvider, prefetched);
    const { steps, result, usage } = agentResult;
    // Populate the model ref so onFill closures can use it
    model.provider = agentResult.model.provider;
    model.model = agentResult.model.model;
    const toolTurns = steps.filter(s => s.tool).length;

    // A trade was executed if either: the agent's JSON says EXECUTE, or onFill fired
    // (the agent may call place_order successfully without emitting a JSON decision block)
    const traded = result?.decision === 'EXECUTE' || !!recordedTradeId;
    const reasoning = result?.reasoning ?? (recordedTradeId ? 'Agent placed order (no JSON decision block)' : 'Agent decided to skip');

    if (traded && recordedTradeId) {
      // Persist the task + steps for agent decisions
      const btTaskId = crypto.randomUUID();
      await db.insert(schema.tasks).values({
        id: btTaskId,
        messageId: msg.id,
        taskType: 'EXECUTE_TRADE',
        status: 'COMPLETED',
        assignee: 'agent',
        modelProvider: model.provider,
        modelName: model.model,
        context: taskContext,
        result: { decision: 'EXECUTE', reasoning },
        createdAt: msg.timestamp.toISOString(),
        completedAt: msg.timestamp.toISOString(),
        backtestRunId: runId,
      });
      await db.update(schema.trades)
        .set({ taskId: btTaskId })
        .where(eq(schema.trades.id, recordedTradeId));

      if (steps.length > 0) {
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
      }
    }

    return { traded, tradeId: recordedTradeId, reasoning, usage, turns: toolTurns };
  } catch (err) {
    // TODO: Tokens consumed before the error are lost — runAgentLoop's usage
    // accumulator is local and not returned on throw. Agent errors are rare,
    // so the undercount is minimal.
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`  agent error: ${errMsg}`);
    return { traded: false, reasoning: `Agent error: ${errMsg}`, usage: ZERO_USAGE, turns: 0 };
  }
}
