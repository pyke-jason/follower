import { SimClock } from './clock.js';
import { MessagePriceProvider } from './market-data.js';
import { SimBroker } from './sim-broker.js';
import { PositionTracker } from './position-tracker.js';
import { DeterministicExecutor } from './deterministic-executor.js';
import { loadHistoricalMessages } from './historical-loader.js';
import { generateReport } from './report.js';
import { createTools } from '../agent/tool-factory.js';
import { runAgent } from '../agent/trade-agent.js';
import type { AgentStep } from '../agent/trade-agent.js';
import { OrderManager } from '../orders/order-manager.js';
import { loadQuoteTape } from './databento-tape.js';
import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import type { QuoteTick } from './databento-tape.js';
import type { BacktestConfig, BacktestReport, HistoricalMessage } from './types.js';
import type { TaskContext } from '../db/schema.js';
import type { Trade } from '../db/schema.js';

/** Tracks which positions came from agent vs deterministic, with agent step data */
type TradeRecord = {
  messageId: string;
  positionId: string;
  source: 'deterministic' | 'agent';
  agentSteps?: AgentStep[];
  agentResult?: { decision: string; reasoning: string } | null;
  taskType: string;
};

type TimelineEvent =
  | { type: 'MESSAGE'; message: HistoricalMessage }
  | { type: 'TICK'; tick: QuoteTick };

function* mergeTimelines(
  messages: HistoricalMessage[],
  ticks: QuoteTick[],
): Generator<TimelineEvent> {
  let mi = 0, ti = 0;
  while (mi < messages.length || ti < ticks.length) {
    const mt = mi < messages.length ? messages[mi].timestamp.getTime() : Infinity;
    const tt = ti < ticks.length ? ticks[ti].timestamp.getTime() : Infinity;
    if (tt <= mt) {
      yield { type: 'TICK', tick: ticks[ti++] };
    } else {
      yield { type: 'MESSAGE', message: messages[mi++] };
    }
  }
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
        })
        .where(eq(schema.backtestRuns.id, runId));
    }

    return report;
  } catch (err) {
    if (runId) {
      await db.update(schema.backtestRuns)
        .set({
          status: 'FAILED',
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
          error: err instanceof Error ? err.message : String(err),
        })
        .where(eq(schema.backtestRuns.id, runId));
    }
    throw err;
  }
}

async function runBacktestInner(config: BacktestConfig, runId?: string): Promise<BacktestReport> {
  console.log(`[Backtest] Loading messages for ${config.traders.join(', ')}...`);
  console.log(`[Backtest] Date range: ${config.startDate.toISOString().split('T')[0]} to ${config.endDate.toISOString().split('T')[0]}`);

  // Load messages
  const allMessages = await loadHistoricalMessages({
    startDate: config.startDate,
    endDate: config.endDate,
    traders: config.traders,
  });

  console.log(`[Backtest] Loaded ${allMessages.length} messages`);

  // Filter to messages with badges and not paper trades
  const tradableMessages = allMessages.filter(
    (m) => m.badges.length > 0 && !m.isPaperTrade,
  );

  console.log(`[Backtest] ${tradableMessages.length} tradable messages (with badges, not paper)`);

  // Init components
  const clock = new SimClock(config.startDate);
  const priceProvider = new MessagePriceProvider();
  const tracker = new PositionTracker();
  const broker = new SimBroker(priceProvider, clock, tracker, config.slippagePct);
  const executor = new DeterministicExecutor(broker, tracker, clock, priceProvider);

  const orderManager = new OrderManager({
    broker,
    clock: () => clock.now(),
  });

  // Stats tracking
  let agentCallsUsed = 0;
  let deterministicTrades = 0;
  let agentTrades = 0;
  let skippedLowConfidence = 0;

  // Trade records for DB persistence
  const tradeRecords: TradeRecord[] = [];

  // Load quote tape if enabled
  if (config.useQuoteTape) {
    if (!config.databentoApiKey) {
      throw new Error('databentoApiKey is required when useQuoteTape is true');
    }

    // Collect unique symbols from messages
    const symbols = new Set<string>();
    for (const msg of tradableMessages) {
      for (const sym of msg.symbols) {
        symbols.add(sym);
      }
    }

    if (symbols.size > 0) {
      const ticks = await loadQuoteTape({
        apiKey: config.databentoApiKey,
        dataset: config.databentoDataset ?? 'DBEQ.BASIC',
        symbols: Array.from(symbols),
        start: config.startDate,
        end: config.endDate,
      });

      console.log(`[Backtest] Running merged timeline (${tradableMessages.length} messages + ${ticks.length} ticks)...`);

      let messageCount = 0;
      for (const event of mergeTimelines(tradableMessages, ticks)) {
        if (event.type === 'TICK') {
          clock.advance(event.tick.timestamp);
          broker.processQuoteTick(event.tick);
          await orderManager.tick(clock.now());
        } else {
          messageCount++;
          if (messageCount % 100 === 0) {
            console.log(`[Backtest] Processed ${messageCount}/${tradableMessages.length} messages...`);
          }
          await processMessage(
            event.message, broker, tracker, priceProvider, clock, executor,
            orderManager, config, { agentCallsUsed, deterministicTrades, agentTrades, skippedLowConfidence },
            (stats) => { agentCallsUsed = stats.agentCallsUsed; deterministicTrades = stats.deterministicTrades; agentTrades = stats.agentTrades; skippedLowConfidence = stats.skippedLowConfidence; },
            tradeRecords,
          );
        }
      }
    }
  } else {
    // Original message-only loop (backward compatible)
    for (let i = 0; i < tradableMessages.length; i++) {
      const msg = tradableMessages[i];
      clock.advance(msg.timestamp);

      if (i % 100 === 0 && i > 0) {
        console.log(`[Backtest] Processed ${i}/${tradableMessages.length} messages...`);
      }

      await processMessage(
        msg, broker, tracker, priceProvider, clock, executor,
        orderManager, config, { agentCallsUsed, deterministicTrades, agentTrades, skippedLowConfidence },
        (stats) => { agentCallsUsed = stats.agentCallsUsed; deterministicTrades = stats.deterministicTrades; agentTrades = stats.agentTrades; skippedLowConfidence = stats.skippedLowConfidence; },
        tradeRecords,
      );
    }
  }

  orderManager.destroy();
  console.log(`[Backtest] Done. Generating report...`);

  const report = generateReport(config, tracker, allMessages.length, tradableMessages.length, {
    agentCallsUsed,
    deterministicTrades,
    agentTrades,
    skippedLowConfidence,
  });

  // Persist trades and tasks to DB
  if (runId) {
    await persistBacktestResults(runId, tracker, tradeRecords);
  }

  return report;
}

/**
 * Write all positions as trades, and create task + task_steps rows for each.
 */
async function persistBacktestResults(
  runId: string,
  tracker: PositionTracker,
  tradeRecords: TradeRecord[],
): Promise<void> {
  console.log(`[Backtest] Persisting ${tracker.getAll().length} trades to DB...`);

  const allPositions = tracker.getAll();
  // Build lookup: positionId → TradeRecord
  const recordMap = new Map<string, TradeRecord>();
  for (const rec of tradeRecords) {
    recordMap.set(rec.positionId, rec);
  }

  for (const pos of allPositions) {
    const record = recordMap.get(pos.id);

    // Create task row
    const taskId = crypto.randomUUID();
    await db.insert(schema.tasks).values({
      id: taskId,
      messageId: pos.sourceMessageId ?? null,
      taskType: record?.taskType ?? 'EXECUTE_TRADE',
      status: 'COMPLETED',
      assignee: record?.source === 'agent' ? 'agent' : 'deterministic',
      context: {
        messageId: pos.sourceMessageId,
        author: pos.trader,
        symbols: [pos.symbol],
      },
      result: record?.agentResult ? {
        decision: record.agentResult.decision as 'EXECUTE' | 'SKIP' | 'MANUAL_REVIEW',
        reasoning: record.agentResult.reasoning,
      } : {
        decision: 'EXECUTE',
        reasoning: 'Deterministic execution (high confidence)',
      },
      createdAt: pos.openedAt.toISOString(),
      completedAt: pos.openedAt.toISOString(),
      backtestRunId: runId,
    });

    // Create task steps for agent-processed trades
    if (record?.agentSteps && record.agentSteps.length > 0) {
      for (let i = 0; i < record.agentSteps.length; i++) {
        const step = record.agentSteps[i];
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

    // Create trade row
    await db.insert(schema.trades).values({
      taskId,
      sourceMessageId: pos.sourceMessageId ?? null,
      trader: pos.trader,
      symbol: pos.symbol,
      direction: pos.direction,
      strategy: pos.strategy,
      legs: pos.legs,
      status: pos.closedAt ? 'CLOSED' : 'OPEN',
      entryPrice: String(pos.entryPrice),
      exitPrice: pos.exitPrice != null ? String(pos.exitPrice) : null,
      quantity: pos.quantity,
      pnl: pos.pnl != null ? String(pos.pnl) : null,
      openedAt: pos.openedAt.toISOString(),
      closedAt: pos.closedAt?.toISOString() ?? null,
      isBacktest: true,
      backtestRunId: runId,
    });
  }

  console.log(`[Backtest] Persisted ${allPositions.length} trades and tasks to DB.`);
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
  priceProvider: MessagePriceProvider,
  clock: SimClock,
  executor: DeterministicExecutor,
  orderManager: OrderManager,
  config: BacktestConfig,
  stats: Stats,
  updateStats: (stats: Stats) => void,
  tradeRecords: TradeRecord[],
): Promise<void> {
  clock.advance(msg.timestamp);

  // High confidence → deterministic
  if (executor.canHandle(msg)) {
    const result = await executor.execute(msg);
    if (result.action !== 'SKIP' && result.position) {
      stats.deterministicTrades++;
      tradeRecords.push({
        messageId: msg.id,
        positionId: result.position.id,
        source: 'deterministic',
        taskType: result.action === 'CLOSE' ? 'CLOSE_POSITION' : 'EXECUTE_TRADE',
      });
    }
    updateStats(stats);
    return;
  }

  // Low confidence → agent (if enabled and budget remaining)
  if (config.useAgent && stats.agentCallsUsed < config.maxAgentCalls) {
    try {
      const agentResult = await runAgentForBacktest(
        msg, broker, tracker, priceProvider, clock, orderManager,
        tradeRecords,
      );
      stats.agentCallsUsed++;
      if (agentResult) {
        stats.agentTrades++;
      }
    } catch (err) {
      console.error(`[Backtest] Agent error for message ${msg.id}:`, err);
    }
  } else {
    stats.skippedLowConfidence++;
  }
  updateStats(stats);
}

async function runAgentForBacktest(
  msg: HistoricalMessage,
  broker: SimBroker,
  tracker: PositionTracker,
  priceProvider: MessagePriceProvider,
  clock: SimClock,
  orderManager: OrderManager,
  tradeRecords: TradeRecord[],
): Promise<boolean> {
  // Seed price data from message
  if (msg.symbols[0] && msg.detectedStrategies[0]?.price) {
    priceProvider.setPrice(msg.symbols[0], msg.detectedStrategies[0].price, msg.timestamp);
  }

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
      const openOnSymbol = tracker.getOpenBySymbol(input.symbol).length;
      const dailyPnl = tracker.getDailyPnl(clock.now());
      return {
        allowed: openOnSymbol < 5 && Math.abs(dailyPnl) < 10000,
        traderDailyPnl: dailyPnl,
        openPositionsOnSymbol: openOnSymbol,
        traderMaxAllocation: 5000,
        traderMaxDailyAllocation: 10000,
      };
    },
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

  const { steps, result } = await runAgent(taskContext, simTools);

  if (result?.decision === 'EXECUTE' && result.trade) {
    // Record the trade in the position tracker
    const trade = result.trade;
    const symbol = (trade.symbol as string) ?? msg.symbols[0] ?? 'UNKNOWN';
    const direction = (trade.direction as 'LONG' | 'SHORT') ?? msg.directionHint ?? 'LONG';

    let position;
    if (msg.actionHint === 'CLOSE') {
      const exitPrice = trade.exitPrice ? parseFloat(String(trade.exitPrice)) : 0;
      position = tracker.closeMatching(symbol, msg.author, exitPrice, msg.timestamp);
    } else {
      position = tracker.open({
        symbol,
        direction,
        strategy: (trade.strategy as string) ?? 'STOCK',
        trader: msg.author,
        entryPrice: trade.entryPrice ? parseFloat(String(trade.entryPrice)) : 0,
        quantity: (trade.quantity as number) ?? 1,
        legs: (trade.legs as any[]) ?? [],
        openedAt: msg.timestamp,
        sourceMessageId: msg.id,
      });
    }

    if (position) {
      tradeRecords.push({
        messageId: msg.id,
        positionId: position.id,
        source: 'agent',
        agentSteps: steps,
        agentResult: { decision: result.decision, reasoning: result.reasoning },
        taskType: msg.actionHint === 'CLOSE' ? 'CLOSE_POSITION' : 'EXECUTE_TRADE',
      });
    }

    return true;
  }

  return false;
}
