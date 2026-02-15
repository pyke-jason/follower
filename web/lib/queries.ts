import { db, schema } from './db';
import { eq, and, desc, sql, isNull, count, asc, lt, gte, lte, or, isNotNull, ne } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

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
    .where(and(eq(schema.trades.status, 'OPEN'), tradeScope(runId)));

  const [todayPnlResult] = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
    })
    .from(schema.trades)
    .where(runId
      ? and(eq(schema.trades.status, 'CLOSED'), tradeScope(runId))
      : and(isNull(schema.trades.backtestRunId), sql`closed_at >= date('now')`)
    );

  const [pendingTasksResult] = await db
    .select({ count: count() })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.status, 'PENDING'), taskScope(runId)));

  return {
    openTrades: openTradesResult?.count ?? 0,
    todayPnl: parseFloat(todayPnlResult?.total ?? '0'),
    pendingTasks: pendingTasksResult?.count ?? 0,
  };
}

export async function getOpenTrades(limit = 50, runId?: string) {
  return db
    .select()
    .from(schema.trades)
    .where(and(eq(schema.trades.status, 'OPEN'), tradeScope(runId)))
    .orderBy(desc(schema.trades.openedAt))
    .limit(limit);
}

export async function getClosedTrades(opts: {
  trader?: string;
  symbol?: string;
  limit?: number;
  offset?: number;
  runId?: string;
} = {}) {
  const conditions = [eq(schema.trades.status, 'CLOSED'), tradeScope(opts.runId)];
  if (opts.trader) conditions.push(eq(schema.trades.trader, opts.trader));
  if (opts.symbol) conditions.push(eq(schema.trades.symbol, opts.symbol));

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
  labelSet?: string;
  strategy?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const conditions: SQL[] = [];
  if (opts.reviewed !== undefined) {
    conditions.push(eq(schema.messageLabels.reviewed, opts.reviewed));
  }
  if (opts.labelSet) {
    conditions.push(eq(schema.messageLabels.labelSet, opts.labelSet));
  }
  if (opts.strategy) {
    conditions.push(eq(schema.messageLabels.strategy, opts.strategy));
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

export async function getLabelStats() {
  const [totals] = await db
    .select({
      total: count(),
      reviewed: sql<number>`SUM(CASE WHEN ${schema.messageLabels.reviewed} = 1 THEN 1 ELSE 0 END)`,
      unreviewed: sql<number>`SUM(CASE WHEN ${schema.messageLabels.reviewed} = 0 OR ${schema.messageLabels.reviewed} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(schema.messageLabels);

  const byStrategy = await db
    .select({
      strategy: schema.messageLabels.strategy,
      count: count(),
    })
    .from(schema.messageLabels)
    .groupBy(schema.messageLabels.strategy);

  const bySource = await db
    .select({
      source: schema.messageLabels.source,
      count: count(),
    })
    .from(schema.messageLabels)
    .groupBy(schema.messageLabels.source);

  return {
    total: totals?.total ?? 0,
    reviewed: totals?.reviewed ?? 0,
    unreviewed: totals?.unreviewed ?? 0,
    byStrategy: Object.fromEntries(byStrategy.map((r) => [r.strategy ?? 'null', r.count])),
    bySource: Object.fromEntries(bySource.map((r) => [r.source, r.count])),
  };
}

export async function getLabelWithMessage(labelId: string) {
  const [result] = await db
    .select({
      label: schema.messageLabels,
      message: schema.messages,
    })
    .from(schema.messageLabels)
    .innerJoin(schema.messages, eq(schema.messageLabels.messageId, schema.messages.id))
    .where(eq(schema.messageLabels.id, labelId));
  return result ?? null;
}
