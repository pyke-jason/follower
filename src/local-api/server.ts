import { loadSecrets } from '../lib/secrets/index.js';
await loadSecrets();

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { eq, and, lt, inArray } from 'drizzle-orm';
import backtests from './routes/backtests.js';
import logs from './routes/logs.js';
import { createTradesRouter } from './routes/trades.js';
import webQueries from './routes/web-queries.js';
import webMutations from './routes/web-mutations.js';
import evalRoutes from './routes/eval.js';
import dbBrowser from './routes/db-browser.js';
import { getRuntimeBrokerMap } from '../broker/select.js';
import { db, schema } from '../db/client.js';
import { sendSystemAlert } from '../lib/alert.js';

const channelBrokerMap = getRuntimeBrokerMap();
if (channelBrokerMap.size === 0) {
  throw new Error('No runtime broker channels configured for local API.');
}

const app = new Hono();

app.use('*', cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173', 'https://app.oneoption.com'] }));

app.route('/backtests', backtests);
app.route('/logs', logs);
app.route('/trades', createTradesRouter(channelBrokerMap));

app.route('/web', webQueries);
app.route('/web', webMutations);
app.route('/web', evalRoutes);
app.route('/web', dbBrowser);

app.get('/health', (c) => c.json({ ok: true }));

// ─── Temporary Backfill Endpoint ─────────────────────
// Accepts messages from the OneOption chat API and inserts them into the DB.
// Used by the MCP Playwright session to backfill data.
import { classifyMessage } from '../parsing/classify.js';
import { normalizeForDedup, computeContentHash } from '../ingestion/dedup.js';
import { compactReactions, type SignalRMessage } from '../ingestion/signalr.js';

app.post('/ingest-backfill', async (c) => {
  const body = await c.req.json() as { messages: Array<{ Id: number | string; Author: string; TimeUtc: string; Message: string; Tag?: number | string; Votes?: number; Reactions?: Array<{ Type: string; Count: number }> }> };
  if (!body.messages || !Array.isArray(body.messages)) {
    return c.json({ error: 'expected { messages: [...] }' }, 400);
  }

  let saved = 0;
  for (const apiMsg of body.messages) {
    const id = String(apiMsg.Id);
    const classification = classifyMessage(apiMsg.Message || '');
    const normalizedText = normalizeForDedup(classification.cleanText);
    const contentHash = computeContentHash(normalizedText);
    const reactions = (apiMsg.Reactions || []).filter((r: { Type: string; Count: number }) => r.Type && r.Count > 0).map((r: { Type: string; Count: number }) => ({ Type: r.Type, Count: r.Count }));

    try {
      await db.insert(schema.messages).values({
        id,
        author: apiMsg.Author,
        timestamp: apiMsg.TimeUtc || new Date().toISOString(),
        rawHtml: apiMsg.Message || '',
        cleanText: classification.cleanText,
        badges: classification.badges,
        symbols: classification.symbols,
        actionHint: classification.actionHint ?? null,
        directionHint: classification.directionHint ?? null,
        detectedStrategies: classification.detectedStrategies,
        isPaperTrade: classification.isPaperTrade,
        confidence: String(classification.confidence),
        contentHash,
        reactions,
      }).onConflictDoNothing();
      saved++;
    } catch {
      // Skip duplicates / errors
    }
  }

  return c.json({ received: body.messages.length, saved });
});

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

const port = parseInt(process.env.LOCAL_API_PORT ?? '3791');
console.log(`[local-api] Listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
