import { db, schema } from './db';
import { eq, and, desc, sql, isNull, count, asc, lt, gte, lte, or, isNotNull, ne, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { safeParseFloat } from '../../src/lib/numbers';
import type { EnrichedMessage, TradeOutcome, MessageDecision } from '../../src/lib/enriched-message';

/** Matches isOpen from src/trades/filters.ts — includes PARTIAL status (trimmed positions). */
const isOpenTrade = inArray(schema.trades.status, ['OPEN', 'PARTIAL']);
const isClosedTrade = eq(schema.trades.status, 'CLOSED');

/** Scoping helper: when runId is set, show that backtest's data. Otherwise, live only. */
function tradeScope(runId?: string): SQL {
  return runId
    ? eq(schema.trades.backtestRunId, runId)
    : isNull(schema.trades.backtestRunId);
}

function taskScope(runId?: string): SQL {
  return runId
    ? eq(schema.tasks.backtestRunId, runId)
    : isNull(schema.tasks.backtestRunId);
}

export async function getStats(runId?: string) {
  const [openTradesResult] = await db
    .select({ count: count() })
    .from(schema.trades)
    .where(and(isOpenTrade, tradeScope(runId)));

  const [todayPnlResult] = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
    })
    .from(schema.trades)
    .where(runId
      ? and(isClosedTrade, tradeScope(runId))
      : and(isNull(schema.trades.backtestRunId), sql`closed_at >= date('now')`)
    );

  const [pendingTasksResult] = await db
    .select({ count: count() })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.status, 'PENDING'), taskScope(runId)));

  return {
    openTrades: openTradesResult?.count ?? 0,
    todayPnl: safeParseFloat(todayPnlResult?.total),
    pendingTasks: pendingTasksResult?.count ?? 0,
  };
}

export async function getOpenTrades(limit = 50, runId?: string) {
  return db
    .select()
    .from(schema.trades)
    .where(and(isOpenTrade, tradeScope(runId)))
    .orderBy(desc(schema.trades.openedAt))
    .limit(limit);
}

export async function getClosedTrades(opts: {
  trader?: string;
  symbol?: string;
  strategy?: string;
  limit?: number;
  offset?: number;
  runId?: string;
} = {}) {
  const conditions = [isClosedTrade, tradeScope(opts.runId)];
  if (opts.trader) conditions.push(eq(schema.trades.trader, opts.trader));
  if (opts.symbol) conditions.push(eq(schema.trades.symbol, opts.symbol));
  if (opts.strategy) conditions.push(eq(schema.trades.strategy, opts.strategy));

  return db
    .select()
    .from(schema.trades)
    .where(and(...conditions))
    .orderBy(desc(schema.trades.closedAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}

export async function getTradeById(id: string) {
  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, id));
  return trade ?? null;
}

export async function getTradeSteps(taskId: string) {
  return db
    .select()
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, taskId))
    .orderBy(schema.taskSteps.stepNumber);
}

export async function getTradeByTaskId(taskId: string) {
  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.taskId, taskId));
  return trade ?? null;
}

export async function getRunDecisionForTask(messageId: string, backtestRunId: string) {
  const [decision] = await db
    .select()
    .from(schema.runDecisions)
    .where(
      and(
        eq(schema.runDecisions.messageId, messageId),
        eq(schema.runDecisions.backtestRunId, backtestRunId),
      )
    );
  return decision ?? null;
}

export async function getNearbyMessages(
  author: string,
  timestamp: string,
  windowMinutes = 60,
) {
  const center = new Date(timestamp);
  const start = new Date(center.getTime() - windowMinutes * 60 * 1000).toISOString();
  const end = new Date(center.getTime() + windowMinutes * 60 * 1000).toISOString();

  return db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.author, author),
        gte(schema.messages.timestamp, start),
        lte(schema.messages.timestamp, end),
      )
    )
    .orderBy(asc(schema.messages.timestamp))
    .limit(50);
}

export async function getMessages(opts: {
  author?: string;
  authors?: string[];
  limit?: number;
  offset?: number;
  cursor?: string;
  startDate?: string;
  endDate?: string;
  signalsOnly?: boolean;
} = {}) {
  const conditions: SQL[] = [];

  // Single author filter (legacy)
  if (opts.author) conditions.push(eq(schema.messages.author, opts.author));

  // Multi-author filter
  if (opts.authors && opts.authors.length > 0) {
    conditions.push(
      or(...opts.authors.map((a) => eq(schema.messages.author, a)))!
    );
  }

  // Cursor-based pagination: fetch messages older than cursor
  if (opts.cursor) {
    conditions.push(lt(schema.messages.timestamp, opts.cursor));
  }

  // Date range
  if (opts.startDate) {
    conditions.push(gte(schema.messages.timestamp, opts.startDate));
  }
  if (opts.endDate) {
    conditions.push(lte(schema.messages.timestamp, opts.endDate));
  }

  // Signals only: has actionHint OR non-empty badges OR non-empty symbols
  if (opts.signalsOnly) {
    conditions.push(
      or(
        isNotNull(schema.messages.actionHint),
        sql`json_array_length(${schema.messages.symbols}) > 0`,
        sql`json_array_length(${schema.messages.badges}) > 0`,
      )!
    );
  }

  const query = db
    .select()
    .from(schema.messages)
    .orderBy(desc(schema.messages.timestamp))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}

export async function getTrackedTraders() {
  return db.select().from(schema.trackedTraders);
}

export async function getTasks(opts: {
  status?: string;
  limit?: number;
  offset?: number;
  runId?: string;
} = {}) {
  const conditions = [taskScope(opts.runId)];
  if (opts.status) conditions.push(eq(schema.tasks.status, opts.status));

  return db
    .select()
    .from(schema.tasks)
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}

export async function getTaskById(id: string) {
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id));
  return task ?? null;
}

export async function getMessageById(id: string) {
  const [msg] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, id));
  return msg ?? null;
}

export async function getMessagesByIds(ids: string[]) {
  if (ids.length === 0) return [];
  const CHUNK = 500;
  const all: (typeof schema.messages.$inferSelect)[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db.select().from(schema.messages).where(inArray(schema.messages.id, chunk));
    all.push(...rows);
  }
  // Sort ASC by timestamp
  return all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function getLatestIntents(messageIds: string[]) {
  if (messageIds.length === 0) return {};
  // Fetch all intents for these messages, dedupe to latest version per message in JS
  const CHUNK = 500;
  const all: (typeof schema.messageIntents.$inferSelect)[] = [];
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    const rows = await db
      .select()
      .from(schema.messageIntents)
      .where(inArray(schema.messageIntents.messageId, chunk));
    all.push(...rows);
  }
  // Keep highest version per messageId
  const map: Record<string, typeof schema.messageIntents.$inferSelect> = {};
  for (const row of all) {
    const existing = map[row.messageId];
    if (!existing || row.version > existing.version) {
      map[row.messageId] = row;
    }
  }
  return map;
}

export async function getLabelsForMessages(messageIds: string[]) {
  if (messageIds.length === 0) return {};
  const CHUNK = 500;
  const all: (typeof schema.messageLabels.$inferSelect)[] = [];
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    const rows = await db
      .select()
      .from(schema.messageLabels)
      .where(inArray(schema.messageLabels.messageId, chunk));
    all.push(...rows);
  }
  const map: Record<string, typeof schema.messageLabels.$inferSelect> = {};
  for (const row of all) {
    map[row.messageId] = row;
  }
  return map;
}

export async function getPendingReviews(limit = 5, runId?: string) {
  return db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.status, 'PENDING'), taskScope(runId)))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(limit);
}

export async function getDistinctAuthors() {
  const rows = await db
    .selectDistinct({ author: schema.messages.author })
    .from(schema.messages)
    .orderBy(schema.messages.author);
  return rows.map((r) => r.author);
}

// ─── Backtest Run Queries ────────────────────────────

export async function getBacktestRuns(opts: { limit?: number; offset?: number } = {}) {
  return db
    .select()
    .from(schema.backtestRuns)
    .orderBy(desc(schema.backtestRuns.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);
}

export async function getBacktestRunById(id: string) {
  const [run] = await db
    .select()
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, id));
  return run ?? null;
}

// ─── Label / Eval Queries ───────────────────────────

export async function getLabels(opts: {
  reviewed?: boolean;
  limit?: number;
  offset?: number;
} = {}) {
  const conditions: SQL[] = [];
  if (opts.reviewed !== undefined) {
    conditions.push(eq(schema.messageLabels.reviewed, opts.reviewed));
  }

  const query = db
    .select({
      label: schema.messageLabels,
      message: schema.messages,
    })
    .from(schema.messageLabels)
    .innerJoin(schema.messages, eq(schema.messageLabels.messageId, schema.messages.id))
    .orderBy(desc(schema.messageLabels.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}

// ─── Run Decision Queries ────────────────────────────

export async function getRunDecisions(backtestRunId: string) {
  return db
    .select({
      decision: schema.runDecisions,
      message: schema.messages,
      trade: {
        id: schema.trades.id,
        symbol: schema.trades.symbol,
        taskId: schema.trades.taskId,
        pnl: schema.trades.pnl,
      },
    })
    .from(schema.runDecisions)
    .innerJoin(schema.messages, eq(schema.runDecisions.messageId, schema.messages.id))
    .leftJoin(schema.trades, eq(schema.runDecisions.tradeId, schema.trades.id))
    .where(eq(schema.runDecisions.backtestRunId, backtestRunId))
    .orderBy(desc(schema.runDecisions.createdAt));
}

export async function getMtmSnapshots(backtestRunId: string) {
  return db
    .select({
      date: schema.backtestMtmSnapshots.date,
      unrealizedPnl: schema.backtestMtmSnapshots.unrealizedPnl,
    })
    .from(schema.backtestMtmSnapshots)
    .where(eq(schema.backtestMtmSnapshots.backtestRunId, backtestRunId))
    .orderBy(asc(schema.backtestMtmSnapshots.date));
}

export async function getTradesByBacktestRun(backtestRunId: string, opts?: { includeOpen?: boolean }) {
  const conditions = [eq(schema.trades.backtestRunId, backtestRunId)];
  if (!opts?.includeOpen) {
    conditions.push(isClosedTrade);
  }
  return db
    .select()
    .from(schema.trades)
    .where(and(...conditions))
    .orderBy(desc(schema.trades.closedAt));
}


// ─── Dashboard Queries ──────────────────────────────

export async function getDailyBalances(limit = 30) {
  return db
    .select()
    .from(schema.dailyBalances)
    .orderBy(desc(schema.dailyBalances.date))
    .limit(limit);
}

export async function getTraderPnlSummary(runId?: string) {
  return db
    .select({
      trader: schema.trades.trader,
      totalPnl: sql<string>`COALESCE(SUM(CAST(${schema.trades.pnl} AS REAL)), 0)`,
      tradeCount: count(),
      wins: sql<number>`SUM(CASE WHEN CAST(${schema.trades.pnl} AS REAL) > 0 THEN 1 ELSE 0 END)`,
    })
    .from(schema.trades)
    .where(and(isClosedTrade, tradeScope(runId)))
    .groupBy(schema.trades.trader)
    .orderBy(sql`SUM(CAST(${schema.trades.pnl} AS REAL)) DESC`);
}

export async function getRecentSignals(limit = 8, runId?: string) {
  const messages = await db
    .select({
      message: schema.messages,
      trade: schema.trades,
    })
    .from(schema.messages)
    .leftJoin(
      schema.trades,
      and(
        eq(schema.trades.sourceMessageId, schema.messages.id),
        tradeScope(runId),
      )
    )
    .where(
      or(
        isNotNull(schema.messages.actionHint),
        sql`json_array_length(${schema.messages.symbols}) > 0`,
      )!
    )
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit);

  return messages;
}

export async function getTradeHistorySummary(opts: {
  trader?: string;
  symbol?: string;
  strategy?: string;
  runId?: string;
} = {}) {
  const conditions = [isClosedTrade, tradeScope(opts.runId)];
  if (opts.trader) conditions.push(eq(schema.trades.trader, opts.trader));
  if (opts.symbol) conditions.push(eq(schema.trades.symbol, opts.symbol));
  if (opts.strategy) conditions.push(eq(schema.trades.strategy, opts.strategy));

  const [result] = await db
    .select({
      totalPnl: sql<string>`COALESCE(SUM(CAST(${schema.trades.pnl} AS REAL)), 0)`,
      totalTrades: count(),
      wins: sql<number>`SUM(CASE WHEN CAST(${schema.trades.pnl} AS REAL) > 0 THEN 1 ELSE 0 END)`,
      bestTrade: sql<string>`MAX(CAST(${schema.trades.pnl} AS REAL))`,
      worstTrade: sql<string>`MIN(CAST(${schema.trades.pnl} AS REAL))`,
    })
    .from(schema.trades)
    .where(and(...conditions));

  return {
    totalPnl: safeParseFloat(result?.totalPnl),
    totalTrades: result?.totalTrades ?? 0,
    wins: result?.wins ?? 0,
    winRate: result?.totalTrades ? ((result.wins ?? 0) / result.totalTrades) * 100 : 0,
    bestTrade: safeParseFloat(result?.bestTrade),
    worstTrade: safeParseFloat(result?.worstTrade),
  };
}

// ─── Context Bar / Backtest Brief ────────────────────

export async function getBacktestRunBrief(id: string) {
  const [run] = await db
    .select({
      id: schema.backtestRuns.id,
      name: schema.backtestRuns.name,
      status: schema.backtestRuns.status,
      config: schema.backtestRuns.config,
    })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, id));
  if (!run) return null;

  // Always compute live from trades — fresh for running backtests, no stale summary JSON
  const [stats] = await db
    .select({
      totalTrades: count(),
      totalPnl: sql<string>`COALESCE(SUM(CASE WHEN ${schema.trades.status} = 'CLOSED' THEN CAST(${schema.trades.pnl} AS REAL) END), 0)`,
      wins: sql<number>`SUM(CASE WHEN ${schema.trades.status} = 'CLOSED' AND CAST(${schema.trades.pnl} AS REAL) > 0 THEN 1 ELSE 0 END)`,
      closed: sql<number>`SUM(CASE WHEN ${schema.trades.status} = 'CLOSED' THEN 1 ELSE 0 END)`,
    })
    .from(schema.trades)
    .where(eq(schema.trades.backtestRunId, id));

  const config = run.config as import('../../src/db/schema').BacktestRunConfig;
  const closed = stats?.closed ?? 0;
  const wins = stats?.wins ?? 0;
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    traders: config.traders ?? [],
    startDate: config.startDate?.split('T')[0] ?? '',
    endDate: config.endDate?.split('T')[0] ?? '',
    agentModel: config.agentModel ?? 'default',
    totalPnl: safeParseFloat(stats?.totalPnl),
    winRate: closed > 0 ? wins / closed : 0,
    totalTrades: stats?.totalTrades ?? 0,
  };
}

// ─── Risk & Account Health ───────────────────────────

export async function getRiskSnapshot() {
  const today = new Date().toISOString().split('T')[0];

  const [latestBalance] = await db
    .select()
    .from(schema.dailyBalances)
    .orderBy(desc(schema.dailyBalances.date))
    .limit(1);

  const openPositions = await db
    .select({
      symbol: schema.trades.symbol,
      count: count(),
    })
    .from(schema.trades)
    .where(and(isOpenTrade, isNull(schema.trades.backtestRunId)))
    .groupBy(schema.trades.symbol);

  const [totalOpen] = await db
    .select({ count: count() })
    .from(schema.trades)
    .where(and(isOpenTrade, isNull(schema.trades.backtestRunId)));

  const [unresolvedAlerts] = await db
    .select({ count: count() })
    .from(schema.reconciliationAlerts)
    .where(eq(schema.reconciliationAlerts.resolved, false));

  const [todayPnlResult] = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
    })
    .from(schema.trades)
    .where(and(isNull(schema.trades.backtestRunId), sql`closed_at >= date('now')`));

  // Drawdown: compare current equity to peak equity from daily balances
  const balances = await db
    .select({ equity: schema.dailyBalances.equity })
    .from(schema.dailyBalances)
    .orderBy(desc(schema.dailyBalances.date))
    .limit(60);

  let peakEquity = 0;
  let currentEquity = 0;
  if (balances.length > 0) {
    currentEquity = parseFloat(balances[0].equity ?? '0');
    peakEquity = Math.max(...balances.map((b) => parseFloat(b.equity ?? '0')));
  }
  const drawdownPct = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;

  // Check for DB_ONLY alerts (blocks trading)
  const [dbOnlyAlerts] = await db
    .select({ count: count() })
    .from(schema.reconciliationAlerts)
    .where(and(
      eq(schema.reconciliationAlerts.resolved, false),
      eq(schema.reconciliationAlerts.type, 'DB_ONLY'),
    ));

  const tradingBlocked = drawdownPct >= 5 || (dbOnlyAlerts?.count ?? 0) > 0;

  return {
    equity: currentEquity,
    buyingPower: latestBalance ? parseFloat(latestBalance.buyingPower ?? '0') : 0,
    openPositions: totalOpen?.count ?? 0,
    maxPositions: 20,
    positionsBySymbol: openPositions,
    drawdownPct: Math.round(drawdownPct * 100) / 100,
    maxDrawdownPct: 5,
    todayPnl: safeParseFloat(todayPnlResult?.total),
    unresolvedAlerts: unresolvedAlerts?.count ?? 0,
    tradingBlocked,
  };
}

// ─── Reconciliation ─────────────────────────────────

export async function getReconAlerts(opts: {
  resolved?: boolean;
  limit?: number;
  offset?: number;
} = {}) {
  const conditions: SQL[] = [];
  if (opts.resolved !== undefined) {
    conditions.push(eq(schema.reconciliationAlerts.resolved, opts.resolved));
  }

  const query = db
    .select()
    .from(schema.reconciliationAlerts)
    .orderBy(desc(schema.reconciliationAlerts.createdAt))
    .limit(opts.limit ?? 100)
    .offset(opts.offset ?? 0);

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}

export async function getReconAlertStats() {
  const [totals] = await db
    .select({
      total: count(),
      unresolved: sql<number>`SUM(CASE WHEN ${schema.reconciliationAlerts.resolved} = 0 THEN 1 ELSE 0 END)`,
      resolved: sql<number>`SUM(CASE WHEN ${schema.reconciliationAlerts.resolved} = 1 THEN 1 ELSE 0 END)`,
    })
    .from(schema.reconciliationAlerts);

  const byType = await db
    .select({
      type: schema.reconciliationAlerts.type,
      count: count(),
    })
    .from(schema.reconciliationAlerts)
    .where(eq(schema.reconciliationAlerts.resolved, false))
    .groupBy(schema.reconciliationAlerts.type);

  return {
    total: totals?.total ?? 0,
    unresolved: totals?.unresolved ?? 0,
    resolved: totals?.resolved ?? 0,
    byType: Object.fromEntries(byType.map((r) => [r.type, r.count])),
  };
}

// ─── Backtest Comparison ─────────────────────────────

export async function getDecisionDiff(runIdA: string, runIdB: string) {
  const a = schema.runDecisions;

  // Get decisions for both runs, keyed by messageId
  const decisionsA = await db
    .select({
      messageId: a.messageId,
      decision: a.decision,
      pnl: a.pnl,
      reasoning: a.reasoning,
    })
    .from(a)
    .where(eq(a.backtestRunId, runIdA));

  const decisionsB = await db
    .select({
      messageId: a.messageId,
      decision: a.decision,
      pnl: a.pnl,
      reasoning: a.reasoning,
    })
    .from(a)
    .where(eq(a.backtestRunId, runIdB));

  const mapA = new Map(decisionsA.map((d) => [d.messageId, d]));
  const mapB = new Map(decisionsB.map((d) => [d.messageId, d]));

  const allMessageIds = new Set([...mapA.keys(), ...mapB.keys()]);
  const diffs: {
    messageId: string;
    decisionA: string | null;
    decisionB: string | null;
    pnlA: number;
    pnlB: number;
    delta: number;
    reasoningA: string | null;
    reasoningB: string | null;
  }[] = [];

  for (const msgId of allMessageIds) {
    const dA = mapA.get(msgId);
    const dB = mapB.get(msgId);
    if (dA?.decision !== dB?.decision) {
      const pnlA = safeParseFloat(dA?.pnl);
      const pnlB = safeParseFloat(dB?.pnl);
      diffs.push({
        messageId: msgId,
        decisionA: dA?.decision ?? null,
        decisionB: dB?.decision ?? null,
        pnlA,
        pnlB,
        delta: pnlB - pnlA,
        reasoningA: dA?.reasoning ?? null,
        reasoningB: dB?.reasoning ?? null,
      });
    }
  }

  // Fetch message texts for display
  const msgIds = diffs.map((d) => d.messageId);
  const messages = msgIds.length > 0
    ? await db
        .select({ id: schema.messages.id, cleanText: schema.messages.cleanText, author: schema.messages.author })
        .from(schema.messages)
        .where(or(...msgIds.map((id) => eq(schema.messages.id, id)))!)
    : [];

  const msgMap = new Map(messages.map((m) => [m.id, m]));

  return diffs
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .map((d) => ({
      ...d,
      message: msgMap.get(d.messageId) ?? null,
    }));
}

export async function getBacktestRunsForComparison(ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(schema.backtestRuns)
    .where(or(...ids.map((id) => eq(schema.backtestRuns.id, id)))!);
}

export async function getDistinctExperimentTags() {
  const rows = await db
    .selectDistinct({ tag: schema.backtestRuns.experimentTag })
    .from(schema.backtestRuns)
    .where(isNotNull(schema.backtestRuns.experimentTag));
  return rows.map((r) => r.tag).filter(Boolean) as string[];
}

// ─── Trader Deep-Dive ───────────────────────────────

export async function getTraderEquityCurve(trader: string, runId?: string) {
  const conditions = [
    isClosedTrade,
    eq(schema.trades.trader, trader),
    tradeScope(runId),
  ];

  const trades = await db
    .select({
      closedAt: schema.trades.closedAt,
      pnl: schema.trades.pnl,
    })
    .from(schema.trades)
    .where(and(...conditions))
    .orderBy(asc(schema.trades.closedAt));

  let cumPnl = 0;
  return trades.map((t) => {
    cumPnl += safeParseFloat(t.pnl);
    return {
      date: t.closedAt?.split('T')[0] ?? '',
      pnl: safeParseFloat(t.pnl),
      cumPnl,
    };
  });
}

export async function getTraderStrategyBreakdown(trader: string, runId?: string) {
  const conditions = [
    isClosedTrade,
    eq(schema.trades.trader, trader),
    tradeScope(runId),
  ];

  return db
    .select({
      strategy: schema.trades.strategy,
      trades: count(),
      totalPnl: sql<string>`COALESCE(SUM(CAST(${schema.trades.pnl} AS REAL)), 0)`,
      wins: sql<number>`SUM(CASE WHEN CAST(${schema.trades.pnl} AS REAL) > 0 THEN 1 ELSE 0 END)`,
    })
    .from(schema.trades)
    .where(and(...conditions))
    .groupBy(schema.trades.strategy)
    .orderBy(sql`SUM(CAST(${schema.trades.pnl} AS REAL)) DESC`);
}

export async function getTraderDetail(name: string) {
  const [trader] = await db
    .select()
    .from(schema.trackedTraders)
    .where(eq(schema.trackedTraders.name, name));
  return trader ?? null;
}

// ─── Partial Exits ──────────────────────────────────

export async function getPartialExits(parentTradeId: string) {
  return db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.parentTradeId, parentTradeId))
    .orderBy(asc(schema.trades.closedAt));
}

export async function getParentTrade(tradeId: string) {
  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId));
  if (!trade?.parentTradeId) return null;
  const [parent] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, trade.parentTradeId));
  return parent ?? null;
}

// ─── Enriched Messages (trade-overlay chat feed) ────

export async function getEnrichedMessages(opts: {
  traders: string[];
  startDate: string;
  endDate: string;
  runId?: string;
  cursor?: string;
  limit?: number;
  /** Server-side role filter: 'executed' = has trade, 'skipped' = has decision */
  roleFilter?: 'all' | 'executed' | 'skipped';
}) {
  const pageSize = opts.limit ?? 100;
  const conditions: SQL[] = [
    gte(schema.messages.timestamp, opts.startDate),
    lte(schema.messages.timestamp, opts.endDate),
  ];
  if (opts.traders.length > 0) {
    conditions.push(or(...opts.traders.map((t) => eq(schema.messages.author, t)))!);
  }
  if (opts.cursor) {
    conditions.push(lt(schema.messages.timestamp, opts.cursor));
  }

  // Build LEFT JOIN conditions for runDecisions (backtest-only)
  const decisionJoin = opts.runId
    ? and(
        eq(schema.runDecisions.messageId, schema.messages.id),
        eq(schema.runDecisions.backtestRunId, opts.runId),
      )
    : sql`0 = 1`; // never match for live — live doesn't use runDecisions

  // Role-based server-side filtering
  if (opts.roleFilter === 'executed') {
    conditions.push(isNotNull(schema.trades.id));
  } else if (opts.roleFilter === 'skipped') {
    conditions.push(isNotNull(schema.runDecisions.decision));
  }

  const rows = await db
    .select({
      message: schema.messages,
      trade: {
        id: schema.trades.id,
        symbol: schema.trades.symbol,
        direction: schema.trades.direction,
        strategy: schema.trades.strategy,
        entryPrice: schema.trades.entryPrice,
        exitPrice: schema.trades.exitPrice,
        pnl: schema.trades.pnl,
        status: schema.trades.status,
        quantity: schema.trades.quantity,
        openedAt: schema.trades.openedAt,
        closedAt: schema.trades.closedAt,
      },
      decision: {
        decision: schema.runDecisions.decision,
        reasoning: schema.runDecisions.reasoning,
        pnl: schema.runDecisions.pnl,
        path: schema.runDecisions.path,
        durationMs: schema.runDecisions.durationMs,
      },
    })
    .from(schema.messages)
    .leftJoin(
      schema.trades,
      and(
        eq(schema.trades.sourceMessageId, schema.messages.id),
        tradeScope(opts.runId),
      ),
    )
    .leftJoin(schema.runDecisions, decisionJoin)
    .where(and(...conditions))
    .orderBy(desc(schema.messages.timestamp))
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;
  const result = hasMore ? rows.slice(0, pageSize) : rows;

  // Normalize & deduplicate: LEFT JOIN on trades can produce multiple rows
  // per message (compound messages with multiple trades). Keep first per message.
  const seen = new Set<string>();
  const enriched: EnrichedMessage[] = [];
  for (const r of result) {
    if (seen.has(r.message.id)) continue;
    seen.add(r.message.id);
    enriched.push({
      message: r.message,
      trade: r.trade?.id ? (r.trade as TradeOutcome) : null,
      decision: r.decision?.decision ? (r.decision as MessageDecision) : null,
    });
  }

  return {
    rows: enriched,
    nextCursor: hasMore ? result[result.length - 1].message.timestamp : null,
  };
}

// ─── Accuracy Queries (lazy, no eval run needed) ────

export async function computeGlobalAccuracy() {
  const { compareLabelsVsIntents } = await import('../../src/lib/eval');

  const CHUNK = 500;

  const labelRows = await db
    .select()
    .from(schema.messageLabels)
    .where(eq(schema.messageLabels.reviewed, true));

  if (labelRows.length === 0) return null;

  const labelMap = new Map(labelRows.map((l) => [l.messageId, l]));
  const labeledMessageIds = [...labelMap.keys()];

  const intentRows: (typeof schema.messageIntents.$inferSelect)[] = [];
  for (let i = 0; i < labeledMessageIds.length; i += CHUNK) {
    const chunk = labeledMessageIds.slice(i, i + CHUNK);
    const rows = await db
      .select()
      .from(schema.messageIntents)
      .where(inArray(schema.messageIntents.messageId, chunk));
    intentRows.push(...rows);
  }

  const intentMap = new Map<string, typeof schema.messageIntents.$inferSelect>();
  for (const row of intentRows) {
    const existing = intentMap.get(row.messageId);
    if (!existing || row.version > existing.version) intentMap.set(row.messageId, row);
  }

  const msgRows: { id: string; cleanText: string }[] = [];
  for (let i = 0; i < labeledMessageIds.length; i += CHUNK) {
    const chunk = labeledMessageIds.slice(i, i + CHUNK);
    const rows = await db
      .select({ id: schema.messages.id, cleanText: schema.messages.cleanText })
      .from(schema.messages)
      .where(inArray(schema.messages.id, chunk));
    msgRows.push(...rows);
  }
  const msgMap = new Map(msgRows.map((m) => [m.id, m.cleanText]));

  const pairs = labeledMessageIds
    .filter((mid) => intentMap.has(mid))
    .map((mid) => ({
      label: labelMap.get(mid)!,
      intent: intentMap.get(mid)!,
      cleanText: msgMap.get(mid) ?? '',
    }));

  if (pairs.length === 0) return null;

  return compareLabelsVsIntents(pairs);
}

export async function computeBacktestAccuracy(backtestRunId: string) {
  const { compareLabelsVsIntents } = await import('../../src/lib/eval');

  // 1. Get all message IDs that have a decision in this backtest run
  const decisionRows = await db
    .select({
      messageId: schema.runDecisions.messageId,
      decision: schema.runDecisions.decision,
    })
    .from(schema.runDecisions)
    .where(eq(schema.runDecisions.backtestRunId, backtestRunId));

  if (decisionRows.length === 0) return null;

  const messageIds = decisionRows.map((d) => d.messageId);

  // 2. Load reviewed labels for those messages
  const CHUNK = 500;
  const labelRows: (typeof schema.messageLabels.$inferSelect)[] = [];
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    const rows = await db
      .select()
      .from(schema.messageLabels)
      .where(and(
        inArray(schema.messageLabels.messageId, chunk),
        eq(schema.messageLabels.reviewed, true),
      ));
    labelRows.push(...rows);
  }

  if (labelRows.length === 0) return null;

  const labelMap = new Map(labelRows.map((l) => [l.messageId, l]));
  const labeledMessageIds = [...labelMap.keys()];

  // 3. Load latest intents for labeled messages
  const intentRows: (typeof schema.messageIntents.$inferSelect)[] = [];
  for (let i = 0; i < labeledMessageIds.length; i += CHUNK) {
    const chunk = labeledMessageIds.slice(i, i + CHUNK);
    const rows = await db
      .select()
      .from(schema.messageIntents)
      .where(inArray(schema.messageIntents.messageId, chunk));
    intentRows.push(...rows);
  }

  // Keep highest version per message
  const intentMap = new Map<string, typeof schema.messageIntents.$inferSelect>();
  for (const row of intentRows) {
    const existing = intentMap.get(row.messageId);
    if (!existing || row.version > existing.version) {
      intentMap.set(row.messageId, row);
    }
  }

  // 4. Load message text for failure reporting
  const msgRows: { id: string; cleanText: string }[] = [];
  for (let i = 0; i < labeledMessageIds.length; i += CHUNK) {
    const chunk = labeledMessageIds.slice(i, i + CHUNK);
    const rows = await db
      .select({ id: schema.messages.id, cleanText: schema.messages.cleanText })
      .from(schema.messages)
      .where(inArray(schema.messages.id, chunk));
    msgRows.push(...rows);
  }
  const msgMap = new Map(msgRows.map((m) => [m.id, m.cleanText]));

  // 5. Build pairs and compare
  const pairs = labeledMessageIds
    .filter((mid) => intentMap.has(mid))
    .map((mid) => ({
      label: labelMap.get(mid)!,
      intent: intentMap.get(mid)!,
      cleanText: msgMap.get(mid) ?? '',
    }));

  if (pairs.length === 0) return null;

  return {
    ...compareLabelsVsIntents(pairs),
    totalMessages: decisionRows.length,
    labeledMessages: labelRows.length,
  };
}
