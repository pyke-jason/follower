import { Hono } from 'hono';
import { spawn } from 'child_process';
import { existsSync } from 'node:fs';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { PROJECT_ROOT, PATHS } from '../../lib/paths.js';
import { db, schema } from '../../db/client.js';
import { sendSystemAlert } from '../../lib/alert.js';

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

const BacktestSpawnSchema = z.object({
  runId: z.string().min(1),
  startDate: z.string(),
  endDate: z.string(),
  traders: z.array(z.string()),
  agentProvider: z.string().optional(),
  agentModel: z.string().optional(),
  refreshQuoteCache: z.boolean().optional(),
  logLevel: z.string().optional(),
  disableRiskLimits: z.boolean().optional(),
  maxOnSymbol: z.number().optional(),
  maxTotalPositions: z.number().optional(),
  maxDrawdownPct: z.number().optional(),
  maxAgentCalls: z.number().optional(),
  startingEquity: z.number().optional(),
  commissionSchedule: z.object({
    stock: z.object({ perShare: z.number() }).optional(),
    option: z.object({ perContract: z.number() }).optional(),
  }).optional(),
});

const app = new Hono();

app.post('/spawn', async (c) => {
  const body = BacktestSpawnSchema.parse(await c.req.json());

  const { runId, startDate, endDate, traders, agentProvider, agentModel, refreshQuoteCache, logLevel,
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
  ];

  fs.mkdirSync(PATHS.logs, { recursive: true });
  const logFd = fs.openSync(path.join(PATHS.logs, `${runId}.log`), 'w');

  const prodScript = path.join(PROJECT_ROOT, 'dist', 'backtest', 'launch.js');
  const useCompiled = existsSync(prodScript);

  const child = useCompiled
    ? spawn('node', [prodScript, ...args], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env: { ...process.env },
      })
    : spawn('npx', ['tsx', 'src/backtest/launch.ts', ...args], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', logFd, logFd],
        detached: true,
        env: { ...process.env },
      });

  const pid = child.pid ?? null;
  const logPath = path.join(PATHS.logs, `${runId}.log`);

  child.on('exit', async (code, signal) => {
    if (code === 0) return; // success handled by runner.ts

    const tail = readLogTail(logPath);
    const exitDesc = code !== null ? `exit code ${code}` : `signal ${signal}`;

    try {
      const [run] = await db
        .select({ status: schema.backtestRuns.status })
        .from(schema.backtestRuns)
        .where(eq(schema.backtestRuns.id, runId));

      if (!run || (run.status !== 'PENDING' && run.status !== 'RUNNING')) return;

      const errorMsg = `Process crashed (${exitDesc}).\n${tail}`.slice(0, 4000);

      await db
        .update(schema.backtestRuns)
        .set({ status: 'FAILED', error: errorMsg, completedAt: new Date().toISOString() })
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

const PidSchema = z.coerce.number().int().positive();

app.post('/:id/cancel', async (c) => {
  const pidResult = PidSchema.safeParse(c.req.query('pid'));
  if (!pidResult.success) {
    return c.json({ error: 'Invalid pid parameter' }, 400);
  }
  const pid = pidResult.data;

  try {
    process.kill(-pid, 'SIGTERM');
    return c.json({ killed: true });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ESRCH') {
      return c.json({ killed: false, reason: 'process already exited' });
    }
    throw err;
  }
});

export default app;
