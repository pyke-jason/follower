import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { eq, and, lt, inArray } from 'drizzle-orm';
import backtests from './routes/backtests.js';
import logs from './routes/logs.js';
import trades from './routes/trades.js';
import { db, schema } from '../db/client.js';
import { sendSystemAlert } from '../lib/alert.js';

const app = new Hono();

app.use('*', cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));

app.route('/backtests', backtests);
app.route('/logs', logs);
app.route('/trades', trades);

app.get('/health', (c) => c.json({ ok: true }));

// ─── Stale Run Sweeper ───────────────────────────────

async function sweepStaleRuns() {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const staleRuns = await db
      .select({ id: schema.backtestRuns.id, pid: schema.backtestRuns.pid, status: schema.backtestRuns.status })
      .from(schema.backtestRuns)
      .where(
        and(
          inArray(schema.backtestRuns.status, ['PENDING', 'RUNNING']),
          lt(schema.backtestRuns.createdAt, cutoff),
        ),
      );

    for (const run of staleRuns) {
      // Check if process is still alive
      if (run.pid) {
        try {
          process.kill(run.pid, 0);
          continue; // process still running — skip
        } catch {
          // process is dead — fall through to mark as failed
        }
      }

      await db
        .update(schema.backtestRuns)
        .set({
          status: 'FAILED',
          error: 'Process died without reporting status (detected by stale-run sweeper)',
          completedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.backtestRuns.id, run.id),
            inArray(schema.backtestRuns.status, ['PENDING', 'RUNNING']),
          ),
        );

      await sendSystemAlert({
        severity: 'warning',
        title: 'Stale Backtest Detected',
        message: `Run \`${run.id}\` was stuck in ${run.status} with a dead process (PID ${run.pid ?? 'unknown'})`,
        fields: [
          { name: 'Run ID', value: run.id, inline: true },
          { name: 'PID', value: String(run.pid ?? 'none'), inline: true },
        ],
      });
    }

    if (staleRuns.length > 0) {
      console.log(`[sweeper] Checked ${staleRuns.length} stale run(s)`);
    }
  } catch (err) {
    console.error('[sweeper] Error during stale run sweep:', err);
  }
}

setInterval(sweepStaleRuns, 10 * 60 * 1000);
setTimeout(sweepStaleRuns, 30_000);

// ─── Start Server ────────────────────────────────────

const port = parseInt(process.env.LOCAL_API_PORT ?? '4000');
console.log(`[local-api] Listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
