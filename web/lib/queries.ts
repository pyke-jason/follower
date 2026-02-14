import { db, schema } from './db';
import { eq, and, desc, sql, isNull, count } from 'drizzle-orm';
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
  limit?: number;
  offset?: number;
} = {}) {
  const conditions = [];
  if (opts.author) conditions.push(eq(schema.messages.author, opts.author));

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
