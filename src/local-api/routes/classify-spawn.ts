import { Hono } from 'hono';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { PROJECT_ROOT, PATHS } from '@/lib/paths.js';
import { db, schema } from '@/db/client.js';
import { sendSystemAlert } from '@/lib/alert.js';
import { assertSafeRunId } from '@/lib/channel.js';
import { validateBody, validateParams } from '../validate.js';
import { ClassifySpawnBodySchema, RunIdParamsSchema } from '../http-schemas.js';

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
  const { runId } = await validateBody(ClassifySpawnBodySchema, c);

  fs.mkdirSync(PATHS.logs, { recursive: true });
  const logPath = logPathForRun(runId);
  const logFd = fs.openSync(logPath, 'w');

  const child = spawn('npx', ['tsx', 'src/classify/launch.ts', runId], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', logFd, logFd],
    detached: true,
    env: { ...process.env },
  });

  const pid = child.pid ?? null;

  child.on('exit', async (code, signal) => {
    if (code === 0) return; // success handled by runner.ts

    const tail = readLogTail(logPath);
    const exitDesc = code !== null ? `exit code ${code}` : `signal ${signal}`;

    try {
      const [run] = await db
        .select({ status: schema.classifyRuns.status })
        .from(schema.classifyRuns)
        .where(eq(schema.classifyRuns.id, runId));

      if (!run || (run.status !== 'PENDING' && run.status !== 'RUNNING')) return;

      const errorMsg = `Process crashed (${exitDesc}).\n${tail}`.slice(0, 4000);

      await db
        .update(schema.classifyRuns)
        .set({ status: 'FAILED', error: errorMsg, completedAt: new Date().toISOString() })
        .where(eq(schema.classifyRuns.id, runId));

      await sendSystemAlert({
        severity: 'warning',
        title: 'Classify Process Crashed',
        message: `Run \`${runId}\` died with ${exitDesc}`,
        fields: [
          { name: 'Run ID', value: runId, inline: true },
          { name: 'Exit', value: exitDesc, inline: true },
          ...(tail ? [{ name: 'Log Tail', value: '```\n' + tail.slice(-500) + '\n```' }] : []),
        ],
      });
    } catch (err) {
      console.error('[classify/spawn] exit handler error:', err);
      sendSystemAlert({
        title: 'Classify exit handler error',
        message: `Failed to update DB after classify crash: ${err instanceof Error ? err.message : String(err)}`,
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
    .select({ pid: schema.classifyRuns.pid, status: schema.classifyRuns.status })
    .from(schema.classifyRuns)
    .where(eq(schema.classifyRuns.id, runId));

  if (!run) {
    return c.json({ error: 'Run not found' }, 404);
  }
  if (run.status !== 'RUNNING' && run.status !== 'PENDING') {
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
