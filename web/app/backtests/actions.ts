'use server';

import { db, schema } from '@/lib/db';
import { eq, inArray, and, gte, lte, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTradesByBacktestRun, getRunDecisions, getEnrichedMessages, getMtmSnapshots, getMessagesByIds, getLatestIntents, getLabelsForMessages } from '@/lib/queries';
import { generateReportFromTrades } from '../../../src/backtest/report';
import type { BacktestRunConfig } from '../../../src/db/schema';

const LOCAL_API_URL = process.env.LOCAL_API_URL ?? 'http://localhost:4000';

export async function startBacktest(formData: FormData) {
  const startDate = formData.get('startDate') as string;
  const endDate = formData.get('endDate') as string;
  const tradersRaw = formData.get('traders') as string;
  const refreshQuoteCache = formData.get('refreshQuoteCache') === 'on';
  const agentProvider = (formData.get('agentProvider') as string) || undefined;
  const agentModel = (formData.get('agentModel') as string) || undefined;
  const logLevel = (formData.get('logLevel') as string) || 'debug';
  const disableRiskLimits = formData.get('disableRiskLimits') === 'on';
  const clearIntentCache = formData.get('clearIntentCache') === 'on';
  const maxOnSymbol = formData.get('maxOnSymbol') ? Number(formData.get('maxOnSymbol')) : undefined;
  const maxTotalPositions = formData.get('maxTotalPositions') ? Number(formData.get('maxTotalPositions')) : undefined;
  const maxDrawdownPct = formData.get('maxDrawdownPct') ? Number(formData.get('maxDrawdownPct')) : undefined;
  const maxAgentCalls = formData.get('maxAgentCalls') ? Number(formData.get('maxAgentCalls')) : undefined;
  const startingEquity = formData.get('startingEquity') ? Number(formData.get('startingEquity')) : undefined;

  if (!startDate || !endDate || !tradersRaw) {
    throw new Error('Missing required fields');
  }

  const traders = tradersRaw.split(',').map((t) => t.trim()).filter(Boolean);
  if (traders.length === 0) {
    throw new Error('At least one trader is required');
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
    ...(startingEquity != null ? { startingEquity } : {}),
  };

  // Clear cached intents for matching messages if requested
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
      const CHUNK = 500;
      const ids = messages.map((m) => m.id);
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        await db.delete(schema.messageIntents).where(inArray(schema.messageIntents.messageId, chunk));
      }
    }
  }

  const runId = crypto.randomUUID();
  await db.insert(schema.backtestRuns).values({
    id: runId,
    status: 'PENDING',
    config,
  });

  const res = await fetch(`${LOCAL_API_URL}/backtests/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId,
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
      logLevel,
    }),
  });

  if (!res.ok) {
    throw new Error(`Local API error: ${res.status} ${await res.text()}`);
  }

  const { pid } = await res.json() as { pid: number | null };

  if (pid) {
    await db.update(schema.backtestRuns)
      .set({ pid })
      .where(eq(schema.backtestRuns.id, runId));
  }

  redirect(`/backtests/${runId}`);
}

export async function cancelBacktestRun(formData: FormData) {
  const runId = formData.get('runId') as string;
  if (!runId) return;

  const [run] = await db
    .select({ status: schema.backtestRuns.status, pid: schema.backtestRuns.pid })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, runId));

  if (!run || (run.status !== 'RUNNING' && run.status !== 'PENDING')) return;

  await db.update(schema.backtestRuns)
    .set({
      status: 'CANCELLED',
      completedAt: new Date().toISOString(),
      error: 'Cancelled by user',
    })
    .where(eq(schema.backtestRuns.id, runId));

  if (run.pid) {
    await fetch(`${LOCAL_API_URL}/backtests/${runId}/cancel?pid=${run.pid}`, {
      method: 'POST',
    });
  }

  // Compute partial stats from whatever trades/decisions/MTM were persisted before cancel
  const [trades, rawDecisions, mtmSnapshots] = await Promise.all([
    getTradesByBacktestRun(runId, { includeOpen: true }),
    getRunDecisions(runId),
    getMtmSnapshots(runId),
  ]);

  if (trades.length > 0) {
    const decisions = rawDecisions.map((d) => ({
      path: d.decision.path,
      decision: d.decision.decision,
    }));
    const report = generateReportFromTrades({
      trades: trades.map((t) => ({
        pnl: t.pnl,
        status: t.status,
        trader: t.trader,
        strategy: t.strategy,
        entryPrice: t.entryPrice,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
      })),
      decisions,
      mtmSnapshots,
    });
    await db.update(schema.backtestRuns)
      .set({
        summary: report.summary,
        byTrader: report.byTrader,
        byStrategy: report.byStrategy,
        equityCurve: report.equityCurve,
        extendedMetrics: report.extendedMetrics,
      })
      .where(eq(schema.backtestRuns.id, runId));
  }

  revalidatePath('/backtests');
}

export async function deleteBacktestRun(formData: FormData) {
  const runId = formData.get('runId') as string;
  if (!runId) return;

  // Kill running process if any
  const [run] = await db
    .select({ status: schema.backtestRuns.status, pid: schema.backtestRuns.pid })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, runId));

  if (run && (run.status === 'RUNNING' || run.status === 'PENDING') && run.pid) {
    await fetch(`${LOCAL_API_URL}/backtests/${runId}/cancel?pid=${run.pid}`, {
      method: 'POST',
    });
  }

  // Delete associated trades and tasks first
  const tasks = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.backtestRunId, runId));

  for (const task of tasks) {
    await db.delete(schema.taskSteps).where(eq(schema.taskSteps.taskId, task.id));
  }

  await db.delete(schema.trades).where(eq(schema.trades.backtestRunId, runId));
  await db.delete(schema.tasks).where(eq(schema.tasks.backtestRunId, runId));
  await db.delete(schema.backtestMtmSnapshots).where(eq(schema.backtestMtmSnapshots.backtestRunId, runId));
  await db.delete(schema.backtestRuns).where(eq(schema.backtestRuns.id, runId));

  // Clean up log file via local API
  await fetch(`${LOCAL_API_URL}/logs/${runId}`, { method: 'DELETE' }).catch(() => {});

  revalidatePath('/backtests');
}

export async function togglePin(formData: FormData) {
  const runId = formData.get('runId') as string;
  if (!runId) return;

  const [run] = await db
    .select({ pinned: schema.backtestRuns.pinned })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, runId));

  if (!run) return;

  await db.update(schema.backtestRuns)
    .set({ pinned: !run.pinned })
    .where(eq(schema.backtestRuns.id, runId));

  revalidatePath('/backtests');
}

export async function bulkDeleteBacktestRuns(runIds: string[]) {
  if (runIds.length === 0) return;

  const LOCAL_API_URL_INNER = process.env.LOCAL_API_URL ?? 'http://localhost:4000';

  // Kill any running processes
  const runs = await db
    .select({ id: schema.backtestRuns.id, status: schema.backtestRuns.status, pid: schema.backtestRuns.pid })
    .from(schema.backtestRuns)
    .where(inArray(schema.backtestRuns.id, runIds));

  for (const run of runs) {
    if ((run.status === 'RUNNING' || run.status === 'PENDING') && run.pid) {
      await fetch(`${LOCAL_API_URL_INNER}/backtests/${run.id}/cancel?pid=${run.pid}`, {
        method: 'POST',
      }).catch(() => {});
    }
  }

  // Delete associated tasks/steps
  const tasks = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(inArray(schema.tasks.backtestRunId, runIds));

  if (tasks.length > 0) {
    await db.delete(schema.taskSteps).where(inArray(schema.taskSteps.taskId, tasks.map((t) => t.id)));
  }

  await db.delete(schema.trades).where(inArray(schema.trades.backtestRunId, runIds));
  await db.delete(schema.tasks).where(inArray(schema.tasks.backtestRunId, runIds));
  await db.delete(schema.backtestMtmSnapshots).where(inArray(schema.backtestMtmSnapshots.backtestRunId, runIds));
  await db.delete(schema.backtestRuns).where(inArray(schema.backtestRuns.id, runIds));

  // Clean up log files
  for (const id of runIds) {
    await fetch(`${LOCAL_API_URL_INNER}/logs/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  revalidatePath('/backtests');
}

export async function fetchEnrichedMessages(
  traders: string[],
  startDate: string,
  endDate: string,
  cursor?: string,
  runId?: string,
  roleFilter?: 'all' | 'executed' | 'skipped',
) {
  return getEnrichedMessages({ traders, startDate, endDate, cursor, runId, roleFilter });
}

export async function invalidateIntentCache(formData: FormData) {
  const runId = formData.get('runId') as string;
  if (!runId) return;

  const [run] = await db
    .select({ config: schema.backtestRuns.config })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, runId));

  if (!run) return;

  const config = run.config as BacktestRunConfig;

  // Find message IDs that fall within this backtest's scope
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

  if (messages.length === 0) return;

  // Delete in chunks (SQLite variable limit)
  const CHUNK = 500;
  const ids = messages.map((m) => m.id);
  let deleted = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const result = await db
      .delete(schema.messageIntents)
      .where(inArray(schema.messageIntents.messageId, chunk));
    deleted += chunk.length;
  }

  revalidatePath(`/backtests/${runId}`);
}

/** Fetch only the messages directly linked to a trade (open, close, add/trim children). */
export async function fetchTradeLinkedMessages(tradeId: string) {
  // Get the trade + any child trades (ADDs/TRIMs)
  const [trades, children] = await Promise.all([
    db.select().from(schema.trades).where(eq(schema.trades.id, tradeId)),
    db.select().from(schema.trades).where(eq(schema.trades.parentTradeId, tradeId)),
  ]);
  const allTrades = [...trades, ...children];

  // Collect unique message IDs
  const msgIds = new Set<string>();
  for (const t of allTrades) {
    if (t.sourceMessageId) msgIds.add(t.sourceMessageId);
    if (t.closeMessageId) msgIds.add(t.closeMessageId);
  }
  if (msgIds.size === 0) return { messages: [], intents: {}, labels: {} };

  const ids = [...msgIds];
  const [messages, intents, labels] = await Promise.all([
    getMessagesByIds(ids),
    getLatestIntents(ids),
    getLabelsForMessages(ids),
  ]);
  return { messages, intents, labels };
}
