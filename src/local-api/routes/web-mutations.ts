import { Hono } from 'hono';
import { db, schema, runTx } from '@/db/client.js';
import { eq, inArray, and, gte, lte, desc, asc } from 'drizzle-orm';
import type { CommissionSchedule, BacktestRunConfig } from '@/db/schema.js';
import { btChannel, generateRunId } from '@/lib/channel.js';
import { generateReportFromTrades } from '@/backtest/report.js';
import { DEFAULT_STARTING_EQUITY, DEFAULT_COMMISSION_SCHEDULE } from '@/config/risk-defaults.js';
import { getProvider } from '@/lib/secrets/index.js';
import { isClosed } from '@/trades/filters.js';
import { validateBody } from '../validate.js';
import {
  BacktestStartBodySchema,
  BulkIdsBodySchema,
  TraderCreateBodySchema,
  TraderPatchBodySchema,
  TradersBulkBodySchema,
  ReconciliationResolveBodySchema,
  SettingsSecretBodySchema,
  SettingsTogglesBodySchema,
  SettingsRiskBodySchema,
  EvalReviewBodySchema,
} from '../http-schemas.js';

const LOCAL_API_URL = process.env.LOCAL_API_URL ?? 'http://localhost:3791';
const DEFAULT_STRATEGIES = ['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'CCS', 'PCS'];

const app = new Hono();

// ─── Helpers (ported from web/lib/queries.ts inline) ─

async function getTradesByBacktestRun(channelId: string, opts?: { includeOpen?: boolean }) {
  const conditions = [eq(schema.trades.channelId, channelId)];
  if (!opts?.includeOpen) {
    conditions.push(isClosed);
  }
  return db
    .select()
    .from(schema.trades)
    .where(and(...conditions))
    .orderBy(desc(schema.trades.closedAt));
}

async function getRunDecisions(channelId: string) {
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
    .where(eq(schema.runDecisions.channelId, channelId))
    .orderBy(desc(schema.runDecisions.createdAt));
}

async function getMtmSnapshots(channelId: string) {
  return db
    .select({
      date: schema.backtestMtmSnapshots.date,
      unrealizedPnl: schema.backtestMtmSnapshots.unrealizedPnl,
    })
    .from(schema.backtestMtmSnapshots)
    .where(eq(schema.backtestMtmSnapshots.channelId, channelId))
    .orderBy(asc(schema.backtestMtmSnapshots.date));
}

async function deleteIntentsByMessageIds(ids: string[]) {
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await db.delete(schema.messageIntents).where(inArray(schema.messageIntents.messageId, chunk));
  }
}

// ─── Backtests ───────────────────────────────────────

app.post('/backtests/start', async (c) => {
  const body = await validateBody(BacktestStartBodySchema, c);

  const {
    startDate, endDate, traders,
    refreshQuoteCache, agentProvider, agentModel,
    logLevel = 'debug', disableRiskLimits, clearIntentCache,
    maxOnSymbol, maxTotalPositions, maxDrawdownPct, maxAgentCalls,
    startingEquity = DEFAULT_STARTING_EQUITY,
    commissionOptionPerContract, commissionStockPerShare,
  } = body;

  const commissionSchedule: CommissionSchedule = {
    option: { perContract: commissionOptionPerContract ?? DEFAULT_COMMISSION_SCHEDULE.option.perContract },
    stock: { perShare: commissionStockPerShare ?? DEFAULT_COMMISSION_SCHEDULE.stock.perShare },
  };

  // Clear cached intents if requested
  if (clearIntentCache) {
    const messages = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          inArray(schema.messages.author, traders),
          gte(schema.messages.timestamp, new Date(startDate + 'T00:00:00Z').toISOString()),
          lte(schema.messages.timestamp, new Date(endDate + 'T23:59:59Z').toISOString()),
        ),
      );
    if (messages.length > 0) {
      await deleteIntentsByMessageIds(messages.map((m) => m.id));
    }
  }

  const config: BacktestRunConfig = {
    startDate: new Date(startDate + 'T00:00:00Z').toISOString(),
    endDate: new Date(endDate + 'T23:59:59Z').toISOString(),
    traders,
    useQuoteTape: true,
    ...(agentProvider ? { agentProvider } : {}),
    ...(agentModel ? { agentModel } : {}),
    ...(refreshQuoteCache ? { refreshQuoteCache } : {}),
    ...(disableRiskLimits ? { disableRiskLimits } : {}),
    ...(maxOnSymbol != null ? { maxOnSymbol } : {}),
    ...(maxTotalPositions != null ? { maxTotalPositions } : {}),
    ...(maxDrawdownPct != null ? { maxDrawdownPct } : {}),
    ...(maxAgentCalls != null ? { maxAgentCalls } : {}),
    startingEquity,
    commissionSchedule,
  };

  const backtestRunId = generateRunId();
  await db.insert(schema.backtestRuns).values({
    id: backtestRunId,
    status: 'PENDING',
    config,
  });

  const res = await fetch(`${LOCAL_API_URL}/backtests/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId: backtestRunId,
      startDate,
      endDate,
      traders,
      useQuoteTape: true,
      ...(agentProvider ? { agentProvider } : {}),
      ...(agentModel ? { agentModel } : {}),
      ...(refreshQuoteCache ? { refreshQuoteCache } : {}),
      ...(disableRiskLimits ? { disableRiskLimits } : {}),
      ...(maxOnSymbol != null ? { maxOnSymbol } : {}),
      ...(maxTotalPositions != null ? { maxTotalPositions } : {}),
      ...(maxDrawdownPct != null ? { maxDrawdownPct } : {}),
      ...(maxAgentCalls != null ? { maxAgentCalls } : {}),
      ...(startingEquity != null ? { startingEquity } : {}),
      ...(commissionSchedule ? { commissionSchedule } : {}),
      logLevel,
    }),
  });

  if (!res.ok) {
    return c.json({ error: `Spawn failed: ${res.status} ${await res.text()}` }, 500);
  }

  const { pid } = await res.json() as { pid: number | null };
  if (pid) {
    await db.update(schema.backtestRuns)
      .set({ pid })
      .where(eq(schema.backtestRuns.id, backtestRunId));
  }

  return c.json({ id: backtestRunId });
});

app.post('/backtests/:id/cancel', async (c) => {
  const backtestRunId = c.req.param('id');

  const [run] = await db
    .select({ status: schema.backtestRuns.status, pid: schema.backtestRuns.pid })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, backtestRunId));

  if (!run || (run.status !== 'RUNNING' && run.status !== 'PENDING')) {
    return c.json({ error: 'Run not cancellable' }, 400);
  }

  const channelId = btChannel(backtestRunId);

  await db.update(schema.backtestRuns)
    .set({
      status: 'CANCELLED',
      completedAt: new Date().toISOString(),
      error: 'Cancelled by user',
    })
    .where(eq(schema.backtestRuns.id, backtestRunId));

  if (run.pid) {
    await fetch(`${LOCAL_API_URL}/backtests/${backtestRunId}/cancel`, {
      method: 'POST',
    });
  }

  // Compute partial stats from whatever trades/decisions/MTM were persisted before cancel
  const [trades, rawDecisions, mtmSnapshots] = await Promise.all([
    getTradesByBacktestRun(channelId, { includeOpen: true }),
    getRunDecisions(channelId),
    getMtmSnapshots(channelId),
  ]);

  if (trades.length > 0) {
    const decisions = rawDecisions.map((d) => ({
      phase: d.decision.phase,
      outcome: d.decision.outcome,
      inputTokens: d.decision.inputTokens,
    }));
    const [cancelledRun] = await db
      .select({ config: schema.backtestRuns.config })
      .from(schema.backtestRuns)
      .where(eq(schema.backtestRuns.id, backtestRunId));
    const cancelledConfig = cancelledRun.config;

    const report = generateReportFromTrades({
      trades: trades.map((t) => ({
        pnl: t.pnl,
        status: t.status,
        trader: t.trader,
        strategy: t.strategy,
        quantity: t.quantity,
        // SAFETY: Drizzle infers TradeLeg[] (non-nullable) via $type<>, but
        // generateReportFromTrades accepts unknown[] | null to stay decoupled
        // from the TradeLeg schema. The runtime value is the same JSON array.
        legs: t.legs as unknown[] | null,
        entryPrice: t.entryPrice,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
      })),
      decisions,
      mtmSnapshots,
      startingEquity: cancelledConfig.startingEquity,
      commissionSchedule: cancelledConfig.commissionSchedule,
    });
    await db.update(schema.backtestRuns)
      .set({
        summary: report.summary,
        byTrader: report.byTrader,
        byStrategy: report.byStrategy,
        equityCurve: report.equityCurve,
        extendedMetrics: report.extendedMetrics,
      })
      .where(eq(schema.backtestRuns.id, backtestRunId));
  }

  return c.json({ ok: true });
});

app.delete('/backtests/:id', async (c) => {
  const backtestRunId = c.req.param('id');
  const channelId = btChannel(backtestRunId);

  // Kill running process if any
  const [run] = await db
    .select({ status: schema.backtestRuns.status, pid: schema.backtestRuns.pid })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, backtestRunId));

  if (run && (run.status === 'RUNNING' || run.status === 'PENDING') && run.pid) {
    await fetch(`${LOCAL_API_URL}/backtests/${backtestRunId}/cancel`, {
      method: 'POST',
    });
  }

  runTx((tx) => {
    const tradeIds = tx
      .select({ id: schema.trades.id })
      .from(schema.trades)
      .where(eq(schema.trades.channelId, channelId))
      .all()
      .map((row) => row.id);
    tx.delete(schema.runDecisions).where(eq(schema.runDecisions.channelId, channelId)).run();
    if (tradeIds.length > 0) {
      tx.delete(schema.tradeEvents).where(inArray(schema.tradeEvents.tradeId, tradeIds)).run();
    }
    tx.delete(schema.trades).where(eq(schema.trades.channelId, channelId)).run();
    tx.delete(schema.tasks).where(eq(schema.tasks.channelId, channelId)).run();
    tx.delete(schema.backtestMtmSnapshots).where(eq(schema.backtestMtmSnapshots.channelId, channelId)).run();
    tx.delete(schema.backtestRuns).where(eq(schema.backtestRuns.id, backtestRunId)).run();
  });

  // Clean up log file
  await fetch(`${LOCAL_API_URL}/logs/${backtestRunId}`, { method: 'DELETE' }).catch(() => {});

  return c.json({ ok: true });
});

app.post('/backtests/bulk-delete', async (c) => {
  const { ids } = await validateBody(BulkIdsBodySchema, c);
  if (!ids?.length) return c.json({ ok: true });

  // Kill any running processes
  const runs = await db
    .select({ id: schema.backtestRuns.id, status: schema.backtestRuns.status, pid: schema.backtestRuns.pid })
    .from(schema.backtestRuns)
    .where(inArray(schema.backtestRuns.id, ids));

  for (const run of runs) {
    if ((run.status === 'RUNNING' || run.status === 'PENDING') && run.pid) {
      await fetch(`${LOCAL_API_URL}/backtests/${run.id}/cancel`, {
        method: 'POST',
      }).catch(() => {});
    }
  }

  const channelIds = ids.map(btChannel);
  runTx((tx) => {
    const tradeIds = tx
      .select({ id: schema.trades.id })
      .from(schema.trades)
      .where(inArray(schema.trades.channelId, channelIds))
      .all()
      .map((row) => row.id);
    tx.delete(schema.runDecisions).where(inArray(schema.runDecisions.channelId, channelIds)).run();
    if (tradeIds.length > 0) {
      tx.delete(schema.tradeEvents).where(inArray(schema.tradeEvents.tradeId, tradeIds)).run();
    }
    tx.delete(schema.trades).where(inArray(schema.trades.channelId, channelIds)).run();
    tx.delete(schema.tasks).where(inArray(schema.tasks.channelId, channelIds)).run();
    tx.delete(schema.backtestMtmSnapshots).where(inArray(schema.backtestMtmSnapshots.channelId, channelIds)).run();
    tx.delete(schema.backtestRuns).where(inArray(schema.backtestRuns.id, ids)).run();
  });

  for (const id of ids) {
    await fetch(`${LOCAL_API_URL}/logs/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  return c.json({ ok: true });
});

app.post('/backtests/:id/toggle-pin', async (c) => {
  const backtestRunId = c.req.param('id');

  const [run] = await db
    .select({ pinned: schema.backtestRuns.pinned })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, backtestRunId));

  if (!run) return c.json({ error: 'Not found' }, 404);

  await db.update(schema.backtestRuns)
    .set({ pinned: !run.pinned })
    .where(eq(schema.backtestRuns.id, backtestRunId));

  return c.json({ ok: true, pinned: !run.pinned });
});

app.post('/backtests/:id/invalidate-intents', async (c) => {
  const backtestRunId = c.req.param('id');

  const [run] = await db
    .select({ config: schema.backtestRuns.config })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, backtestRunId));

  if (!run) return c.json({ error: 'Not found' }, 404);

  const config = run.config;
  const messages = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(
      and(
        inArray(schema.messages.author, config.traders),
        gte(schema.messages.timestamp, config.startDate),
        lte(schema.messages.timestamp, config.endDate),
      ),
    );

  if (messages.length === 0) return c.json({ ok: true, deleted: 0 });

  await deleteIntentsByMessageIds(messages.map((m) => m.id));

  return c.json({ ok: true, deleted: messages.length });
});

// ─── Trades ──────────────────────────────────────────

app.post('/trades/:id/force-exit', async (c) => {
  const tradeId = c.req.param('id');

  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId));

  if (!trade || trade.status !== 'OPEN') {
    return c.json({ error: 'Trade not open' }, 400);
  }

  const legs = trade.legs;
  const closingLegs = legs.map((leg) => ({
    ...leg,
    action: leg.action === 'BUY' ? 'SELL' : 'BUY',
  }));

  const res = await fetch(`${LOCAL_API_URL}/trades/force-exit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channelId: trade.channelId,
      tradeId: trade.id,
      symbol: trade.symbol,
      trader: trade.trader,
      strategy: trade.strategy,
      direction: trade.direction,
      legs: closingLegs,
    }),
  });

  if (!res.ok) {
    return c.json({ error: `Force exit failed: ${res.status} ${await res.text()}` }, 500);
  }

  return c.json(await res.json());
});

// ─── Tasks ───────────────────────────────────────────

app.post('/tasks/:id/skip', async (c) => {
  const taskId = c.req.param('id');

  await db
    .update(schema.tasks)
    .set({
      status: 'SKIPPED',
      completedAt: new Date().toISOString(),
    })
    .where(eq(schema.tasks.id, taskId));

  return c.json({ ok: true });
});

// ─── Traders ─────────────────────────────────────────

app.post('/traders', async (c) => {
  const { name } = await validateBody(TraderCreateBodySchema, c);

  await db.insert(schema.trackedTraders).values({
    name,
    enabled: true,
    strategies: DEFAULT_STRATEGIES,
    notes: null,
  });

  return c.json({ ok: true });
});

app.delete('/traders/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  if (!name) return c.json({ error: 'Name required' }, 400);

  await db
    .delete(schema.trackedTraders)
    .where(eq(schema.trackedTraders.name, name));

  return c.json({ ok: true });
});

app.patch('/traders/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  if (!name) return c.json({ error: 'Name required' }, 400);

  const body = await validateBody(TraderPatchBodySchema, c);

  switch (body.field) {
    case 'enabled': {
      await db
        .update(schema.trackedTraders)
        .set({ enabled: body.value })
        .where(eq(schema.trackedTraders.name, name));
      break;
    }
    case 'strategies': {
      await db
        .update(schema.trackedTraders)
        .set({ strategies: body.value })
        .where(eq(schema.trackedTraders.name, name));
      break;
    }
    case 'notes': {
      await db
        .update(schema.trackedTraders)
        .set({ notes: body.value || null })
        .where(eq(schema.trackedTraders.name, name));
      break;
    }
  }

  return c.json({ ok: true });
});

app.post('/traders/bulk', async (c) => {
  const body = await validateBody(TradersBulkBodySchema, c);
  const { names } = body;

  if (!names?.length) return c.json({ ok: true });

  switch (body.action) {
    case 'add': {
      const valid = names.map((n) => n.trim()).filter(Boolean);
      if (!valid.length) return c.json({ ok: true });
      await db.insert(schema.trackedTraders).values(
        valid.map((name) => ({
          name,
          enabled: true,
          strategies: DEFAULT_STRATEGIES,
          notes: null,
        })),
      );
      break;
    }
    case 'remove': {
      await db
        .delete(schema.trackedTraders)
        .where(inArray(schema.trackedTraders.name, names));
      break;
    }
    case 'toggleStrategy': {
      const { strategy, enable } = body;
      const traders = await db
        .select()
        .from(schema.trackedTraders)
        .where(inArray(schema.trackedTraders.name, names));
      for (const trader of traders) {
        const current = trader.strategies;
        const next = enable
          ? current.includes(strategy) ? current : [...current, strategy]
          : current.filter((s) => s !== strategy);
        if (next.length !== current.length || !next.every((s) => current.includes(s))) {
          await db
            .update(schema.trackedTraders)
            .set({ strategies: next })
            .where(eq(schema.trackedTraders.name, trader.name));
        }
      }
      break;
    }
  }

  return c.json({ ok: true });
});

// ─── Reconciliation ─────────────────────────────────

app.post('/reconciliation/:id/resolve', async (c) => {
  const alertId = c.req.param('id');
  const { decision } = await validateBody(ReconciliationResolveBodySchema, c);

  const [alert] = await db
    .select()
    .from(schema.reconciliationAlerts)
    .where(eq(schema.reconciliationAlerts.id, alertId));

  if (!alert) return c.json({ error: 'Alert not found' }, 404);
  if (alert.resolved) return c.json({ error: 'Alert already resolved' }, 400);

  const now = new Date().toISOString();
  let reason: string;

  if (decision === 'broker') {
    if (alert.type === 'DB_ONLY') {
      if (!alert.tradeId) return c.json({ error: 'Alert missing tradeId' }, 400);
      const [trade] = await db
        .select()
        .from(schema.trades)
        .where(eq(schema.trades.id, alert.tradeId));
      if (!trade) return c.json({ error: 'Trade not found' }, 404);
      await db.update(schema.trades)
        .set({
          status: 'CLOSED',
          closedAt: now,
          pnl: trade.pnl ?? '0',
          metadata: { ...trade.metadata, extra: { ...trade.metadata.extra, reconciliationClose: true } },
        })
        .where(eq(schema.trades.id, alert.tradeId));
      reason = 'Accepted broker state — closed DB trade to match flat broker';
    } else if (alert.type === 'QUANTITY_MISMATCH') {
      const actual = alert.actual as { brokerQuantity?: number } | null;
      const expected = alert.expected as { trades?: string[] } | null;
      const brokerQty = actual?.brokerQuantity;
      const tradeIds = expected?.trades ?? [];
      if (brokerQty == null) return c.json({ error: 'Alert missing broker quantity' }, 400);
      if (tradeIds.length !== 1) {
        return c.json({ error: 'Cannot auto-adjust: multiple DB trades match. Resolve manually.' }, 400);
      }
      await db.update(schema.trades)
        .set({ quantity: brokerQty })
        .where(eq(schema.trades.id, tradeIds[0]));
      reason = `Accepted broker state — set DB quantity to ${brokerQty}`;
    } else {
      // BROKER_ONLY: can't synthesize a DB trade without messageId/taskId context — ack drift.
      reason = 'Accepted broker state — position acknowledged, not tracked in app DB';
    }
  } else {
    // decision === 'app' — no broker orders from UI. Record the decision and move on.
    if (alert.type === 'BROKER_ONLY') {
      reason = 'Accepted app state — untracked broker position, flatten manually';
    } else if (alert.type === 'DB_ONLY') {
      reason = 'Accepted app state — assumed broker flattened externally';
    } else {
      reason = 'Accepted app state — broker has stray units, reconcile manually';
    }
  }

  await db.update(schema.reconciliationAlerts)
    .set({ resolved: true, resolvedAt: now, resolvedReason: reason })
    .where(eq(schema.reconciliationAlerts.id, alertId));

  return c.json({ ok: true, reason });
});

// ─── Settings ────────────────────────────────────────

const TOGGLE_ENV: Record<string, string> = {
  discord: 'ALERTS_DISCORD_ENABLED',
  pushover: 'ALERTS_PUSHOVER_ENABLED',
  ingestion: 'LIVE_INGESTION_ENABLED',
};

app.post('/settings/secrets', async (c) => {
  const { key, value } = await validateBody(SettingsSecretBodySchema, c);

  try {
    const provider = getProvider();
    await provider.set(key, value);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.delete('/settings/secrets/:key', async (c) => {
  const key = decodeURIComponent(c.req.param('key'));
  if (!key) return c.json({ ok: false, error: 'Key is required' }, 400);

  try {
    const provider = getProvider();
    await provider.delete(key);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post('/settings/toggles/:id', async (c) => {
  const id = c.req.param('id');
  const key = TOGGLE_ENV[id];
  if (!key) return c.json({ ok: false, error: `Unknown toggle: ${id}` }, 400);

  const { enabled } = await validateBody(SettingsTogglesBodySchema, c);

  try {
    const provider = getProvider();
    await provider.set(key, enabled ? '1' : '0');
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post('/settings/risk', async (c) => {
  const { maxTotalPositions } = await validateBody(SettingsRiskBodySchema, c);

  try {
    const provider = getProvider();
    await provider.set('LIVE_MAX_TOTAL_POSITIONS', String(maxTotalPositions));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post('/settings/test/discord', async (c) => {
  const provider = getProvider();
  const secrets = await provider.load();
  const webhookUrl = secrets.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return c.json({ ok: false, error: 'DISCORD_WEBHOOK_URL is not set' });

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Trade Follower',
        embeds: [
          {
            title: '[INFO] Test',
            description: 'Test alert from Trade Follower web UI',
            color: 0x0099ff,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return c.json({ ok: false, error: `Discord responded ${res.status}: ${body}`.trim() });
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: String(err) });
  }
});

app.post('/settings/test/pushover', async (c) => {
  const provider = getProvider();
  const secrets = await provider.load();
  const token = secrets.PUSHOVER_APP_TOKEN;
  const user = secrets.PUSHOVER_USER_KEY;
  if (!token || !user) return c.json({ ok: false, error: 'PUSHOVER_APP_TOKEN or PUSHOVER_USER_KEY is not set' });

  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        user,
        title: 'Test',
        message: 'Test alert from Trade Follower web UI',
        priority: 2,
        retry: 60,
        expire: 600,
        sound: 'siren',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return c.json({ ok: false, error: `Pushover responded ${res.status}: ${body}`.trim() });
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: String(err) });
  }
});

// ── POST /eval/review/:id — Submit human verdict ─────────────────────────

app.post('/eval/review/:id', async (c) => {
  const id = c.req.param('id');
  const body = await validateBody(EvalReviewBodySchema, c);

  await db.update(schema.discrepancyReviews)
    .set({
      verdict: body.verdict,
      reason: body.reason ?? null,
      reviewed: true,
      reviewedAt: new Date().toISOString(),
    })
    .where(eq(schema.discrepancyReviews.id, id));

  return c.json({ ok: true });
});

// ── POST /eval/review/:id/undo — Clear human verdict ─────────────────────

app.post('/eval/review/:id/undo', async (c) => {
  const id = c.req.param('id');

  await db.update(schema.discrepancyReviews)
    .set({
      verdict: null,
      reason: null,
      reviewed: false,
      reviewedAt: null,
    })
    .where(eq(schema.discrepancyReviews.id, id));

  return c.json({ ok: true });
});

export default app;
