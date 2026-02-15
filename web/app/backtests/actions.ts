'use server';

import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { BacktestRunConfig } from '../../../src/db/schema';

const LOCAL_API_URL = process.env.LOCAL_API_URL ?? 'http://localhost:4000';

export async function startBacktest(formData: FormData) {
  const startDate = formData.get('startDate') as string;
  const endDate = formData.get('endDate') as string;
  const tradersRaw = formData.get('traders') as string;
  const useAgent = formData.get('useAgent') === 'on';
  const useQuoteTape = formData.get('useQuoteTape') === 'on';
  const maxAgentCalls = parseInt(formData.get('maxAgentCalls') as string) || 100;
  const slippagePct = parseFloat(formData.get('slippagePct') as string) || 0.01;
  const agentProvider = (formData.get('agentProvider') as string) || undefined;
  const agentModel = (formData.get('agentModel') as string) || undefined;

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
    useAgent,
    maxAgentCalls,
    slippagePct,
    useQuoteTape,
    ...(useAgent && agentProvider ? { agentProvider } : {}),
    ...(useAgent && agentModel ? { agentModel } : {}),
  };

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
      useAgent,
      maxAgentCalls,
      slippagePct,
      useQuoteTape,
      ...(useAgent && agentProvider ? { agentProvider } : {}),
      ...(useAgent && agentModel ? { agentModel } : {}),
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

  redirect('/backtests');
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
  await db.delete(schema.backtestRuns).where(eq(schema.backtestRuns.id, runId));

  // Clean up log file via local API
  await fetch(`${LOCAL_API_URL}/logs/${runId}`, { method: 'DELETE' }).catch(() => {});

  revalidatePath('/backtests');
}
