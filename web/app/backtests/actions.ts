'use server';

import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { spawn } from 'child_process';
import path from 'path';
import type { BacktestRunConfig } from '../../../src/db/schema';

export async function startBacktest(formData: FormData) {
  const startDate = formData.get('startDate') as string;
  const endDate = formData.get('endDate') as string;
  const tradersRaw = formData.get('traders') as string;
  const useAgent = formData.get('useAgent') === 'on';
  const useQuoteTape = formData.get('useQuoteTape') === 'on';
  const maxAgentCalls = parseInt(formData.get('maxAgentCalls') as string) || 100;
  const slippagePct = parseFloat(formData.get('slippagePct') as string) || 0.01;

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
  };

  const runId = crypto.randomUUID();
  await db.insert(schema.backtestRuns).values({
    id: runId,
    status: 'PENDING',
    config,
  });

  // Spawn the backtest as a child process to avoid webpack bundling issues.
  // The CLI entry point creates the run row itself, but we already created it above,
  // so we use a small inline script that calls runBacktest directly.
  const projectRoot = path.resolve(process.cwd(), '..');
  const args = [
    startDate,
    endDate,
    traders.join(','),
    ...(useAgent ? ['--agent', '--max-agent-calls', String(maxAgentCalls)] : []),
    '--slippage', String(slippagePct),
    ...(useQuoteTape ? ['--quote-tape'] : []),
    '--run-id', runId,
  ];

  const child = spawn('npx', ['tsx', 'src/backtest/launch.ts', ...args], {
    cwd: projectRoot,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env },
  });
  child.unref();

  redirect('/backtests');
}

export async function deleteBacktestRun(formData: FormData) {
  const runId = formData.get('runId') as string;
  if (!runId) return;

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

  revalidatePath('/backtests');
}
