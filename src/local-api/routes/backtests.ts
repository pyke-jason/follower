import { Hono } from 'hono';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { and, eq, sql } from 'drizzle-orm';
import { PROJECT_ROOT, PATHS } from '@/lib/paths.js';
import { db, schema } from '@/db/client.js';
import { sendSystemAlert } from '@/lib/alert.js';
import { assertSafeRunId } from '@/lib/channel.js';
import { validateBody, validateParams } from '../validate.js';
import { BacktestSpawnBodySchema, RunIdParamsSchema } from '../http-schemas.js';

function logPathForRun(runId: string): string {
  assertSafeRunId(runId);
  return path.join(PATHS.logs, `${runId}.log`);
}

function readLogTail(logPath: string, bytes = 2000): string {
  try {
    const stat = fs.statSync(logPath);
    const fd = fs.openSync(logPath, 'r');
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

const app = new Hono();

app.post('/spawn', async (c) => {
  const body = await validateBody(BacktestSpawnBodySchema, c);

  const { runId, resume, startDate, endDate, traders, agentProvider, agentModel, refreshQuoteCache, logLevel,
    disableRiskLimits, maxOnSymbol, maxTotalPositions, maxDrawdownPct, maxAgentCalls, startingEquity,
    commissionSchedule } = body;

  const args = [
    startDate,
    endDate,
    traders.join(','),
    ...(agentProvider ? ['--agent-provider', agentProvider] : []),
    ...(agentModel ? ['--agent-model', agentModel] : []),
    '--quote-tape',
    ...(refreshQuoteCache ? ['--refresh-quote-cache'] : []),
    ...(disableRiskLimits ? ['--disable-risk-limits'] : []),
    ...(maxOnSymbol != null ? ['--max-on-symbol', String(maxOnSymbol)] : []),
    ...(maxTotalPositions != null ? ['--max-total-positions', String(maxTotalPositions)] : []),
    ...(maxDrawdownPct != null ? ['--max-drawdown-pct', String(maxDrawdownPct)] : []),
    ...(maxAgentCalls != null ? ['--max-agent-calls', String(maxAgentCalls)] : []),
    ...(startingEquity != null ? ['--starting-equity', String(startingEquity)] : []),
    ...(commissionSchedule?.option?.perContract != null ? ['--commission-option', String(commissionSchedule.option.perContract)] : []),
    ...(commissionSchedule?.stock?.perShare != null ? ['--commission-stock', String(commissionSchedule.stock.perShare)] : []),
    '--log-level', logLevel ?? 'debug',
    '--run-id', runId,
    ...(resume ? ['--resume'] : []),
  ];

  fs.mkdirSync(PATHS.logs, { recursive: true });
  const logPath = logPathForRun(runId);
  const logFd = fs.openSync(logPath, resume ? 'a' : 'w');
  if (resume) {
    fs.writeSync(logFd, `\n\n--- resume attempt ${new Date().toISOString()} ---\n`);
  }

  const child = spawn('npx', ['tsx', 'src/backtest/launch.ts', ...args], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', logFd, logFd],
    detached: true,
    env: { ...process.env, LOG_PROCESS_NAME: 'backtest' },
  });

  const pid = child.pid ?? null;

  const [attemptRow] = await db
    .select({ maxAttempt: sql<number>`COALESCE(MAX(${schema.backtestAttempts.attempt}), 0)` })
    .from(schema.backtestAttempts)
    .where(eq(schema.backtestAttempts.runId, runId));
  const attempt = Number(attemptRow?.maxAttempt ?? 0) + 1;
  await db.insert(schema.backtestAttempts).values({
    runId,
    attempt,
    pid,
    status: 'RUNNING',
  });

  child.on('exit', async (code, signal) => {
    const tail = readLogTail(logPath);
    const exitDesc = code !== null ? `exit code ${code}` : `signal ${signal}`;

    try {
      await db.update(schema.backtestAttempts)
        .set({
          status: 'EXITED',
          completedAt: new Date().toISOString(),
          exitCode: code,
          signal,
          logTail: tail.slice(-4000),
        })
        .where(and(
          eq(schema.backtestAttempts.runId, runId),
          eq(schema.backtestAttempts.attempt, attempt),
        ));

      if (code === 0) return; // success handled by runner.ts

      const [run] = await db
        .select({ status: schema.backtestRuns.status })
        .from(schema.backtestRuns)
        .where(eq(schema.backtestRuns.id, runId));

      if (!run || (run.status !== 'PENDING' && run.status !== 'RUNNING')) return;

      const errorMsg = `Process crashed (${exitDesc}).\n${tail}`.slice(0, 4000);
      const [checkpoint] = await db
        .select({ runId: schema.backtestCheckpoints.runId })
        .from(schema.backtestCheckpoints)
        .where(eq(schema.backtestCheckpoints.runId, runId));
      const recoverable = checkpoint != null;

      await db
        .update(schema.backtestRuns)
        .set({
          status: recoverable ? 'PAUSED' : 'FAILED',
          error: recoverable
            ? `Paused after process crash. Resume will restart from the last committed checkpoint.\n${tail}`.slice(0, 4000)
            : errorMsg,
          completedAt: recoverable ? null : new Date().toISOString(),
          pid: null,
        })
        .where(eq(schema.backtestRuns.id, runId));

      await sendSystemAlert({
        severity: 'warning',
        title: 'Backtest Process Crashed',
        message: `Run \`${runId}\` died with ${exitDesc}`,
        fields: [
          { name: 'Run ID', value: runId, inline: true },
          { name: 'Exit', value: exitDesc, inline: true },
          ...(tail ? [{ name: 'Log Tail', value: '```\n' + tail.slice(-500) + '\n```' }] : []),
        ],
      });
    } catch (err) {
      console.error('[backtests/spawn] exit handler error:', err);
      sendSystemAlert({
        title: 'Backtest exit handler error',
        message: `Failed to update DB after backtest crash: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      });
    }
  });

  child.unref();
  fs.closeSync(logFd);

  return c.json({ pid });
});

app.post('/:id/cancel', async (c) => {
  const { id: runId } = validateParams(RunIdParamsSchema, c);

  const [run] = await db
    .select({ pid: schema.backtestRuns.pid, status: schema.backtestRuns.status })
    .from(schema.backtestRuns)
    .where(eq(schema.backtestRuns.id, runId));

  if (!run) {
    return c.json({ error: 'Run not found' }, 404);
  }
  if (run.status !== 'RUNNING' && run.status !== 'PENDING' && run.status !== 'PAUSED') {
    return c.json({ error: `Run ${runId} is not active` }, 400);
  }
  if (!run.pid) {
    return c.json({ killed: false, reason: 'run has no recorded pid' });
  }

  try {
    process.kill(-run.pid, 'SIGTERM');
    return c.json({ killed: true });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ESRCH') {
      return c.json({ killed: false, reason: 'process already exited' });
    }
    throw err;
  }
});

export default app;
