import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { installProcessErrorHandlers } from '../lib/log-safety.js';
installProcessErrorHandlers();

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { eq, and, lt, inArray } from 'drizzle-orm';
import { requireLocalhost, requireXRequestedWith, rateLimiter } from './middleware.js';
import backtests from './routes/backtests.js';
import classifySpawn from './routes/classify-spawn.js';
import classifyRoutes from './routes/classify.js';
import logs from './routes/logs.js';
import { createTradesRouter } from './routes/trades.js';
import { createWebOrdersRouter } from './routes/web-orders.js';
import webQueries from './routes/web-queries.js';
import webMutations from './routes/web-mutations.js';
import evalRoutes from './routes/eval.js';
import dbBrowser from './routes/db-browser.js';
import ingestBackfill from './routes/ingest-backfill.js';
import { getRuntimeBrokerMap } from '../broker/select.js';
import { db, schema } from '../db/client.js';
import { sendSystemAlert } from '../lib/alert.js';

const channelBrokerMap = getRuntimeBrokerMap();
if (channelBrokerMap.size === 0) {
  throw new Error('No runtime broker channels configured for local API.');
}

const app = new Hono();

// Localhost origins only in global CORS — oneoption.com is NOT included here
// because it would allow that origin to reach trading/mutation endpoints.
const LOCALHOST_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
app.use('*', cors({ origin: LOCALHOST_ORIGINS }));

// app.oneoption.com only for the ingest-backfill route (chat widget sends
// captured messages here). This keeps cross-origin access away from orders/mutations.
app.use('/ingest-backfill', cors({ origin: 'https://app.oneoption.com' }));

// Reject connections from non-loopback addresses (defense-in-depth on top of
// the 127.0.0.1 bind address set in serve() below).
app.use('*', requireLocalhost());

// Browser-facing mutating routes require X-Requested-With. HTML forms cannot
// set arbitrary headers, so this defeats cross-site form-submission CSRF.
// Only applies to POST/PUT/DELETE/PATCH — GETs are read-only.
app.use('/web/*', async (c, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.req.method)) {
    return requireXRequestedWith()(c, next);
  }
  return next();
});

// Throttle order placement and force-exits to prevent runaway broker calls.
app.use('/web/orders/*', rateLimiter(10));
app.use('/web/trades/*', rateLimiter(5));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('[local-api] Unhandled error:', err);
  const message = err instanceof Error ? err.message : 'Internal error';
  return c.json({ error: message }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.route('/backtests', backtests);
app.route('/classify', classifySpawn);
app.route('/logs', logs);
app.route('/trades', createTradesRouter(channelBrokerMap));
app.route('/ingest-backfill', ingestBackfill);

app.route('/web', webQueries);
app.route('/web', webMutations);
app.route('/web', createWebOrdersRouter(channelBrokerMap));
app.route('/web', classifyRoutes);
app.route('/web', evalRoutes);
app.route('/web', dbBrowser);

app.get('/health', (c) => c.json({ ok: true }));

// ─── Static SPA Serving ─────────────────────────────

app.use('/assets/*', serveStatic({ root: 'web/dist' }));
app.use('/favicon.ico', serveStatic({ root: 'web/dist' }));

// SPA fallback: any GET not matching API routes serves index.html
app.get('*', serveStatic({ root: 'web/dist', path: 'index.html' }));

// ─── Stale Run Sweeper ───────────────────────────────

async function sweepStaleRuns() {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const staleRuns = await db
      .select({ id: schema.backtestRuns.id, pid: schema.backtestRuns.pid, status: schema.backtestRuns.status })
      .from(schema.backtestRuns)
      .where(
        and(
          inArray(schema.backtestRuns.status, ['PENDING', 'RUNNING', 'PAUSED']),
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

      const [checkpoint] = await db
        .select({ runId: schema.backtestCheckpoints.runId })
        .from(schema.backtestCheckpoints)
        .where(eq(schema.backtestCheckpoints.runId, run.id));

      if (checkpoint && run.status === 'PAUSED') {
        continue;
      }

      const recoverable = checkpoint != null;
      await db
        .update(schema.backtestRuns)
        .set({
          status: recoverable ? 'PAUSED' : 'FAILED',
          error: recoverable
            ? 'Paused after process died. Resume will restart from the last committed checkpoint.'
            : 'Process died without reporting status (detected by stale-run sweeper)',
          completedAt: recoverable ? null : new Date().toISOString(),
          pid: null,
        })
        .where(
          and(
            eq(schema.backtestRuns.id, run.id),
            inArray(schema.backtestRuns.status, ['PENDING', 'RUNNING', 'PAUSED']),
          ),
        );

      await sendSystemAlert({
        severity: 'warning',
        title: recoverable ? 'Recoverable Backtest Paused' : 'Stale Backtest Detected',
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

    const staleClassifyRuns = await db
      .select({ id: schema.classifyRuns.id, pid: schema.classifyRuns.pid, status: schema.classifyRuns.status })
      .from(schema.classifyRuns)
      .where(
        and(
          inArray(schema.classifyRuns.status, ['PENDING', 'RUNNING']),
          lt(schema.classifyRuns.createdAt, cutoff),
        ),
      );

    for (const run of staleClassifyRuns) {
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
        .update(schema.classifyRuns)
        .set({
          status: 'FAILED',
          error: 'Process died without reporting status (detected by stale-run sweeper)',
          completedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.classifyRuns.id, run.id),
            inArray(schema.classifyRuns.status, ['PENDING', 'RUNNING']),
          ),
        );

      await sendSystemAlert({
        severity: 'warning',
        title: 'Stale Classify Run Detected',
        message: `Run \`${run.id}\` was stuck in ${run.status} with a dead process (PID ${run.pid ?? 'unknown'})`,
        fields: [
          { name: 'Run ID', value: run.id, inline: true },
          { name: 'PID', value: String(run.pid ?? 'none'), inline: true },
        ],
      });
    }

    if (staleClassifyRuns.length > 0) {
      console.log(`[sweeper] Checked ${staleClassifyRuns.length} stale classify run(s)`);
    }
  } catch (err) {
    console.error('[sweeper] Error during stale run sweep:', err);
  }
}

setInterval(sweepStaleRuns, 10 * 60 * 1000);
setTimeout(sweepStaleRuns, 30_000);

// ─── Start Server ────────────────────────────────────

const port = parseInt(process.env.LOCAL_API_PORT ?? '3791');
console.log(`[local-api] Listening on http://127.0.0.1:${port}`);
// hostname: '127.0.0.1' binds to loopback only — never 0.0.0.0 (all interfaces).
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
