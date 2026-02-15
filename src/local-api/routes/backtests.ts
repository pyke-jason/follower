import { Hono } from 'hono';
import { spawn } from 'child_process';
import { existsSync } from 'node:fs';
import fs from 'fs';
import path from 'path';
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

const app = new Hono();

app.post('/spawn', async (c) => {
  const body = await c.req.json<{
    runId: string;
    startDate: string;
    endDate: string;
    traders: string[];
    useAgent?: boolean;
    maxAgentCalls?: number;
    slippagePct?: number;
    useQuoteTape?: boolean;
    agentProvider?: string;
    agentModel?: string;
  }>();

  const { runId, startDate, endDate, traders, useAgent, maxAgentCalls, slippagePct, useQuoteTape, agentProvider, agentModel } = body;

  const args = [
    startDate,
    endDate,
    traders.join(','),
    ...(useAgent ? ['--agent', '--max-agent-calls', String(maxAgentCalls ?? 100)] : []),
    ...(useAgent && agentProvider ? ['--agent-provider', agentProvider] : []),
    ...(useAgent && agentModel ? ['--agent-model', agentModel] : []),
    '--slippage', String(slippagePct ?? 0.01),
    ...(useQuoteTape ? ['--quote-tape'] : []),
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
    }
  });

  child.unref();
  fs.closeSync(logFd);

  return c.json({ pid });
});

app.post('/:id/cancel', async (c) => {
  const pid = parseInt(c.req.query('pid') ?? '');
  if (!pid || isNaN(pid)) {
    return c.json({ error: 'Missing or invalid pid query parameter' }, 400);
  }

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
