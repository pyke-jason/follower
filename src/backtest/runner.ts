import { SimClock } from './clock.js';
import { MessagePriceProvider, DatabentoMarketDataProvider } from './market-data.js';
import type { BacktestPriceProvider } from './market-data.js';
import { SimBroker } from './sim-broker.js';
import { PositionTracker } from './position-tracker.js';
import { DeterministicExecutor } from './deterministic-executor.js';
import type { SizingService, RiskService, SimPosition } from './types.js';
import { loadHistoricalMessages } from './historical-loader.js';
import { generateReport } from './report.js';
import { createTools } from '../agent/tool-factory.js';
import { runAgent } from '../agent/trade-agent.js';
import type { AgentStep } from '../agent/trade-agent.js';
import type { LLMProvider } from '../agent/providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from '../agent/providers.js';
import { OrderManager } from '../orders/order-manager.js';
import { buildPositionSizer } from '../position-sizing/index.js';
import { db, schema } from '../db/client.js';
import { eq, sql } from 'drizzle-orm';
import type { BacktestConfig, BacktestReport, HistoricalMessage } from './types.js';
import type { TaskContext } from '../db/schema.js';
import type { Trade } from '../db/schema.js';
import { createLogger } from '../lib/logger.js';
import { seedOptionPrices } from './helpers.js';
import { safeParseFloat } from '../lib/numbers.js';

const log = createLogger('Backtest');

/** Maps sim position ID → DB row IDs so we can update on close */
type PositionDbIds = Map<string, { taskId: string; tradeId: string }>;

/** Persist a newly opened trade to the DB inline (task + trade rows). */
async function persistTradeOpen(
  runId: string,
  position: SimPosition,
  opts: {
    source: 'deterministic' | 'agent';
    taskType: string;
    agentSteps?: AgentStep[];
    agentResult?: { decision: string; reasoning: string } | null;
    modelProvider?: string;
    modelName?: string;
  },
): Promise<{ taskId: string; tradeId: string }> {
  const taskId = crypto.randomUUID();
  await db.insert(schema.tasks).values({
    id: taskId,
    messageId: position.sourceMessageId ?? null,
    taskType: opts.taskType,
    status: 'COMPLETED',
    assignee: opts.source === 'agent' ? 'agent' : 'deterministic',
    modelProvider: opts.modelProvider ?? null,
    modelName: opts.modelName ?? null,
    context: {
      messageId: position.sourceMessageId,
      author: position.trader,
      symbols: [position.symbol],
    },
    result: opts.agentResult ? {
      decision: opts.agentResult.decision as 'EXECUTE' | 'SKIP' | 'MANUAL_REVIEW',
      reasoning: opts.agentResult.reasoning,
    } : {
      decision: 'EXECUTE',
      reasoning: 'Deterministic execution (high confidence)',
    },
    createdAt: position.openedAt.toISOString(),
    completedAt: position.openedAt.toISOString(),
    backtestRunId: runId,
  });

  if (opts.agentSteps && opts.agentSteps.length > 0) {
    for (let i = 0; i < opts.agentSteps.length; i++) {
      const step = opts.agentSteps[i];
      await db.insert(schema.taskSteps).values({
        taskId,
        stepNumber: i + 1,
        toolName: step.tool ?? null,
        toolInput: step.input ?? null,
        toolOutput: step.output ?? null,
        reasoning: step.reasoning ?? null,
        durationMs: step.durationMs ?? null,
      });
    }
  }

  const tradeId = crypto.randomUUID();
  await db.insert(schema.trades).values({
    id: tradeId,
    taskId,
    sourceMessageId: position.sourceMessageId ?? null,
    trader: position.trader,
    symbol: position.symbol,
    direction: position.direction,
    strategy: position.strategy,
    legs: position.legs,
    status: 'OPEN',
    entryPrice: String(position.entryPrice),
    exitPrice: null,
    quantity: position.quantity,
    pnl: null,
    openedAt: position.openedAt.toISOString(),
    closedAt: null,
    isBacktest: true,
    backtestRunId: runId,
    metadata: opts.modelProvider
      ? { agentModel: `${opts.modelProvider}:${opts.modelName}` }
      : {},
  });

  return { taskId, tradeId };
}

/** Update a trade row on close: status, exitPrice, pnl, closedAt, closeMessageId. */
async function persistTradeClose(tradeId: string, position: SimPosition): Promise<void> {
  await db.update(schema.trades)
    .set({
      status: 'CLOSED',
      exitPrice: position.exitPrice != null ? String(position.exitPrice) : null,
      pnl: position.pnl != null ? String(position.pnl) : null,
      closedAt: position.closedAt?.toISOString() ?? null,
      closeMessageId: position.closeMessageId ?? null,
    })
    .where(eq(schema.trades.id, tradeId));
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

  // Init components
  const clock = new SimClock(config.startDate);
  const priceProvider: BacktestPriceProvider = config.databentoApiKey
    ? new DatabentoMarketDataProvider(config.databentoApiKey, config.databentoDataset ?? 'DBEQ.BASIC')
    : new MessagePriceProvider();
  const tracker = new PositionTracker();
  const fillModel = config.fillModel ?? 'orats';
  const startingEquity = 100_000;
  const broker = new SimBroker(priceProvider, clock, tracker, fillModel, startingEquity);

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
        maxAllocation: balance.equity * 0.05,
        spreadMaxRisk: input.spreadMaxRisk,
        maxQuantity: MAX_CONTRACTS[input.strategy],
      });
    },
  };

  const riskService = {
    async check(input: { symbol: string; strategy: string; trader: string }) {
      const openOnSymbol = tracker.getOpenBySymbol(input.symbol).length;
      const totalOpen = tracker.getOpen().length;
      const totalOpenNotional = tracker.getOpen().reduce(
        (sum, p) => sum + Math.abs(p.entryPrice * p.quantity * (p.strategy !== 'STOCK' ? 100 : 1)), 0,
      );
      const dailyPnl = tracker.getDailyPnl(clock.now());
      const balance = await broker.getAccountBalance();

      if (openOnSymbol >= 3) {
        return { allowed: false, reason: `${openOnSymbol} positions already open on ${input.symbol}` };
      }
      if (totalOpen >= 20) {
        return { allowed: false, reason: `${totalOpen} total open positions (max 20)` };
      }
      if (totalOpenNotional > balance.equity * 2) {
        return { allowed: false, reason: `notional exposure $${totalOpenNotional.toFixed(0)} > 2x equity $${(balance.equity * 2).toFixed(0)}` };
      }
      if (dailyPnl < 0 && Math.abs(dailyPnl) > startingEquity * 0.05) {
        return { allowed: false, reason: `daily loss $${dailyPnl.toFixed(0)} > 5% of starting equity` };
      }

      return { allowed: true };
    },
  };

  const executor = new DeterministicExecutor(broker, tracker, clock, priceProvider, fillModel, sizingService, riskService);

  const orderManager = new OrderManager({
    broker,
    clock: () => clock.now(),
  });

  // Create LLM provider for agent calls
  const agentIdentity = {
    provider: (config.agentProvider ?? DEFAULT_TRADE_MODEL.provider) as 'anthropic' | 'xai',
    model: config.agentModel ?? DEFAULT_TRADE_MODEL.model,
  };
  const agentProvider = config.useAgent ? await createProvider(agentIdentity) : undefined;
  if (agentProvider) {
    log.info(`Agent: ${agentIdentity.provider}/${agentIdentity.model}`);
  }

  // Stats tracking
  let agentCallsUsed = 0;
  let deterministicTrades = 0;
  let agentTrades = 0;
  let skippedLowConfidence = 0;

  // Maps sim position ID → DB row IDs for live persistence
  const positionDbIds: PositionDbIds = new Map();

  // Single message loop — broker.advanceTo() handles lazy tick replay for working orders
  for (let i = 0; i < tradableMessages.length; i++) {
    const msg = tradableMessages[i];
    clock.advance(msg.timestamp);
    await broker.advanceTo(msg.timestamp);
    await orderManager.tick(msg.timestamp);

    if (i > 0 && i % 100 === 0) {
      log.info(`Processed ${i}/${tradableMessages.length} messages...`);
    }

    await processMessage(
      msg, broker, tracker, priceProvider, clock, executor,
      orderManager, config, { agentCallsUsed, deterministicTrades, agentTrades, skippedLowConfidence },
      (stats) => { agentCallsUsed = stats.agentCallsUsed; deterministicTrades = stats.deterministicTrades; agentTrades = stats.agentTrades; skippedLowConfidence = stats.skippedLowConfidence; },
      positionDbIds, agentProvider, sizingService, riskService, startingEquity, runId,
    );
  }

  orderManager.destroy();
  log.info(`Done. Generating report...`);

  const report = generateReport({
    config,
    tracker,
    totalMessages: allMessages.length,
    tradableMessages: tradableMessages.length,
    stats: { agentCallsUsed, deterministicTrades, agentTrades, skippedLowConfidence },
    startingEquity,
  });

  // Backfill PnL on runDecisions from the trades table (safety net)
  if (runId) {
    await backfillDecisionPnl(runId);
  }

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
  deterministicTrades: number;
  agentTrades: number;
  skippedLowConfidence: number;
};

async function processMessage(
  msg: HistoricalMessage,
  broker: SimBroker,
  tracker: PositionTracker,
  priceProvider: BacktestPriceProvider,
  clock: SimClock,
  executor: DeterministicExecutor,
  orderManager: OrderManager,
  config: BacktestConfig,
  stats: Stats,
  updateStats: (stats: Stats) => void,
  positionDbIds: PositionDbIds,
  agentProvider: LLMProvider | undefined,
  sizingService: SizingService,
  riskService: RiskService,
  startingEquity: number,
  runId?: string,
): Promise<void> {
  const decisionStart = Date.now();

  log.debug(
    `msg ${msg.id.slice(0, 8)} | ${msg.author} | ${msg.symbols.join(',')} | ` +
    `action=${msg.actionHint ?? '?'} conf=${msg.confidence.toFixed(2)}`,
  );

  // High confidence → deterministic
  if (executor.canHandle(msg)) {
    try {
      const result = await executor.execute(msg);
      if (result.action !== 'SKIP' && result.position) {
        log.debug(`  → deterministic ${result.action} ${result.position.symbol} @ $${result.position.entryPrice}`);
        stats.deterministicTrades++;

        let tradeId: string | undefined;
        if (runId) {
          if (result.action === 'OPEN') {
            const ids = await persistTradeOpen(runId, result.position, {
              source: 'deterministic',
              taskType: 'EXECUTE_TRADE',
            });
            positionDbIds.set(result.position.id, ids);
            tradeId = ids.tradeId;
          } else if (result.action === 'CLOSE') {
            const existingIds = positionDbIds.get(result.position.id);
            if (existingIds) {
              await persistTradeClose(existingIds.tradeId, result.position);
              tradeId = existingIds.tradeId;
            } else {
              const ids = await persistTradeOpen(runId, result.position, {
                source: 'deterministic',
                taskType: 'CLOSE_POSITION',
              });
              tradeId = ids.tradeId;
            }
          }
          await db.insert(schema.runDecisions).values({
            backtestRunId: runId,
            messageId: msg.id,
            path: 'deterministic',
            decision: 'EXECUTE',
            reasoning: 'High confidence deterministic execution',
            tradeId,
            durationMs: Date.now() - decisionStart,
          });
        }
      } else {
        log.debug(`  → deterministic SKIP: ${result.reason ?? 'no reason'}`);
        if (runId) {
          await db.insert(schema.runDecisions).values({
            backtestRunId: runId,
            messageId: msg.id,
            path: 'deterministic',
            decision: 'SKIP',
            reasoning: result.reason ?? 'Deterministic handler skipped',
            durationMs: Date.now() - decisionStart,
          });
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`Deterministic execution error for ${msg.symbols.join(',')}: ${errMsg}`);
      if (runId) {
        await db.insert(schema.runDecisions).values({
          backtestRunId: runId,
          messageId: msg.id,
          path: 'deterministic',
          decision: 'SKIP',
          reasoning: `Execution error: ${errMsg}`,
          durationMs: Date.now() - decisionStart,
        });
      }
    }
    updateStats(stats);
    return;
  }

  // Low confidence → agent (if enabled and budget remaining)
  if (config.useAgent && stats.agentCallsUsed < (config.maxAgentCalls ?? Infinity)) {
    try {
      const agentResult = await runAgentForBacktest(
        msg, broker, tracker, priceProvider, clock, orderManager,
        positionDbIds, agentProvider, sizingService, riskService, startingEquity, runId,
      );
      stats.agentCallsUsed++;
      if (agentResult) {
        log.debug(`  → agent EXECUTE`);
        stats.agentTrades++;
        if (runId) {
          await db.insert(schema.runDecisions).values({
            backtestRunId: runId,
            messageId: msg.id,
            path: 'agent',
            decision: 'EXECUTE',
            reasoning: agentResult.reasoning ?? 'Agent executed trade',
            tradeId: agentResult.tradeId,
            durationMs: Date.now() - decisionStart,
          });
        }
      } else {
        log.debug(`  → agent SKIP`);
        if (runId) {
          await db.insert(schema.runDecisions).values({
            backtestRunId: runId,
            messageId: msg.id,
            path: 'agent',
            decision: 'SKIP',
            reasoning: 'Agent decided to skip',
            durationMs: Date.now() - decisionStart,
          });
        }
      }
    } catch (err) {
      log.error(`Agent error for message ${msg.id}:`, err);
      if (runId) {
        await db.insert(schema.runDecisions).values({
          backtestRunId: runId,
          messageId: msg.id,
          path: 'agent',
          decision: 'SKIP',
          reasoning: `Agent error: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - decisionStart,
        });
      }
    }
  } else {
    log.debug(`  → skipped (low confidence, agent ${config.useAgent ? 'budget exhausted' : 'disabled'})`);
    stats.skippedLowConfidence++;
    if (runId) {
      await db.insert(schema.runDecisions).values({
        backtestRunId: runId,
        messageId: msg.id,
        path: 'skipped',
        decision: 'SKIP',
        reasoning: config.useAgent
          ? 'Agent budget exhausted'
          : 'Low confidence, agent disabled',
        durationMs: Date.now() - decisionStart,
      });
    }
  }
  updateStats(stats);
}

async function runAgentForBacktest(
  msg: HistoricalMessage,
  broker: SimBroker,
  tracker: PositionTracker,
  priceProvider: BacktestPriceProvider,
  clock: SimClock,
  orderManager: OrderManager,
  positionDbIds: PositionDbIds,
  agentProvider: LLMProvider | undefined,
  sizingService: SizingService,
  riskService: RiskService,
  startingEquity: number,
  runId?: string,
): Promise<{ tradeId?: string; reasoning: string } | null> {
  // Prefetch Databento data if available
  if (priceProvider instanceof DatabentoMarketDataProvider) {
    await priceProvider.prefetch(msg.symbols, msg.timestamp);
  } else {
    // MessagePriceProvider fallback: seed from detectedStrategies + regex on cleanText
    for (let i = 0; i < msg.detectedStrategies.length; i++) {
      const strat = msg.detectedStrategies[i];
      const sym = msg.symbols[i];
      if (sym && strat.price) {
        priceProvider.setPrice(sym, strat.price, msg.timestamp);
      }
    }
    // Fallback: try to extract a price from the message text for the first symbol
    if (msg.symbols[0] && !msg.detectedStrategies[0]?.price) {
      const priceMatch = msg.cleanText.match(/\b(\d+(?:\.\d{1,2})?)\b/);
      if (priceMatch) {
        const price = safeParseFloat(priceMatch[1]);
        if (price > 0.5 && price < 100_000) {
          priceProvider.setPrice(msg.symbols[0], price, msg.timestamp);
        }
      }
    }
  }

  // Seed option prices from detectedStrategies (Databento DBEQ.BASIC has no options data)
  seedOptionPrices(priceProvider, msg.detectedStrategies, msg.symbols, msg.timestamp);

  // Build injected tools using sim broker
  const simTools = createTools({
    broker,
    orderManager,
    getOpenPositions: async (filters) => {
      let positions = tracker.getOpen();
      if (filters.symbol) positions = positions.filter((p) => p.symbol === filters.symbol);
      if (filters.trader) positions = positions.filter((p) => p.trader === filters.trader);

      // Convert SimPosition[] to Trade[] shape for the agent
      return positions.map((p) => ({
        id: p.id,
        taskId: null,
        sourceMessageId: p.sourceMessageId ?? null,
        trader: p.trader,
        symbol: p.symbol,
        direction: p.direction,
        strategy: p.strategy,
        legs: p.legs,
        status: 'OPEN',
        entryPrice: String(p.entryPrice),
        exitPrice: null,
        quantity: p.quantity,
        pnl: null,
        openedAt: p.openedAt.toISOString(),
        closedAt: null,
        closeMessageId: null,
        isBacktest: true,
        metadata: {},
      })) as Trade[];
    },
    checkRiskLimits: async (input) => {
      const result = await riskService.check(input);
      const balance = await broker.getAccountBalance();
      return {
        ...result,
        traderDailyPnl: tracker.getDailyPnl(clock.now()),
        openPositionsOnSymbol: tracker.getOpenBySymbol(input.symbol).length,
        traderMaxAllocation: balance.equity * 0.05,
        traderMaxDailyAllocation: startingEquity * 0.05,
      };
    },
    calculatePositionSize: async (input) => sizingService.calculateSize(input),
  });

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

  const { steps, result, model } = await runAgent(taskContext, simTools, agentProvider);

  if (result?.decision === 'EXECUTE' && result.trade) {
    // Record the trade in the position tracker
    const trade = result.trade;
    const symbol = (trade.symbol as string) ?? msg.symbols[0] ?? 'UNKNOWN';
    const direction = (trade.direction as 'LONG' | 'SHORT') ?? msg.directionHint ?? 'LONG';

    let position;
    if (msg.actionHint === 'CLOSE') {
      const exitPrice = safeParseFloat(trade.exitPrice);
      position = tracker.closeMatching({ symbol, trader: msg.author, exitPrice, closedAt: msg.timestamp });
    } else {
      position = tracker.open({
        symbol,
        direction,
        strategy: (trade.strategy as string) ?? 'STOCK',
        trader: msg.author,
        entryPrice: safeParseFloat(trade.entryPrice),
        quantity: (trade.quantity as number) ?? 1,
        legs: (trade.legs as any[]) ?? [],
        openedAt: msg.timestamp,
        sourceMessageId: msg.id,
      });
    }

    let tradeId: string | undefined;
    if (position && runId) {
      if (msg.actionHint === 'CLOSE') {
        const existingIds = positionDbIds.get(position.id);
        if (existingIds) {
          await persistTradeClose(existingIds.tradeId, position);
          tradeId = existingIds.tradeId;
        }
      } else {
        const ids = await persistTradeOpen(runId, position, {
          source: 'agent',
          taskType: 'EXECUTE_TRADE',
          agentSteps: steps,
          agentResult: { decision: result.decision, reasoning: result.reasoning },
          modelProvider: model.provider,
          modelName: model.model,
        });
        positionDbIds.set(position.id, ids);
        tradeId = ids.tradeId;
      }
    }

    return { tradeId, reasoning: result.reasoning };
  }

  return null;
}
