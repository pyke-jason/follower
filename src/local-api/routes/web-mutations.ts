import { Hono } from 'hono';
import { db, schema, runTx } from '@/db/client.js';
import { eq, inArray, and, gte, lte, desc, asc } from 'drizzle-orm';
import type { CommissionSchedule, BacktestRunConfig, Signal } from '@/db/schema.js';
import { btChannel, generateRunId } from '@/lib/channel.js';
import { generateReportFromTrades } from '@/backtest/report.js';
import { DEFAULT_STARTING_EQUITY, DEFAULT_COMMISSION_SCHEDULE } from '@/config/risk-defaults.js';
import { getProvider, SECRET_KEYS } from '@/lib/secrets/index.js';
import { isClosed } from '@/trades/filters.js';

const LOCAL_API_URL = process.env.LOCAL_API_URL ?? 'http://localhost:3791';
const DEFAULT_STRATEGIES = ['CDS', 'PDS', 'CALL', 'PUT', 'STOCK'];

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
  const body = await c.req.json<{
    startDate: string;
    endDate: string;
    traders: string[];
    refreshQuoteCache?: boolean;
    agentProvider?: string;
    agentModel?: string;
    logLevel?: string;
    disableRiskLimits?: boolean;
    clearIntentCache?: boolean;
    maxOnSymbol?: number;
    maxTotalPositions?: number;
    maxDrawdownPct?: number;
    maxAgentCalls?: number;
    startingEquity?: number;
    commissionOptionPerContract?: number;
    commissionStockPerShare?: number;
  }>();

  const {
    startDate, endDate, traders,
    refreshQuoteCache, agentProvider, agentModel,
    logLevel = 'debug', disableRiskLimits, clearIntentCache,
    maxOnSymbol, maxTotalPositions, maxDrawdownPct, maxAgentCalls,
    startingEquity = DEFAULT_STARTING_EQUITY,
    commissionOptionPerContract, commissionStockPerShare,
  } = body;

  if (!startDate || !endDate || !traders?.length) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

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
  const { ids } = await c.req.json<{ ids: string[] }>();
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
  const { name } = await c.req.json<{ name: string }>();
  if (!name?.trim()) return c.json({ error: 'Name required' }, 400);

  await db.insert(schema.trackedTraders).values({
    name: name.trim(),
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

  const body = await c.req.json<{
    field: 'enabled' | 'strategies' | 'notes' | 'riskPercent';
    value: boolean | string[] | string | number | null;
  }>();

  switch (body.field) {
    case 'enabled': {
      await db
        .update(schema.trackedTraders)
        .set({ enabled: body.value as boolean })
        .where(eq(schema.trackedTraders.name, name));
      break;
    }
    case 'strategies': {
      await db
        .update(schema.trackedTraders)
        .set({ strategies: body.value as string[] })
        .where(eq(schema.trackedTraders.name, name));
      break;
    }
    case 'notes': {
      await db
        .update(schema.trackedTraders)
        .set({ notes: (body.value as string | null) || null })
        .where(eq(schema.trackedTraders.name, name));
      break;
    }
    case 'riskPercent': {
      const riskPercent = body.value as number | null;
      if (riskPercent == null) {
        await db
          .update(schema.trackedTraders)
          .set({ positionSizingConfig: null })
          .where(eq(schema.trackedTraders.name, name));
      } else {
        const [trader] = await db
          .select({ positionSizingConfig: schema.trackedTraders.positionSizingConfig })
          .from(schema.trackedTraders)
          .where(eq(schema.trackedTraders.name, name));
        const existing = trader?.positionSizingConfig;
        const config: import('../../position-sizing/index.js').AtrSizingConfig = {
          strategy: 'atr',
          riskPercent,
          atrMultiplier: (existing?.strategy === 'atr' ? existing.atrMultiplier : 2.0),
          atrPeriod: existing?.strategy === 'atr' ? existing.atrPeriod : 14,
        };
        await db
          .update(schema.trackedTraders)
          .set({ positionSizingConfig: config })
          .where(eq(schema.trackedTraders.name, name));
      }
      break;
    }
    default:
      return c.json({ error: `Unknown field: ${body.field}` }, 400);
  }

  return c.json({ ok: true });
});

app.post('/traders/bulk', async (c) => {
  const body = await c.req.json<{
    action: 'add' | 'remove' | 'toggleStrategy';
    names: string[];
    strategy?: string;
    enable?: boolean;
  }>();

  const { action, names } = body;
  if (!names?.length) return c.json({ ok: true });

  switch (action) {
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
      if (!strategy || enable == null) return c.json({ error: 'strategy and enable required' }, 400);
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
    default:
      return c.json({ error: `Unknown action: ${action}` }, 400);
  }

  return c.json({ ok: true });
});

// ─── Messages (Labels) ──────────────────────────────

app.post('/messages/:id/label', async (c) => {
  const messageId = c.req.param('id');
  const { signals, source = 'manual' } = await c.req.json<{
    signals: Signal[];
    source?: string;
  }>();

  const data = {
    signals,
    source,
    reviewed: true as const,
    updatedAt: new Date().toISOString(),
  };

  await db
    .insert(schema.messageLabels)
    .values({ ...data, messageId })
    .onConflictDoUpdate({
      target: schema.messageLabels.messageId,
      set: data,
    });

  return c.json({ ok: true });
});

// ─── Reconciliation ─────────────────────────────────

app.post('/reconciliation/:id/resolve', async (c) => {
  const alertId = c.req.param('id');
  const { reason } = await c.req.json<{ reason: string }>();

  if (!reason) return c.json({ error: 'Reason required' }, 400);

  await db.update(schema.reconciliationAlerts)
    .set({
      resolved: true,
      resolvedAt: new Date().toISOString(),
      resolvedReason: reason,
    })
    .where(eq(schema.reconciliationAlerts.id, alertId));

  return c.json({ ok: true });
});

// ─── Settings ────────────────────────────────────────

const TOGGLE_ENV: Record<string, string> = {
  discord: 'ALERTS_DISCORD_ENABLED',
  pushover: 'ALERTS_PUSHOVER_ENABLED',
  ingestion: 'LIVE_INGESTION_ENABLED',
};

app.post('/settings/secrets', async (c) => {
  const { key, value } = await c.req.json<{ key: string; value: string }>();
  if (!key || !value) return c.json({ ok: false, error: 'Key and value are required' }, 400);

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

  const { enabled } = await c.req.json<{ enabled: boolean }>();

  try {
    const provider = getProvider();
    await provider.set(key, enabled ? '1' : '0');
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
  const body = await c.req.json<{ verdict: string; reason?: string }>();

  if (!['parser_right', 'label_right', 'both_wrong', 'skip'].includes(body.verdict)) {
    return c.json({ error: 'Invalid verdict' }, 400);
  }

  await db.update(schema.discrepancyReviews)
    .set({
      verdict: body.verdict as 'parser_right' | 'label_right' | 'both_wrong' | 'skip',
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
