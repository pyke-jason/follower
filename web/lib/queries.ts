import { db, schema } from './db';
import { eq, and, desc, sql, isNull, count, asc, lt, gte, lte, or, isNotNull, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { safeParseFloat } from '../../src/lib/numbers';
import { isOpen, isClosed, forSymbol, forTrader, forStrategy } from '../../src/trades/filters';
import type { EnrichedMessage, TradeOutcome, MessageDecision } from '../../src/lib/enriched-message';
import type { BacktestRunConfig } from '../../src/db/schema';

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
    .where(and(isOpen, tradeScope(runId)));

  const [todayPnlResult] = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
    })
    .from(schema.trades)
    .where(runId
      ? and(isClosed, tradeScope(runId))
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
    .where(and(isOpen, tradeScope(runId)))
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
  const conditions = [isClosed, tradeScope(opts.runId)];
  if (opts.trader) conditions.push(forTrader(opts.trader));
  if (opts.symbol) conditions.push(forSymbol(opts.symbol));
  if (opts.strategy) conditions.push(forStrategy(opts.strategy));

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

export async function getTradeByTaskId(taskId: string) {
  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.taskId, taskId));
  return trade ?? null;
}

export async function getDecisionsForTrade(trade: {
  id: string;
  sourceMessageId: string | null;
  closeMessageId: string | null;
  backtestRunId: string | null;
  taskId: string | null;
}) {
  const scopeFilter = trade.backtestRunId
    ? eq(schema.runDecisions.backtestRunId, trade.backtestRunId)
    : trade.taskId
      ? eq(schema.runDecisions.taskId, trade.taskId)
      : null;
  if (!scopeFilter) return [];

  // Step 1: Find all messageIds that produced decisions linked to this trade
  // (catches intermediate messages like leg-off that aren't source or close)
  const linkedRows = await db
    .selectDistinct({ messageId: schema.runDecisions.messageId })
    .from(schema.runDecisions)
    .where(and(eq(schema.runDecisions.tradeId, trade.id), scopeFilter));

  const messageIds = new Set(linkedRows.map(r => r.messageId));
  if (trade.sourceMessageId) messageIds.add(trade.sourceMessageId);
  if (trade.closeMessageId) messageIds.add(trade.closeMessageId);
  if (messageIds.size === 0) return [];

  // Step 2: Get ALL events for those messages (catches PARSED events that have no trade_id)
  return db.select().from(schema.runDecisions)
    .where(and(
      inArray(schema.runDecisions.messageId, [...messageIds]),
      scopeFilter,
    ))
    .orderBy(asc(schema.runDecisions.createdAt), asc(schema.runDecisions.signalIndex));
}

/** All messages from a specific author mentioning a specific symbol, ordered by time. */
export async function getMessagesByAuthorAndSymbol(author: string, symbol: string) {
  return db
    .select()
    .from(schema.messages)
    .where(and(
      eq(schema.messages.author, author),
      sql`EXISTS (SELECT 1 FROM json_each(${schema.messages.symbols}) WHERE json_each.value = ${symbol})`,
    ))
    .orderBy(asc(schema.messages.timestamp))
    .limit(100);
}

export async function getNearbyMessages(
  author: string | null,
  timestamp: string,
  windowMinutes = 60,
  symbol?: string,
) {
  const center = new Date(timestamp);
  // Widen window when filtering by symbol — fewer results so cast a wider net
  const effectiveWindow = symbol ? Math.max(windowMinutes, 240) : windowMinutes;
  const start = new Date(center.getTime() - effectiveWindow * 60 * 1000).toISOString();
  const end = new Date(center.getTime() + effectiveWindow * 60 * 1000).toISOString();

  const conditions = [
    gte(schema.messages.timestamp, start),
    lte(schema.messages.timestamp, end),
  ];
  if (author) conditions.push(eq(schema.messages.author, author));

  if (symbol) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM json_each(${schema.messages.symbols}) WHERE json_each.value = ${symbol})`,
    );
  }

  return db
    .select()
    .from(schema.messages)
    .where(and(...conditions))
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
  labelFilter?: 'labeled' | 'unlabeled';
} = {}) {
  const conditions: SQL[] = [];

  // Single author filter (legacy)
  if (opts.author) conditions.push(eq(schema.messages.author, opts.author));

  // Multi-author filter
  if (opts.authors && opts.authors.length > 0) {
    conditions.push(inArray(schema.messages.author, opts.authors));
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

  // Label-based filtering requires JOINs
  if (opts.labelFilter === 'labeled') {
    conditions.push(isNotNull(schema.messageLabels.id));
    conditions.push(eq(schema.messageLabels.reviewed, true));

    const query = db
      .select({ messages: schema.messages })
      .from(schema.messages)
      .innerJoin(schema.messageLabels, eq(schema.messages.id, schema.messageLabels.messageId))
      .orderBy(desc(schema.messages.timestamp))
      .limit(opts.limit ?? 50)
      .offset(opts.offset ?? 0);

    const rows = conditions.length > 0
      ? await query.where(and(...conditions))
      : await query;
    return rows.map((r) => r.messages);
  }

  if (opts.labelFilter === 'unlabeled') {
    const query = db
      .select({ messages: schema.messages })
      .from(schema.messages)
      .leftJoin(schema.messageLabels, eq(schema.messages.id, schema.messageLabels.messageId))
      .orderBy(desc(schema.messages.timestamp))
      .limit(opts.limit ?? 50)
      .offset(opts.offset ?? 0);

    conditions.push(
      or(
        isNull(schema.messageLabels.id),
        eq(schema.messageLabels.reviewed, false),
      )!,
    );

    const rows = await query.where(and(...conditions));
    return rows.map((r) => r.messages);
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

/** Get messages that reference any of the given symbols (via JSON symbols column). */
export async function getMessagesBySymbols(symbols: string[], limit = 200) {
  if (symbols.length === 0) return [];

  // SQLite JSON: check if any symbol appears in the json array
  const symbolConditions = symbols.map(
    (s) => sql`EXISTS (SELECT 1 FROM json_each(${schema.messages.symbols}) WHERE json_each.value = ${s})`,
  );

  return db
    .select()
    .from(schema.messages)
    .where(or(...symbolConditions)!)
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit);
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

/** Load just the commission schedule from a backtest run's config. Returns undefined if run not found. */
export async function getRunCommissionSchedule(runId: string) {
  const [run] = await db
    .select({ config: schema.backtestRuns.config })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, runId));
  if (!run) return undefined;
  return (run.config as BacktestRunConfig).commissionSchedule;
}

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
    .where(and(
      eq(schema.runDecisions.backtestRunId, backtestRunId),
      eq(schema.runDecisions.event, 'SETTLED'),
    ))
    .orderBy(desc(schema.runDecisions.createdAt));
}

/** Get the full event timeline for a message (all events, not just SETTLED). */
/** Get the SETTLED decision for a message (used by task detail / trade story). */
export async function getRunDecisionForTask(messageId: string, opts?: { backtestRunId?: string; taskId?: string }) {
  const conditions: SQL[] = [
    eq(schema.runDecisions.messageId, messageId),
    eq(schema.runDecisions.event, 'SETTLED'),
  ];
  if (opts?.backtestRunId) conditions.push(eq(schema.runDecisions.backtestRunId, opts.backtestRunId));
  else conditions.push(isNull(schema.runDecisions.backtestRunId));
  if (opts?.taskId) conditions.push(eq(schema.runDecisions.taskId, opts.taskId));

  const [row] = await db.select().from(schema.runDecisions)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

/** Get the full event timeline for a message (all events, not just SETTLED). */
export async function getDecisionTimeline(messageId: string, opts?: { backtestRunId?: string; taskId?: string }) {
  const conditions = [eq(schema.runDecisions.messageId, messageId)];
  if (opts?.backtestRunId) conditions.push(eq(schema.runDecisions.backtestRunId, opts.backtestRunId));
  if (opts?.taskId) conditions.push(eq(schema.runDecisions.taskId, opts.taskId));

  return db.select().from(schema.runDecisions)
    .where(and(...conditions))
    .orderBy(asc(schema.runDecisions.createdAt), asc(schema.runDecisions.signalIndex));
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
    conditions.push(isClosed);
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
    .where(and(isClosed, tradeScope(runId)))
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
  const conditions = [isClosed, tradeScope(opts.runId)];
  if (opts.trader) conditions.push(forTrader(opts.trader));
  if (opts.symbol) conditions.push(forSymbol(opts.symbol));
  if (opts.strategy) conditions.push(forStrategy(opts.strategy));

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

  const config = run.config as BacktestRunConfig;
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
    .where(and(isOpen, isNull(schema.trades.backtestRunId)))
    .groupBy(schema.trades.symbol);

  const [totalOpen] = await db
    .select({ count: count() })
    .from(schema.trades)
    .where(and(isOpen, isNull(schema.trades.backtestRunId)));

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

  // Get SETTLED decisions for both runs, keyed by messageId
  const decisionsA = await db
    .select({
      messageId: a.messageId,
      outcome: a.outcome,
      pnl: a.pnl,
      reasoning: a.reasoning,
    })
    .from(a)
    .where(and(eq(a.backtestRunId, runIdA), eq(a.event, 'SETTLED')));

  const decisionsB = await db
    .select({
      messageId: a.messageId,
      outcome: a.outcome,
      pnl: a.pnl,
      reasoning: a.reasoning,
    })
    .from(a)
    .where(and(eq(a.backtestRunId, runIdB), eq(a.event, 'SETTLED')));

  const mapA = new Map(decisionsA.map((d) => [d.messageId, d]));
  const mapB = new Map(decisionsB.map((d) => [d.messageId, d]));

  const allMessageIds = new Set([...mapA.keys(), ...mapB.keys()]);
  const diffs: {
    messageId: string;
    outcomeA: string | null;
    outcomeB: string | null;
    pnlA: number;
    pnlB: number;
    delta: number;
    reasoningA: string | null;
    reasoningB: string | null;
  }[] = [];

  for (const msgId of allMessageIds) {
    const dA = mapA.get(msgId);
    const dB = mapB.get(msgId);
    if (dA?.outcome !== dB?.outcome) {
      const pnlA = safeParseFloat(dA?.pnl);
      const pnlB = safeParseFloat(dB?.pnl);
      diffs.push({
        messageId: msgId,
        outcomeA: dA?.outcome ?? null,
        outcomeB: dB?.outcome ?? null,
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
        .where(inArray(schema.messages.id, msgIds))
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
    .where(inArray(schema.backtestRuns.id, ids));
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
    isClosed,
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
    isClosed,
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

// ─── Trade Events ───────────────────────────────────

export async function getTradeEvents(tradeId: string) {
  return db
    .select()
    .from(schema.tradeEvents)
    .where(eq(schema.tradeEvents.tradeId, tradeId))
    .orderBy(asc(schema.tradeEvents.timestamp));
}

export async function getTradeEventsForTrades(tradeIds: string[]) {
  if (tradeIds.length === 0) return new Map<string, (typeof schema.tradeEvents.$inferSelect)[]>();
  const rows = await db
    .select()
    .from(schema.tradeEvents)
    .where(inArray(schema.tradeEvents.tradeId, tradeIds))
    .orderBy(asc(schema.tradeEvents.timestamp));
  const grouped = new Map<string, (typeof schema.tradeEvents.$inferSelect)[]>();
  for (const row of rows) {
    const list = grouped.get(row.tradeId) ?? [];
    list.push(row);
    grouped.set(row.tradeId, list);
  }
  return grouped;
}

// ─── Enriched Messages (trade-overlay chat feed) ────

export async function getEnrichedMessages(opts: {
  traders: string[];
  startDate: string;
  endDate: string;
  runId?: string;
  cursor?: string;
  limit?: number;
  /** Server-side role filter: 'processed' = any decision, 'executed' = has trade, 'skipped' = has decision but no trade */
  roleFilter?: 'all' | 'processed' | 'executed' | 'skipped';
}) {
  const pageSize = opts.limit ?? 100;
  const conditions: SQL[] = [
    gte(schema.messages.timestamp, opts.startDate),
    lte(schema.messages.timestamp, opts.endDate),
  ];
  if (opts.traders.length > 0) {
    conditions.push(inArray(schema.messages.author, opts.traders));
  }
  if (opts.cursor) {
    conditions.push(lt(schema.messages.timestamp, opts.cursor));
  }

  // Build LEFT JOIN conditions for runDecisions — works for both backtest and live
  // Filter to SETTLED events only so summary views get one row per signal
  const decisionJoin = opts.runId
    ? and(
        eq(schema.runDecisions.messageId, schema.messages.id),
        eq(schema.runDecisions.backtestRunId, opts.runId),
        eq(schema.runDecisions.event, 'SETTLED'),
      )
    : and(
        eq(schema.runDecisions.messageId, schema.messages.id),
        isNull(schema.runDecisions.backtestRunId),
        eq(schema.runDecisions.event, 'SETTLED'),
      );

  // Role-based server-side filtering
  if (opts.roleFilter === 'processed') {
    conditions.push(isNotNull(schema.runDecisions.outcome));
  } else if (opts.roleFilter === 'executed') {
    conditions.push(isNotNull(schema.trades.id));
  } else if (opts.roleFilter === 'skipped') {
    conditions.push(and(isNotNull(schema.runDecisions.outcome), isNull(schema.trades.id))!);
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
        outcome: schema.runDecisions.outcome,
        reasoning: schema.runDecisions.reasoning,
        pnl: schema.runDecisions.pnl,
        phase: schema.runDecisions.phase,
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
      decision: r.decision?.outcome ? (r.decision as MessageDecision) : null,
    });
  }

  return {
    rows: enriched,
    nextCursor: hasMore ? result[result.length - 1].message.timestamp : null,
  };
}

