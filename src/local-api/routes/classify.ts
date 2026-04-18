import { Hono } from 'hono';
import { db, schema, runTx } from '@/db/client.js';
import { eq, inArray, and, desc } from 'drizzle-orm';
import type { ClassifyRunConfig } from '@/db/schema.js';
import { clsChannel, generateRunId } from '@/lib/channel.js';
import { validateBody } from '../validate.js';
import { ClassifyStartBodySchema, BulkIdsBodySchema } from '../http-schemas.js';

const LOCAL_API_URL = process.env.LOCAL_API_URL ?? 'http://localhost:3791';

const app = new Hono();

// ─── POST /classify/start ────────────────────────────

app.post('/classify/start', async (c) => {
  const body = await validateBody(ClassifyStartBodySchema, c);

  const { startDate, endDate, traders, agentProvider, agentModel, concurrency, name, experimentTag } = body;

  const config: ClassifyRunConfig = {
    startDate: new Date(startDate + 'T00:00:00Z').toISOString(),
    endDate: new Date(endDate + 'T23:59:59Z').toISOString(),
    traders,
    ...(agentProvider ? { agentProvider } : {}),
    ...(agentModel ? { agentModel } : {}),
    ...(concurrency != null ? { concurrency } : {}),
  };

  const runId = generateRunId();
  await db.insert(schema.classifyRuns).values({
    id: runId,
    status: 'PENDING',
    config,
    name: name ?? null,
    experimentTag: experimentTag ?? null,
  });

  const res = await fetch(`${LOCAL_API_URL}/classify/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });

  if (!res.ok) {
    return c.json({ error: `Spawn failed: ${res.status} ${await res.text()}` }, 500);
  }

  const { pid } = await res.json() as { pid: number | null };
  if (pid) {
    await db.update(schema.classifyRuns)
      .set({ pid })
      .where(eq(schema.classifyRuns.id, runId));
  }

  return c.json({ id: runId });
});

// ─── GET /classify ───────────────────────────────────

app.get('/classify', async (c) => {
  const runs = await db
    .select()
    .from(schema.classifyRuns)
    .orderBy(desc(schema.classifyRuns.createdAt))
    .limit(50);
  return c.json(runs);
});

// ─── GET /classify/:id ───────────────────────────────

app.get('/classify/:id', async (c) => {
  const id = c.req.param('id');

  const [run] = await db
    .select()
    .from(schema.classifyRuns)
    .where(eq(schema.classifyRuns.id, id));
  if (!run) return c.json({ error: 'Classify run not found' }, 404);

  const channelId = clsChannel(id);
  const decisions = await db
    .select({
      decision: schema.runDecisions,
      message: schema.messages,
    })
    .from(schema.runDecisions)
    .innerJoin(schema.messages, eq(schema.runDecisions.messageId, schema.messages.id))
    .where(and(
      eq(schema.runDecisions.channelId, channelId),
      eq(schema.runDecisions.event, 'SETTLED'),
    ))
    .orderBy(desc(schema.runDecisions.createdAt));

  // Join eval_labels for every message in this run (denormalized to avoid N+1 on the client).
  const messageIds = Array.from(new Set(
    decisions.map((d) => d.decision.messageId).filter((x): x is string => !!x),
  ));
  const labelRows = messageIds.length === 0
    ? []
    : await db
      .select({
        messageId: schema.evalLabels.messageId,
        label: schema.evalLabels.label,
        humanLabel: schema.evalLabels.humanLabel,
        humanVerified: schema.evalLabels.humanVerified,
        rejectionReason: schema.evalLabels.rejectionReason,
      })
      .from(schema.evalLabels)
      .where(inArray(schema.evalLabels.messageId, messageIds));

  const labelsByMessageId: Record<string, typeof labelRows[number]> = {};
  for (const r of labelRows) labelsByMessageId[r.messageId] = r;

  return c.json({ run, decisions, labelsByMessageId });
});

// ─── POST /classify/:id/cancel ───────────────────────

app.post('/classify/:id/cancel', async (c) => {
  const runId = c.req.param('id');

  const [run] = await db
    .select({ status: schema.classifyRuns.status, pid: schema.classifyRuns.pid })
    .from(schema.classifyRuns)
    .where(eq(schema.classifyRuns.id, runId));

  if (!run || (run.status !== 'RUNNING' && run.status !== 'PENDING')) {
    return c.json({ error: 'Run not cancellable' }, 400);
  }

  await db.update(schema.classifyRuns)
    .set({
      status: 'CANCELLED',
      completedAt: new Date().toISOString(),
      error: 'Cancelled by user',
    })
    .where(eq(schema.classifyRuns.id, runId));

  if (run.pid) {
    await fetch(`${LOCAL_API_URL}/classify/${runId}/cancel`, {
      method: 'POST',
    }).catch(() => {});
  }

  return c.json({ ok: true });
});

// ─── DELETE /classify/:id ────────────────────────────

app.delete('/classify/:id', async (c) => {
  const runId = c.req.param('id');
  const channelId = clsChannel(runId);

  const [run] = await db
    .select({ status: schema.classifyRuns.status, pid: schema.classifyRuns.pid })
    .from(schema.classifyRuns)
    .where(eq(schema.classifyRuns.id, runId));

  if (run && (run.status === 'RUNNING' || run.status === 'PENDING') && run.pid) {
    await fetch(`${LOCAL_API_URL}/classify/${runId}/cancel`, {
      method: 'POST',
    }).catch(() => {});
  }

  runTx((tx) => {
    tx.delete(schema.runDecisions).where(eq(schema.runDecisions.channelId, channelId)).run();
    tx.delete(schema.classifyRuns).where(eq(schema.classifyRuns.id, runId)).run();
  });

  await fetch(`${LOCAL_API_URL}/logs/${runId}`, { method: 'DELETE' }).catch(() => {});

  return c.json({ ok: true });
});

// ─── POST /classify/bulk-delete ──────────────────────

app.post('/classify/bulk-delete', async (c) => {
  const { ids } = await validateBody(BulkIdsBodySchema, c);
  if (!ids?.length) return c.json({ ok: true });

  const runs = await db
    .select({ id: schema.classifyRuns.id, status: schema.classifyRuns.status, pid: schema.classifyRuns.pid })
    .from(schema.classifyRuns)
    .where(inArray(schema.classifyRuns.id, ids));

  for (const run of runs) {
    if ((run.status === 'RUNNING' || run.status === 'PENDING') && run.pid) {
      await fetch(`${LOCAL_API_URL}/classify/${run.id}/cancel`, {
        method: 'POST',
      }).catch(() => {});
    }
  }

  const channelIds = ids.map(clsChannel);
  runTx((tx) => {
    tx.delete(schema.runDecisions).where(inArray(schema.runDecisions.channelId, channelIds)).run();
    tx.delete(schema.classifyRuns).where(inArray(schema.classifyRuns.id, ids)).run();
  });

  for (const id of ids) {
    await fetch(`${LOCAL_API_URL}/logs/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  return c.json({ ok: true });
});

export default app;
