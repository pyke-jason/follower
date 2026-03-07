import { Hono } from 'hono';
import { db, schema } from '../../db/client.js';
import { eq, and, desc, sql, isNull, count, asc, lt, gte, lte, or, isNotNull, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Trade, TradeFlag, TradeLeg, CommissionSchedule } from '../../db/schema.js';
import type { BrokerPosition } from '../../broker/types.js';
import type { EnrichedMessage, TradeOutcome, MessageDecision } from '../../lib/enriched-message.js';
import type { Strategy } from '../../lib/enums.js';
import { btChannel } from '../../lib/channel.js';
import { getDefaultRuntimeChannelId } from '../../lib/runtime-channels.js';
import { safeParseFloat, roundCents } from '../../lib/numbers.js';
import { isOpen, isClosed, forSymbol, forTrader, forStrategy } from '../../trades/filters.js';
import { getTradeFlags } from '../../db/accessors.js';
import { computeCoreStats } from '../../backtest/report.js';
import { computeTradeCommission } from '../../lib/commission.js';
import { tradeQty } from '../../lib/trade.js';
import { getProvider, SECRET_KEYS } from '../../lib/secrets/index.js';
import { getRuntimeBrokerMap } from '../../broker/select.js';
import { upsertRuntimeHealth } from '../../live/runtime-health.js';

const app = new Hono();

// ── Helpers ──────────────────────────────────────────

function isoToDateKey(iso: string): string {
  return iso.split('T')[0];
}

function resolveChannelId(channelId?: string): string {
  return channelId ?? getDefaultRuntimeChannelId();
}

function tradeScope(channelId?: string): SQL {
  return eq(schema.trades.channelId, resolveChannelId(channelId));
}

function taskScope(channelId?: string): SQL {
  return eq(schema.tasks.channelId, resolveChannelId(channelId));
}

function buildFlagsByTradeId(trades: Trade[]): Record<string, TradeFlag[]> {
  if (trades.length === 0) return {};
  const result: Record<string, TradeFlag[]> = {};
  for (const t of trades) {
    const flags = getTradeFlags(t);
    if (flags.length > 0) result[t.id] = flags;
  }
  return result;
}

async function getBacktestRunIdByChannelId(channelId: string): Promise<string | null> {
  const runs = await db
    .select({ id: schema.backtestRuns.id })
    .from(schema.backtestRuns);
  const match = runs.find((run) => btChannel(run.id) === channelId);
  return match?.id ?? null;
}

// ── GET /status ──────────────────────────────────────

app.get('/status', async (c) => {
  const channelId = resolveChannelId(c.req.query('channel') || undefined);
  const backtestRunId = await getBacktestRunIdByChannelId(channelId);
  const stats = await getStatsInternal(channelId, { useTotalPnl: !!backtestRunId });

  if (backtestRunId) {
    const brief = await getBacktestRunBrief(backtestRunId);
    return c.json({
      ...stats,
      channelId,
      channelKind: 'backtest',
      channelBrief: brief ?? undefined,
    });
  }

  const [risk, health] = await Promise.all([
    getRiskSnapshotInternal(channelId),
    getRuntimeHealthInternal(channelId),
  ]);
  return c.json({
    ...stats,
    channelId,
    channelKind: 'runtime',
    tradingBlocked: risk.tradingBlocked,
    unresolvedAlertCount: risk.unresolvedAlerts,
    ...(health && {
      brokerHealthy: health.brokerHealthy,
      circuitOpen: health.circuitOpen,
      lastError: health.lastError,
      healthUpdatedAt: health.updatedAt,
    }),
  });
});

// ── GET /signals ─────────────────────────────────────

app.get('/signals', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '20', 10);
  const channelId = resolveChannelId(c.req.query('channel') || undefined);

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
        tradeScope(channelId),
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

  return c.json(messages);
});

// ── GET /backtest-runs ───────────────────────────────

app.get('/backtest-runs', async (c) => {
  const runs = await db
    .select()
    .from(schema.backtestRuns)
    .where(inArray(schema.backtestRuns.status, ['COMPLETED', 'RUNNING', 'CANCELLED']))
    .orderBy(desc(schema.backtestRuns.createdAt))
    .limit(30);

  const items = runs.map((r) => {
      const config = r.config;
      const summary = r.summary;
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        traders: config.traders,
        startDate: isoToDateKey(config.startDate),
        endDate: isoToDateKey(config.endDate),
        totalPnl: summary?.totalPnl ?? null,
        winRate: summary?.winRate ?? null,
      };
    });

  return c.json(items);
});

// ── GET /dashboard ───────────────────────────────────

app.get('/dashboard', async (c) => {
  const channelId = resolveChannelId(c.req.query('channel') || undefined);
  const backtestRunId = await getBacktestRunIdByChannelId(channelId);

  const [stats, openTrades, traderPnl, historySummary, risk, dailyBalances] = await Promise.all([
    getStatsInternal(channelId, { useTotalPnl: !!backtestRunId }),
    getOpenTradesInternal(50, channelId),
    getTraderPnlSummaryInternal(channelId),
    getTradeHistorySummaryInternal({ channelId }),
    backtestRunId ? Promise.resolve(null) : getRiskSnapshotInternal(channelId),
    getDailyBalancesInternal(30, channelId),
  ]);

  return c.json({ stats, openTrades, traderPnl, historySummary, risk, dailyBalances, channelId });
});

// ── GET /trades ──────────────────────────────────────

app.get('/trades', async (c) => {
  const status = c.req.query('status');
  const trader = c.req.query('trader') || undefined;
  const symbol = c.req.query('symbol') || undefined;
  const strategy = c.req.query('strategy') || undefined;
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const channelId = c.req.query('channel') || undefined;

  const conditions: SQL[] = [tradeScope(channelId)];
  if (status === 'open') conditions.push(isOpen);
  else if (status === 'closed') conditions.push(isClosed);
  if (trader) conditions.push(forTrader(trader));
  if (symbol) conditions.push(forSymbol(symbol));
  if (strategy) conditions.push(forStrategy(strategy as Strategy));

  const trades = await db
    .select()
    .from(schema.trades)
    .where(and(...conditions))
    .orderBy(desc(schema.trades.openedAt))
    .limit(limit)
    .offset(offset);

  const flags = buildFlagsByTradeId(trades);
  return c.json({ trades, flags });
});

// ── GET /trades/:id ──────────────────────────────────

app.get('/trades/:id', async (c) => {
  const id = c.req.param('id');
  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, id));

  if (!trade) return c.json({ error: 'Trade not found' }, 404);
  return c.json(trade);
});

// ── GET /trades/:id/story ────────────────────────────

app.get('/trades/:id/story', async (c) => {
  const tradeId = c.req.param('id');

  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId));
  if (!trade) return c.json({ error: 'Trade not found' }, 404);

  const [events, task, sourceMessage, closeMessage] = await Promise.all([
    db.select().from(schema.tradeEvents).where(eq(schema.tradeEvents.tradeId, tradeId)).orderBy(asc(schema.tradeEvents.timestamp)),
    trade.taskId
      ? db.select().from(schema.tasks).where(eq(schema.tasks.id, trade.taskId)).then(r => r[0] ?? null)
      : Promise.resolve(null),
    trade.sourceMessageId
      ? db.select().from(schema.messages).where(eq(schema.messages.id, trade.sourceMessageId)).then(r => r[0] ?? null)
      : Promise.resolve(null),
    trade.closeMessageId
      ? db.select().from(schema.messages).where(eq(schema.messages.id, trade.closeMessageId)).then(r => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  // Nearby messages + run decision
  const [nearbyMessages, runDecisionRow] = await Promise.all([
    sourceMessage && trade.symbol
      ? db.select().from(schema.messages)
          .where(and(
            eq(schema.messages.author, sourceMessage.author),
            sql`EXISTS (SELECT 1 FROM json_each(${schema.messages.symbols}) WHERE json_each.value = ${trade.symbol})`,
          ))
          .orderBy(asc(schema.messages.timestamp))
          .limit(100)
      : Promise.resolve([]),
    trade.sourceMessageId
      ? getRunDecisionForTaskInternal(trade.sourceMessageId, {
          channelId: trade.channelId,
          taskId: trade.taskId ?? undefined,
        })
      : Promise.resolve(null),
  ]);

  // Fetch full decisions for the execution timeline
  const decisions = await getDecisionsForTradeInternal(trade);
  const knownMessageIds = new Set([trade.sourceMessageId, trade.closeMessageId].filter(Boolean));
  const intermediateIds = Array.from(new Set(decisions.map(d => d.messageId).filter((id): id is string => id != null))).filter(id => !knownMessageIds.has(id));
  const intermediateMessages = intermediateIds.length > 0
    ? await db.select().from(schema.messages).where(inArray(schema.messages.id, intermediateIds)).then(rows => rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp)))
    : [];

  const timelineMessages = [sourceMessage, closeMessage, ...intermediateMessages]
    .filter((m): m is NonNullable<typeof m> => m != null);

  return c.json({ trade, events, task, sourceMessage, closeMessage, nearbyMessages, decision: runDecisionRow, decisions, timelineMessages });
});

// ── GET /trades/by-task/:taskId ──────────────────────

app.get('/trades/by-task/:taskId', async (c) => {
  const taskId = c.req.param('taskId');
  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.taskId, taskId));
  return c.json(trade ?? null);
});

// ── GET /open-pnl ────────────────────────────────────
// Returns unrealized P&L per open trade by matching broker positions to trade legs.

function positionUnderlying(p: BrokerPosition): string {
  if (!p.optionType) return p.symbol;
  return p.symbol.split(/\s+/)[0];
}

app.get('/open-pnl', async (c) => {
  const channelId = resolveChannelId(c.req.query('channel') || undefined);

  const broker = getRuntimeBrokerMap().get(channelId);
  if (!broker) return c.json({});

  let positions: BrokerPosition[];
  try {
    positions = await broker.getPositions();
  } catch {
    return c.json({});
  }

  const openTrades = await db
    .select()
    .from(schema.trades)
    .where(and(isOpen, tradeScope(channelId)));

  const result: Record<string, number> = {};

  for (const trade of openTrades) {
    const legs = trade.legs as TradeLeg[];
    let totalPnl = 0;
    let matched = false;

    if (trade.strategy === 'STOCK') {
      const pos = positions.find(
        (p) => !p.optionType && p.symbol === trade.symbol,
      );
      if (pos?.unrealizedPnl != null) {
        totalPnl = pos.unrealizedPnl;
        matched = true;
      }
    } else {
      for (const leg of legs) {
        const pos = positions.find(
          (p) =>
            p.optionType === leg.type &&
            p.strikePrice === leg.strike &&
            p.expiry === leg.expiry &&
            positionUnderlying(p) === trade.symbol,
        );
        if (pos?.unrealizedPnl != null) {
          totalPnl += pos.unrealizedPnl;
          matched = true;
        }
      }
    }

    if (matched) {
      result[trade.id] = roundCents(totalPnl);
    }
  }

  return c.json(result);
});

// ── GET /tasks ───────────────────────────────────────

app.get('/tasks', async (c) => {
  const status = c.req.query('status') || undefined;
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const channelId = c.req.query('channel') || undefined;

  const conditions: SQL[] = [taskScope(channelId)];
  if (status) conditions.push(eq(schema.tasks.status, status));

  const tasks = await db
    .select()
    .from(schema.tasks)
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json(tasks);
});

// ── GET /tasks/:id ───────────────────────────────────

app.get('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id));
  if (!task) return c.json({ error: 'Task not found' }, 404);

  // If this task produced a trade, redirect to the trade detail page
  const [linkedTrade] = await db
    .select({ id: schema.trades.id, channelId: schema.trades.channelId })
    .from(schema.trades)
    .where(eq(schema.trades.taskId, id));
  if (linkedTrade) {
    return c.json({
      redirect: `/trades/${linkedTrade.id}?channel=${encodeURIComponent(linkedTrade.channelId)}`,
    });
  }

  // Fetch related data in parallel
  const [sourceMessage, runDecisionRow] = await Promise.all([
    task.messageId
      ? db.select().from(schema.messages).where(eq(schema.messages.id, task.messageId)).then(r => r[0] ?? null)
      : Promise.resolve(null),
    task.messageId
      ? getRunDecisionForTaskInternal(task.messageId, {
          channelId: task.channelId,
          taskId: task.id,
        })
      : Promise.resolve(null),
  ]);

  // Fetch nearby messages by the same author with matching symbols
  const context = task.context as Record<string, unknown> | null;
  const author = sourceMessage?.author ?? (context?.author as string | undefined);
  const symbols = (context?.symbols as string[] | undefined) ?? [];
  const firstSymbol = symbols[0];

  const nearbyMessages = (sourceMessage && author && firstSymbol)
    ? await db.select().from(schema.messages)
        .where(and(
          eq(schema.messages.author, author),
          sql`EXISTS (SELECT 1 FROM json_each(${schema.messages.symbols}) WHERE json_each.value = ${firstSymbol})`,
        ))
        .orderBy(desc(schema.messages.timestamp))
        .limit(20)
    : [];

  return c.json({
    task,
    sourceMessage,
    runDecision: runDecisionRow,
    nearbyMessages,
    channelId: task.channelId,
  });
});

// ── GET /messages ────────────────────────────────────

app.get('/messages', async (c) => {
  const channelId = c.req.query('channel') || undefined;
  const authorsRaw = c.req.query('authors');
  const authors = authorsRaw ? authorsRaw.split(',').filter(Boolean) : undefined;
  const startDate = c.req.query('startDate') || undefined;
  const endDate = c.req.query('endDate') || undefined;
  const cursor = c.req.query('cursor') || undefined;
  const signalsOnly = c.req.query('signalsOnly') === 'true';
  const labelFilter = c.req.query('labelFilter') as 'labeled' | 'unlabeled' | 'needs-review' | undefined;
  const roleFilter = c.req.query('roleFilter') as 'all' | 'processed' | 'executed' | 'skipped' | undefined;
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  if (channelId) {
    // Enriched path
    const enrichedResult = await getEnrichedMessagesInternal({
      traders: authors ?? [],
      startDate: startDate ?? '',
      endDate: endDate ?? '',
      cursor,
      channelId,
      roleFilter,
      limit,
    });

    const messages = enrichedResult.rows.map((r) => r.message);
    const enrichment: Record<string, { decision: MessageDecision | null; trade: TradeOutcome | null }> = {};
    for (const r of enrichedResult.rows) {
      enrichment[r.message.id] = { decision: r.decision, trade: r.trade };
    }

    const ids = messages.map((m) => m.id);
    const labels = await getLabelsForMessagesInternal(ids);
    const allAuthors = await db
      .selectDistinct({ author: schema.messages.author })
      .from(schema.messages)
      .orderBy(schema.messages.author);

    return c.json({ messages, labels, enrichment, nextCursor: enrichedResult.nextCursor, authors: allAuthors.map((r) => r.author) });
  }

  // Standard path
  const rows = await getMessagesInternal({
    author: undefined,
    authors,
    limit: limit + 1,
    offset,
    cursor,
    startDate,
    endDate,
    signalsOnly,
    labelFilter,
  });

  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? messages[messages.length - 1].timestamp : null;

  const ids = messages.map((m) => m.id);
  const labels = await getLabelsForMessagesInternal(ids);
  const allAuthors = await db
    .selectDistinct({ author: schema.messages.author })
    .from(schema.messages)
    .orderBy(schema.messages.author);

  return c.json({ messages, labels, enrichment: null, nextCursor, authors: allAuthors.map((r) => r.author) });
});

// ── GET /messages/nearby ─────────────────────────────
// Static routes MUST be registered before parametric /:id

app.get('/messages/nearby', async (c) => {
  const author = c.req.query('author') || null;
  const timestamp = c.req.query('timestamp') ?? '';
  const windowMinutes = parseInt(c.req.query('window') ?? '60', 10);
  const symbol = c.req.query('symbol') || undefined;

  const center = new Date(timestamp);
  const effectiveWindow = symbol ? Math.max(windowMinutes, 240) : windowMinutes;
  const start = new Date(center.getTime() - effectiveWindow * 60 * 1000).toISOString();
  const end = new Date(center.getTime() + effectiveWindow * 60 * 1000).toISOString();

  const conditions: SQL[] = [
    gte(schema.messages.timestamp, start),
    lte(schema.messages.timestamp, end),
  ];
  if (author) conditions.push(eq(schema.messages.author, author));
  if (symbol) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM json_each(${schema.messages.symbols}) WHERE json_each.value = ${symbol})`,
    );
  }

  const messages = await db
    .select()
    .from(schema.messages)
    .where(and(...conditions))
    .orderBy(asc(schema.messages.timestamp))
    .limit(50);

  return c.json(messages);
});

// ── GET /messages/:id ────────────────────────────────

app.get('/messages/:id', async (c) => {
  const id = c.req.param('id');
  const [msg] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, id));
  if (!msg) return c.json({ error: 'Message not found' }, 404);
  return c.json(msg);
});

// ── GET /messages/:id/related ────────────────────────

app.get('/messages/:id/related', async (c) => {
  const messageId = c.req.param('id');
  const [source] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId));
  if (!source) return c.json({ messages: [], labels: {}, sourceSymbols: [] });

  const sourceSymbols: string[] = source.symbols;
  if (sourceSymbols.length === 0) return c.json({ messages: [source], labels: {}, sourceSymbols });

  const symbolConditions = sourceSymbols.map(
    (s) => sql`EXISTS (SELECT 1 FROM json_each(${schema.messages.symbols}) WHERE json_each.value = ${s})`,
  );
  const messages = await db
    .select()
    .from(schema.messages)
    .where(or(...symbolConditions)!)
    .orderBy(desc(schema.messages.timestamp))
    .limit(200);

  const ids = messages.map((m) => m.id);
  const labels = await getLabelsForMessagesInternal(ids);

  return c.json({ messages, labels, sourceSymbols });
});

// ── GET /authors ─────────────────────────────────────

app.get('/authors', async (c) => {
  const rows = await db
    .selectDistinct({ author: schema.messages.author })
    .from(schema.messages)
    .orderBy(schema.messages.author);
  return c.json(rows.map((r) => r.author));
});

// ── GET /tracked-traders ─────────────────────────────

app.get('/tracked-traders', async (c) => {
  const traders = await db.select().from(schema.trackedTraders);
  return c.json(traders);
});

// ── GET /traders/:name ───────────────────────────────

app.get('/traders/:name', async (c) => {
  const name = c.req.param('name');
  const channelId = c.req.query('channel') || undefined;

  const [trader] = await db
    .select()
    .from(schema.trackedTraders)
    .where(eq(schema.trackedTraders.name, name));
  if (!trader) return c.json({ error: 'Trader not found' }, 404);

  const [equityCurve, strategyBreakdown, historySummary, closedTrades] = await Promise.all([
    getTraderEquityCurveInternal(name, channelId),
    getTraderStrategyBreakdownInternal(name, channelId),
    getTradeHistorySummaryInternal({ trader: name, channelId }),
    (async () => {
      const conditions: SQL[] = [isClosed, eq(schema.trades.trader, name), tradeScope(channelId)];
      return db
        .select()
        .from(schema.trades)
        .where(and(...conditions))
        .orderBy(desc(schema.trades.closedAt))
        .limit(50);
    })(),
  ]);

  return c.json({ trader, equityCurve, strategyBreakdown, historySummary, closedTrades });
});

// ── GET /backtests ───────────────────────────────────

app.get('/backtests', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const runs = await db
    .select()
    .from(schema.backtestRuns)
    .orderBy(desc(schema.backtestRuns.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json(runs);
});

// ── GET /backtests/tags ──────────────────────────────
// Static routes MUST be registered before parametric /:id

app.get('/backtests/tags', async (c) => {
  const rows = await db
    .selectDistinct({ tag: schema.backtestRuns.experimentTag })
    .from(schema.backtestRuns)
    .where(isNotNull(schema.backtestRuns.experimentTag));
  return c.json(rows.map((r) => r.tag).filter(Boolean));
});

// ── GET /backtests/compare ───────────────────────────

app.get('/backtests/compare', async (c) => {
  const idsRaw = c.req.query('ids');
  if (!idsRaw) return c.json({ error: 'ids param required' }, 400);
  const ids = idsRaw.split(',').filter(Boolean);
  if (ids.length === 0) return c.json([]);

  const runs = await db
    .select()
    .from(schema.backtestRuns)
    .where(inArray(schema.backtestRuns.id, ids));
  return c.json(runs);
});

// ── GET /backtests/compare/diff ──────────────────────

app.get('/backtests/compare/diff', async (c) => {
  const a = c.req.query('a');
  const b = c.req.query('b');
  if (!a || !b) return c.json({ error: 'a and b params required' }, 400);

  const rd = schema.runDecisions;

  const [decisionsA, decisionsB] = await Promise.all([
    db.select({ messageId: rd.messageId, outcome: rd.outcome, pnl: rd.pnl, reasoning: rd.reasoning })
      .from(rd).where(eq(rd.channelId, btChannel(a))),
    db.select({ messageId: rd.messageId, outcome: rd.outcome, pnl: rd.pnl, reasoning: rd.reasoning })
      .from(rd).where(eq(rd.channelId, btChannel(b))),
  ]);

  const mapA = new Map(decisionsA.map((d) => [d.messageId, d]));
  const mapB = new Map(decisionsB.map((d) => [d.messageId, d]));
  const allMessageIds = new Set(Array.from(mapA.keys()).concat(Array.from(mapB.keys())));

  const diffs: {
    messageId: string | null;
    decisionA: string | null;
    decisionB: string | null;
    pnlA: number;
    pnlB: number;
    delta: number;
    reasoningA: string | null;
    reasoningB: string | null;
  }[] = [];

  for (const msgId of Array.from(allMessageIds)) {
    const dA = mapA.get(msgId);
    const dB = mapB.get(msgId);
    if (dA?.outcome !== dB?.outcome) {
      const pnlA = safeParseFloat(dA?.pnl);
      const pnlB = safeParseFloat(dB?.pnl);
      diffs.push({
        messageId: msgId,
        decisionA: dA?.outcome ?? null,
        decisionB: dB?.outcome ?? null,
        pnlA,
        pnlB,
        delta: pnlB - pnlA,
        reasoningA: dA?.reasoning ?? null,
        reasoningB: dB?.reasoning ?? null,
      });
    }
  }

  const msgIds = diffs.map((d) => d.messageId).filter((id): id is string => id != null);
  const messages = msgIds.length > 0
    ? await db
        .select({ id: schema.messages.id, cleanText: schema.messages.cleanText, author: schema.messages.author })
        .from(schema.messages)
        .where(inArray(schema.messages.id, msgIds))
    : [];
  const msgMap = new Map(messages.map((m) => [m.id, m]));

  const result = diffs
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .map((d) => ({ ...d, message: (d.messageId && msgMap.get(d.messageId)) ?? null }));

  return c.json(result);
});

// ── GET /backtests/:id ───────────────────────────────

app.get('/backtests/:id', async (c) => {
  const id = c.req.param('id');
  const channelId = btChannel(id);

  const [run] = await db
    .select()
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, id));
  if (!run) return c.json({ error: 'Backtest not found' }, 404);

  const config = run.config;
  const lastProcessedTs = run.status !== 'COMPLETED'
    ? run.liveMetrics?.lastProcessedMessageTs ?? null
    : null;
  const messagesEndDate = lastProcessedTs
    ? new Date(new Date(lastProcessedTs).getTime() + 3600_000).toISOString()
    : config.endDate;

  const [decisions, allTrades, mtmSnapshots] = await Promise.all([
    db.select({
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
    .where(eq(schema.runDecisions.channelId, channelId))
    .orderBy(desc(schema.runDecisions.createdAt)),

    db.select().from(schema.trades)
      .where(eq(schema.trades.channelId, channelId))
      .orderBy(desc(schema.trades.closedAt)),

    db.select({
      date: schema.backtestMtmSnapshots.date,
      unrealizedPnl: schema.backtestMtmSnapshots.unrealizedPnl,
    })
    .from(schema.backtestMtmSnapshots)
    .where(eq(schema.backtestMtmSnapshots.channelId, channelId))
    .orderBy(asc(schema.backtestMtmSnapshots.date)),
  ]);

  const tradeIds = allTrades.map((t) => t.id);
  const eventRows = tradeIds.length > 0
    ? await db.select().from(schema.tradeEvents).where(inArray(schema.tradeEvents.tradeId, tradeIds)).orderBy(asc(schema.tradeEvents.timestamp))
    : [];

  const eventsByTradeId: Record<string, typeof eventRows> = {};
  for (const row of eventRows) {
    (eventsByTradeId[row.tradeId] ??= []).push(row);
  }

  const flagsByTradeId = buildFlagsByTradeId(allTrades);

  // Clamp closedAt dates to the backtest end date
  const backtestEnd = isoToDateKey(config.endDate);
  const clampedTrades = allTrades.map((t) => {
    if (!t.closedAt || isoToDateKey(t.closedAt) <= backtestEnd) return t;
    return { ...t, closedAt: `${backtestEnd}T16:00:00.000Z` };
  });

  // computeFromTrades
  const commissionSchedule = config.commissionSchedule;
  const computeResult = computeFromTrades(clampedTrades, decisions, mtmSnapshots, commissionSchedule);

  // LLM token sums
  const llmTokens = decisions.reduce(
    (acc, d) => ({
      input: acc.input + (d.decision.inputTokens ?? 0),
      output: acc.output + (d.decision.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  );

  return c.json({
    run,
    decisions,
    allTrades,
    eventsByTradeId,
    flagsByTradeId,
    mtmSnapshots,
    ...computeResult,
    llmTokens,
    messagesEndDate,
  });
});

// ── GET /backtests/:id/brief ─────────────────────────

app.get('/backtests/:id/brief', async (c) => {
  const id = c.req.param('id');
  const brief = await getBacktestRunBrief(id);
  if (!brief) return c.json({ error: 'Not found' }, 404);
  return c.json(brief);
});

// ── GET /backtests/:id/accuracy ──────────────────────

app.get('/backtests/:id/accuracy', async (c) => {
  const id = c.req.param('id');
  const channelId = btChannel(id);
  const { compareLabelsVsIntents } = await import('../../lib/eval.js');

  const decisionRows = await db
    .select({
      messageId: schema.runDecisions.messageId,
      outcome: schema.runDecisions.outcome,
    })
    .from(schema.runDecisions)
    .where(eq(schema.runDecisions.channelId, channelId));

  if (decisionRows.length === 0) return c.json(null);

  const messageIds = decisionRows.map((d) => d.messageId).filter((id): id is string => id != null);

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

  if (labelRows.length === 0) return c.json(null);

  const labelMap = new Map(labelRows.map((l) => [l.messageId, l]));
  const labeledMessageIds = Array.from(labelMap.keys());

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
    if (!existing || row.version > existing.version) {
      intentMap.set(row.messageId, row);
    }
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

  if (pairs.length === 0) return c.json(null);

  return c.json({
    ...compareLabelsVsIntents(pairs),
    totalMessages: decisionRows.length,
    labeledMessages: labelRows.length,
  });
});

// ── GET /run-decisions ───────────────────────────────

app.get('/run-decisions', async (c) => {
  const channelId = c.req.query('channel');
  if (!channelId) return c.json({ error: 'channel param required' }, 400);

  const rows = await db
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
    .where(eq(schema.runDecisions.channelId, channelId))
    .orderBy(desc(schema.runDecisions.createdAt));

  return c.json(rows);
});

// ── GET /risk ────────────────────────────────────────

app.get('/risk', async (c) => {
  const channelId = resolveChannelId(c.req.query('channel') || undefined);
  const risk = await getRiskSnapshotInternal(channelId);
  return c.json({ ...risk, channelId });
});

// ── GET /recon-alerts ────────────────────────────────

app.get('/recon-alerts', async (c) => {
  const channelId = resolveChannelId(c.req.query('channel') || undefined);
  const resolved = c.req.query('resolved');
  const limit = parseInt(c.req.query('limit') ?? '100', 10);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  const conditions: SQL[] = [
    eq(schema.reconciliationAlerts.channelId, channelId),
  ];
  if (resolved !== undefined) {
    conditions.push(eq(schema.reconciliationAlerts.resolved, resolved === 'true'));
  }

  const query = db
    .select()
    .from(schema.reconciliationAlerts)
    .orderBy(desc(schema.reconciliationAlerts.createdAt))
    .limit(limit)
    .offset(offset);

  const alerts = conditions.length > 0
    ? await query.where(and(...conditions))
    : await query;

  return c.json(alerts);
});

// ── GET /recon-alerts/stats ──────────────────────────

app.get('/recon-alerts/stats', async (c) => {
  const channelId = resolveChannelId(c.req.query('channel') || undefined);
  const [totals] = await db
    .select({
      total: count(),
      unresolved: sql<number>`SUM(CASE WHEN ${schema.reconciliationAlerts.resolved} = 0 THEN 1 ELSE 0 END)`,
      resolved: sql<number>`SUM(CASE WHEN ${schema.reconciliationAlerts.resolved} = 1 THEN 1 ELSE 0 END)`,
    })
    .from(schema.reconciliationAlerts)
    .where(eq(schema.reconciliationAlerts.channelId, channelId));

  const byType = await db
    .select({
      type: schema.reconciliationAlerts.type,
      count: count(),
    })
    .from(schema.reconciliationAlerts)
    .where(and(
      eq(schema.reconciliationAlerts.channelId, channelId),
      eq(schema.reconciliationAlerts.resolved, false),
    ))
    .groupBy(schema.reconciliationAlerts.type);

  return c.json({
    total: totals?.total ?? 0,
    unresolved: totals?.unresolved ?? 0,
    resolved: totals?.resolved ?? 0,
    byType: Object.fromEntries(byType.map((r) => [r.type, r.count])),
  });
});

// ── GET /daily-balances ──────────────────────────────

app.get('/daily-balances', async (c) => {
  const channelId = resolveChannelId(c.req.query('channel') || undefined);
  const limit = parseInt(c.req.query('limit') ?? '30', 10);
  const balances = await db
    .select()
    .from(schema.dailyBalances)
    .where(eq(schema.dailyBalances.channelId, channelId))
    .orderBy(desc(schema.dailyBalances.date))
    .limit(limit);
  return c.json(balances);
});

// ── GET /intents ─────────────────────────────────────

app.get('/intents', async (c) => {
  const idsRaw = c.req.query('ids');
  if (!idsRaw) return c.json({});
  const messageIds = idsRaw.split(',').filter(Boolean);
  if (messageIds.length === 0) return c.json({});

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
  const map: Record<string, typeof schema.messageIntents.$inferSelect> = {};
  for (const row of all) {
    const existing = map[row.messageId];
    if (!existing || row.version > existing.version) {
      map[row.messageId] = row;
    }
  }
  return c.json(map);
});

// ── GET /settings/secrets ────────────────────────────

const TOGGLE_KEYS: Record<string, string> = {
  ALERTS_DISCORD_ENABLED: 'ALERTS_DISCORD_ENABLED',
  ALERTS_PUSHOVER_ENABLED: 'ALERTS_PUSHOVER_ENABLED',
  LIVE_INGESTION_ENABLED: 'LIVE_INGESTION_ENABLED',
};

app.get('/settings/secrets', async (c) => {
  const provider = getProvider();
  const setKeys = await provider.list();
  const setKeySet = new Set(setKeys);
  const secrets = SECRET_KEYS
    .filter((key) => !(key in TOGGLE_KEYS))
    .map((key) => ({ key, isSet: setKeySet.has(key) }));
  return c.json(secrets);
});

// ── GET /settings/toggles ────────────────────────────

app.get('/settings/toggles', async (c) => {
  const provider = getProvider();
  const secrets = await provider.load();
  return c.json({
    discord: secrets.ALERTS_DISCORD_ENABLED !== '0',
    pushover: secrets.ALERTS_PUSHOVER_ENABLED !== '0',
    ingestion: secrets.LIVE_INGESTION_ENABLED !== '0',
  });
});

// ── GET /channels ────────────────────────────────────

app.get('/channels', async (c) => {
  const { getRuntimeChannelDefinitions } = await import('../../lib/runtime-channels.js');
  const defs = getRuntimeChannelDefinitions();
  const runs = await db
    .select()
    .from(schema.backtestRuns)
    .where(inArray(schema.backtestRuns.status, ['COMPLETED', 'RUNNING', 'CANCELLED']))
    .orderBy(desc(schema.backtestRuns.createdAt))
    .limit(30);

  const runtimeChannels = defs.map((def) => ({
    id: def.channelId,
    kind: 'runtime' as const,
    label: def.label,
    brokerName: def.brokerName,
    mode: def.mode,
    accountId: def.accountId,
  }));

  const backtestChannels = runs.map((r) => {
      const config = r.config;
      const summary = r.summary;
      return {
        id: btChannel(r.id),
        kind: 'backtest' as const,
        runId: r.id,
        label: r.name || `${config.traders.join(', ')} ${isoToDateKey(config.startDate)}`,
        status: r.status,
        traders: config.traders,
        startDate: isoToDateKey(config.startDate),
        endDate: isoToDateKey(config.endDate),
        totalPnl: summary?.totalPnl ?? null,
        winRate: summary?.winRate ?? null,
      };
    });

  return c.json({
    defaultChannelId: runtimeChannels[0]?.id ?? null,
    runtimeChannels,
    backtestChannels,
  });
});

// ── Internal helpers ─────────────────────────────────

async function getStatsInternal(
  channelId?: string,
  opts: { useTotalPnl?: boolean } = {},
) {
  const scopedChannelId = resolveChannelId(channelId);
  const [openTradesResult] = await db
    .select({ count: count() })
    .from(schema.trades)
    .where(and(isOpen, tradeScope(scopedChannelId)));

  const [todayPnlResult] = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
    })
    .from(schema.trades)
    .where((opts.useTotalPnl ?? false)
      ? and(isClosed, tradeScope(scopedChannelId))
      : and(isClosed, tradeScope(scopedChannelId), sql`closed_at >= date('now')`)
    );

  const [pendingTasksResult] = await db
    .select({ count: count() })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.status, 'PENDING'), taskScope(scopedChannelId)));

  return {
    openTrades: openTradesResult?.count ?? 0,
    todayPnl: safeParseFloat(todayPnlResult?.total),
    pendingTasks: pendingTasksResult?.count ?? 0,
  };
}

async function getOpenTradesInternal(limit = 50, channelId?: string) {
  return db
    .select()
    .from(schema.trades)
    .where(and(isOpen, tradeScope(channelId)))
    .orderBy(desc(schema.trades.openedAt))
    .limit(limit);
}

async function getTraderPnlSummaryInternal(channelId?: string) {
  return db
    .select({
      trader: schema.trades.trader,
      totalPnl: sql<string>`COALESCE(SUM(CAST(${schema.trades.pnl} AS REAL)), 0)`,
      tradeCount: count(),
      wins: sql<number>`SUM(CASE WHEN CAST(${schema.trades.pnl} AS REAL) > 0 THEN 1 ELSE 0 END)`,
    })
    .from(schema.trades)
    .where(and(isClosed, tradeScope(channelId)))
    .groupBy(schema.trades.trader)
    .orderBy(sql`SUM(CAST(${schema.trades.pnl} AS REAL)) DESC`);
}

async function getTradeHistorySummaryInternal(opts: {
  trader?: string;
  symbol?: string;
  strategy?: string;
  channelId?: string;
} = {}) {
  const conditions: SQL[] = [isClosed, tradeScope(opts.channelId)];
  if (opts.trader) conditions.push(forTrader(opts.trader));
  if (opts.symbol) conditions.push(forSymbol(opts.symbol));
  if (opts.strategy) conditions.push(forStrategy(opts.strategy as Strategy));

  const [result] = await db
    .select({
      totalPnl: sql<string>`COALESCE(SUM(CAST(${schema.trades.pnl} AS REAL)), 0)`,
      totalTrades: count(),
      wins: sql<number>`SUM(CASE WHEN CAST(${schema.trades.pnl} AS REAL) > 0 THEN 1 ELSE 0 END)`,
      bestTrade: sql<string>`MAX(CAST(${schema.trades.pnl} AS REAL))`,
      worstTrade: sql<string>`MIN(CAST(${schema.trades.pnl} AS REAL))`,
      totalSlippage: sql<string>`COALESCE(SUM(
        (COALESCE(json_extract(${schema.trades.metadata}, '$.entrySlippage'), 0)
         + COALESCE(json_extract(${schema.trades.metadata}, '$.exitSlippage'), 0))
        * COALESCE(${schema.trades.quantity}, 1)
        * CASE WHEN ${schema.trades.strategy} != 'STOCK' THEN 100 ELSE 1 END
      ), 0)`,
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
    totalSlippage: safeParseFloat(result?.totalSlippage),
  };
}

async function getRiskSnapshotInternal(channelId?: string) {
  const scopedChannelId = resolveChannelId(channelId);
  const [latestBalance] = await db
    .select()
    .from(schema.dailyBalances)
    .where(eq(schema.dailyBalances.channelId, scopedChannelId))
    .orderBy(desc(schema.dailyBalances.date))
    .limit(1);

  const openPositions = await db
    .select({
      symbol: schema.trades.symbol,
      count: count(),
    })
    .from(schema.trades)
    .where(and(isOpen, tradeScope(scopedChannelId)))
    .groupBy(schema.trades.symbol);

  const [totalOpen] = await db
    .select({ count: count() })
    .from(schema.trades)
    .where(and(isOpen, tradeScope(scopedChannelId)));

  const [unresolvedAlerts] = await db
    .select({ count: count() })
    .from(schema.reconciliationAlerts)
    .where(and(
      eq(schema.reconciliationAlerts.channelId, scopedChannelId),
      eq(schema.reconciliationAlerts.resolved, false),
    ));

  const [todayPnlResult] = await db
    .select({
      total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
    })
    .from(schema.trades)
    .where(and(tradeScope(scopedChannelId), sql`closed_at >= date('now')`));

  const balances = await db
    .select({ equity: schema.dailyBalances.equity })
    .from(schema.dailyBalances)
    .where(eq(schema.dailyBalances.channelId, scopedChannelId))
    .orderBy(desc(schema.dailyBalances.date))
    .limit(60);

  let peakEquity = 0;
  let currentEquity = 0;
  if (balances.length > 0) {
    currentEquity = parseFloat(balances[0].equity ?? '0');
    peakEquity = Math.max(...balances.map((b) => parseFloat(b.equity ?? '0')));
  }
  const drawdownPct = peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0;

  const [dbOnlyAlerts] = await db
    .select({ count: count() })
    .from(schema.reconciliationAlerts)
    .where(and(
      eq(schema.reconciliationAlerts.channelId, scopedChannelId),
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

async function getDailyBalancesInternal(limit = 30, channelId?: string) {
  return db
    .select()
    .from(schema.dailyBalances)
    .where(eq(schema.dailyBalances.channelId, resolveChannelId(channelId)))
    .orderBy(desc(schema.dailyBalances.date))
    .limit(limit);
}

async function getBacktestRunBrief(id: string) {
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

  const [stats] = await db
    .select({
      totalTrades: count(),
      totalPnl: sql<string>`COALESCE(SUM(CASE WHEN ${schema.trades.status} = 'CLOSED' THEN CAST(${schema.trades.pnl} AS REAL) END), 0)`,
      wins: sql<number>`SUM(CASE WHEN ${schema.trades.status} = 'CLOSED' AND CAST(${schema.trades.pnl} AS REAL) > 0 THEN 1 ELSE 0 END)`,
      closed: sql<number>`SUM(CASE WHEN ${schema.trades.status} = 'CLOSED' THEN 1 ELSE 0 END)`,
    })
    .from(schema.trades)
    .where(eq(schema.trades.channelId, btChannel(id)));

  const config = run.config;
  const closed = stats?.closed ?? 0;
  const wins = stats?.wins ?? 0;
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    traders: config.traders ?? [],
    startDate: config.startDate ? isoToDateKey(config.startDate) : '',
    endDate: config.endDate ? isoToDateKey(config.endDate) : '',
    agentModel: config.agentModel ?? 'default',
    totalPnl: safeParseFloat(stats?.totalPnl),
    winRate: closed > 0 ? wins / closed : 0,
    totalTrades: stats?.totalTrades ?? 0,
  };
}

async function getRunDecisionForTaskInternal(
  messageId: string,
  opts?: { channelId?: string; taskId?: string },
) {
  const channelId = opts?.channelId;
  const taskId = opts?.taskId;

  if (channelId) {
    const [decision] = await db
      .select()
      .from(schema.runDecisions)
      .where(
        and(
          eq(schema.runDecisions.messageId, messageId),
          eq(schema.runDecisions.channelId, channelId),
        )
      );
    return decision ?? null;
  }

  if (taskId) {
    const [decision] = await db
      .select({ rd: schema.runDecisions })
      .from(schema.runDecisions)
      .innerJoin(schema.trades, eq(schema.runDecisions.tradeId, schema.trades.id))
      .where(
        and(
          eq(schema.runDecisions.messageId, messageId),
          eq(schema.trades.taskId, taskId),
        )
      );
    return decision?.rd ?? null;
  }

  return null;
}

async function getDecisionsForTradeInternal(trade: { id: string; sourceMessageId: string | null; channelId: string }) {
  const seedConditions: SQL[] = [];
  const matchCondition = trade.sourceMessageId
    ? or(
        eq(schema.runDecisions.tradeId, trade.id),
        eq(schema.runDecisions.messageId, trade.sourceMessageId),
      )!
    : eq(schema.runDecisions.tradeId, trade.id);
  seedConditions.push(matchCondition);
  seedConditions.push(eq(schema.runDecisions.channelId, trade.channelId));

  const seedRows = await db
    .select({ messageId: schema.runDecisions.messageId })
    .from(schema.runDecisions)
    .where(and(...seedConditions));

  const allMessageIds = Array.from(new Set(seedRows.map(r => r.messageId).filter((id): id is string => id != null)));
  if (allMessageIds.length === 0) return [];

  const fullConditions: SQL[] = [
    inArray(schema.runDecisions.messageId, allMessageIds),
    eq(schema.runDecisions.channelId, trade.channelId)
  ];

  return db
    .select()
    .from(schema.runDecisions)
    .where(and(...fullConditions))
    .orderBy(asc(schema.runDecisions.createdAt));
}

async function getEnrichedMessagesInternal(opts: {
  traders: string[];
  startDate: string;
  endDate: string;
  channelId?: string;
  cursor?: string;
  limit?: number;
  roleFilter?: 'all' | 'processed' | 'executed' | 'skipped';
}) {
  const pageSize = opts.limit ?? 100;
  const resolvedChannel = resolveChannelId(opts.channelId);
  const conditions: SQL[] = [];
  if (opts.startDate) conditions.push(gte(schema.messages.timestamp, opts.startDate));
  if (opts.endDate) conditions.push(lte(schema.messages.timestamp, opts.endDate));
  if (opts.traders.length > 0) {
    conditions.push(inArray(schema.messages.author, opts.traders));
  }
  if (opts.cursor) {
    conditions.push(lt(schema.messages.timestamp, opts.cursor));
  }

  const decisionJoin = and(
    eq(schema.runDecisions.messageId, schema.messages.id),
    eq(schema.runDecisions.channelId, resolvedChannel),
  );

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
        tradeScope(opts.channelId),
      ),
    )
    .leftJoin(schema.runDecisions, decisionJoin)
    .where(and(...conditions))
    .orderBy(desc(schema.messages.timestamp))
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;
  const result = hasMore ? rows.slice(0, pageSize) : rows;

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

async function getLabelsForMessagesInternal(messageIds: string[]) {
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

async function getMessagesInternal(opts: {
  author?: string;
  authors?: string[];
  limit?: number;
  offset?: number;
  cursor?: string;
  startDate?: string;
  endDate?: string;
  signalsOnly?: boolean;
  labelFilter?: 'labeled' | 'unlabeled' | 'needs-review';
}) {
  const conditions: SQL[] = [];

  if (opts.author) conditions.push(eq(schema.messages.author, opts.author));
  if (opts.authors && opts.authors.length > 0) {
    conditions.push(inArray(schema.messages.author, opts.authors));
  }
  if (opts.cursor) {
    conditions.push(lt(schema.messages.timestamp, opts.cursor));
  }
  if (opts.startDate) {
    conditions.push(gte(schema.messages.timestamp, opts.startDate));
  }
  if (opts.endDate) {
    conditions.push(lte(schema.messages.timestamp, opts.endDate));
  }
  if (opts.signalsOnly) {
    conditions.push(
      or(
        isNotNull(schema.messages.actionHint),
        sql`json_array_length(${schema.messages.symbols}) > 0`,
        sql`json_array_length(${schema.messages.badges}) > 0`,
      )!
    );
  }

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

  if (opts.labelFilter === 'needs-review') {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${schema.messageIntents} WHERE ${schema.messageIntents.messageId} = ${schema.messages.id} AND ${schema.messageIntents.decision} = 'MANUAL_REVIEW')`,
    );

    const query = db
      .select()
      .from(schema.messages)
      .orderBy(desc(schema.messages.timestamp))
      .limit(opts.limit ?? 50)
      .offset(opts.offset ?? 0);

    return query.where(and(...conditions));
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

async function getTraderEquityCurveInternal(trader: string, channelId?: string) {
  const conditions = [
    isClosed,
    eq(schema.trades.trader, trader),
    tradeScope(channelId),
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
      date: t.closedAt ? isoToDateKey(t.closedAt) : '',
      pnl: safeParseFloat(t.pnl),
      cumPnl,
    };
  });
}

async function getTraderStrategyBreakdownInternal(trader: string, channelId?: string) {
  const conditions = [
    isClosed,
    eq(schema.trades.trader, trader),
    tradeScope(channelId),
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

// ── computeFromTrades (backtest detail) ──────────────

type TradeRow = {
  pnl: string | null;
  status: string;
  trader: string;
  strategy: string;
  closedAt: string | null;
  direction: string;
  quantity: number | null;
  legs: unknown[] | null;
  symbol: string;
  openedAt: string | null;
};

function computeFromTrades(
  allTrades: TradeRow[],
  decisions: { decision: { phase: string | null; outcome: string | null } }[],
  mtmSnapshots?: { date: string; unrealizedPnl: number }[],
  commissionSchedule?: CommissionSchedule,
) {
  const { summary: core, byTrader, byStrategy, equityCurve, sortedClosed } = computeCoreStats(allTrades, mtmSnapshots, commissionSchedule);

  const agentCallsUsed = decisions.filter((d) => d.decision.phase === 'agent').length;
  const agentTrades = decisions.filter((d) => d.decision.phase === 'agent' && d.decision.outcome === 'EXECUTE').length;
  const skipped = decisions.filter((d) => d.decision.outcome === 'SKIP').length;

  const summary = { ...core, totalMessages: 0, tradedMessages: 0, agentCallsUsed, agentTrades, skipped };

  const netPnlOf = (t: TradeRow) => safeParseFloat(t.pnl) - computeTradeCommission(t, commissionSchedule);

  const tradeScatter = sortedClosed.map((t) => ({
    date: isoToDateKey(t.closedAt ?? t.openedAt ?? ''),
    pnl: netPnlOf(t),
    strategy: t.strategy,
    direction: t.direction,
    quantity: tradeQty(t.quantity),
    symbol: t.symbol,
    trader: t.trader,
  }));

  const rollingWinRate: { tradeNum: number; date: string; winRate: number; windowSize: number }[] = [];
  if (sortedClosed.length >= 5) {
    const windowSize = Math.min(20, Math.max(5, Math.floor(sortedClosed.length / 5)));
    for (let i = windowSize - 1; i < sortedClosed.length; i++) {
      const window = sortedClosed.slice(i - windowSize + 1, i + 1);
      const windowWins = window.filter((t) => netPnlOf(t) > 0).length;
      rollingWinRate.push({
        tradeNum: i + 1,
        date: isoToDateKey(sortedClosed[i].closedAt ?? ''),
        winRate: roundCents(windowWins / windowSize),
        windowSize,
      });
    }
  }

  const strategies = Array.from(new Set(sortedClosed.map((t) => t.strategy)));
  const strategyEquity: Record<string, number | string>[] = [];
  if (strategies.length >= 2) {
    const cumByStrategy: Record<string, number> = {};
    for (const s of strategies) cumByStrategy[s] = 0;
    const dateGroups = new Map<string, TradeRow[]>();
    for (const t of sortedClosed) {
      const date = isoToDateKey(t.closedAt ?? '');
      let group = dateGroups.get(date);
      if (!group) { group = []; dateGroups.set(date, group); }
      group.push(t);
    }
    for (const [date, trades] of Array.from(dateGroups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const t of trades) cumByStrategy[t.strategy] += netPnlOf(t);
      const point: Record<string, number | string> = { date };
      for (const s of strategies) point[s] = roundCents(cumByStrategy[s]);
      strategyEquity.push(point);
    }
  }

  const hasTrades = allTrades.length > 0;
  return {
    summary: hasTrades ? summary : null,
    byTrader: Object.keys(byTrader).length > 0 ? byTrader : null,
    byStrategy: Object.keys(byStrategy).length > 0 ? byStrategy : null,
    equityCurve: equityCurve.length > 0 ? equityCurve : null,
    tradeScatter,
    rollingWinRate,
    strategyEquity,
    strategies,
  };
}

const HEALTH_STALE_MS = 60_000;

async function getRuntimeHealthInternal(channelId: string) {
  const [row] = await db
    .select()
    .from(schema.runtimeHealth)
    .where(eq(schema.runtimeHealth.channelId, channelId));

  // Fresh DB row — just return it
  if (row?.updatedAt) {
    const age = Date.now() - new Date(row.updatedAt).getTime();
    if (age < HEALTH_STALE_MS) return row;
  }

  // Stale or missing — live-probe and persist so next read is fast
  const broker = getRuntimeBrokerMap().get(channelId);
  if (!broker) return row ?? null;

  const healthy = await broker.isHealthy();
  upsertRuntimeHealth(channelId, {
    brokerHealthy: healthy,
    circuitOpen: row?.circuitOpen ?? false,
    lastError: healthy ? null : 'Broker unreachable',
  });

  // Re-read the freshly written row
  const [fresh] = await db
    .select()
    .from(schema.runtimeHealth)
    .where(eq(schema.runtimeHealth.channelId, channelId));
  return fresh ?? null;
}

export default app;
