import { Hono } from 'hono';
import { db, schema } from '@/db/client.js';
import { getEvalSummary } from '@/eval/eval.js';
import { eq, and, desc, asc, count, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { validateBody, validateQuery } from '../validate.js';
import {
  EvalLabelReviewBodySchema,
  EvalLabelRejectBodySchema,
  EvalLabelsListQuerySchema,
} from '../http-schemas.js';

const app = new Hono();

// ── GET /eval/labels — List eval labels with filtering ─────────────────

app.get('/eval/labels', async (c) => {
  const { version, source, verified, confidence, isTrade, limit, offset, sort } =
    validateQuery(EvalLabelsListQuerySchema, c);

  const conditions: SQL[] = [];
  if (version !== undefined) conditions.push(eq(schema.evalLabels.version, version));
  if (source) conditions.push(eq(schema.evalLabels.source, source));
  if (verified !== undefined) conditions.push(eq(schema.evalLabels.humanVerified, verified));
  if (confidence) {
    conditions.push(sql`json_extract(${schema.evalLabels.label}, '$.confidence') = ${confidence}`);
  }
  if (isTrade !== undefined) {
    conditions.push(sql`json_extract(${schema.evalLabels.label}, '$.isTrade') = ${isTrade}`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const orderFn = sort === 'asc' ? asc : desc;

  // Join with messages to get author, timestamp, cleanText, badges, symbols
  const rows = await db
    .select({
      id: schema.evalLabels.id,
      messageId: schema.evalLabels.messageId,
      label: schema.evalLabels.label,
      source: schema.evalLabels.source,
      model: schema.evalLabels.model,
      version: schema.evalLabels.version,
      humanVerified: schema.evalLabels.humanVerified,
      humanLabel: schema.evalLabels.humanLabel,
      rejectionReason: schema.evalLabels.rejectionReason,
      feedback: schema.evalLabels.feedback,
      reviewedAt: schema.evalLabels.reviewedAt,
      createdAt: schema.evalLabels.createdAt,
      // Message fields
      author: schema.messages.author,
      timestamp: schema.messages.timestamp,
      cleanText: schema.messages.cleanText,
      badges: schema.messages.badges,
      symbols: schema.messages.symbols,
    })
    .from(schema.evalLabels)
    .innerJoin(schema.messages, eq(schema.evalLabels.messageId, schema.messages.id))
    .where(where)
    .orderBy(orderFn(schema.messages.timestamp))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db.select({ total: count() })
    .from(schema.evalLabels)
    .where(where);

  // Stats
  const [stats] = await db.select({
    total: count(),
    verified: sql<number>`SUM(CASE WHEN human_verified = 1 THEN 1 ELSE 0 END)`,
    lowConfidence: sql<number>`SUM(CASE WHEN json_extract(label, '$.confidence') = 'LOW' THEN 1 ELSE 0 END)`,
    agentSource: sql<number>`SUM(CASE WHEN source = 'agent' THEN 1 ELSE 0 END)`,
    humanSource: sql<number>`SUM(CASE WHEN source = 'human' THEN 1 ELSE 0 END)`,
  }).from(schema.evalLabels);

  return c.json({
    rows,
    total,
    stats: {
      total: stats.total,
      verified: Number(stats.verified ?? 0),
      lowConfidence: Number(stats.lowConfidence ?? 0),
      bySource: {
        agent: Number(stats.agentSource ?? 0),
        human: Number(stats.humanSource ?? 0),
      },
    },
  });
});

// ── GET /eval/labels/:id — Single label detail ─────────────────────────

app.get('/eval/labels/:id', async (c) => {
  const id = c.req.param('id');

  const [row] = await db
    .select({
      id: schema.evalLabels.id,
      messageId: schema.evalLabels.messageId,
      label: schema.evalLabels.label,
      source: schema.evalLabels.source,
      model: schema.evalLabels.model,
      version: schema.evalLabels.version,
      humanVerified: schema.evalLabels.humanVerified,
      humanLabel: schema.evalLabels.humanLabel,
      rejectionReason: schema.evalLabels.rejectionReason,
      feedback: schema.evalLabels.feedback,
      reviewedAt: schema.evalLabels.reviewedAt,
      durationMs: schema.evalLabels.durationMs,
      inputTokens: schema.evalLabels.inputTokens,
      outputTokens: schema.evalLabels.outputTokens,
      createdAt: schema.evalLabels.createdAt,
      author: schema.messages.author,
      timestamp: schema.messages.timestamp,
      cleanText: schema.messages.cleanText,
      badges: schema.messages.badges,
      symbols: schema.messages.symbols,
    })
    .from(schema.evalLabels)
    .innerJoin(schema.messages, eq(schema.evalLabels.messageId, schema.messages.id))
    .where(eq(schema.evalLabels.id, id));

  if (!row) return c.json({ error: 'Label not found' }, 404);
  return c.json(row);
});

// ── GET /eval/labels/:id/context — Chat context ────────────────────────

app.get('/eval/labels/:id/context', async (c) => {
  const id = c.req.param('id');

  // Get the eval label to find the messageId
  const [label] = await db.select({ messageId: schema.evalLabels.messageId })
    .from(schema.evalLabels)
    .where(eq(schema.evalLabels.id, id));
  if (!label) return c.json({ error: 'Label not found' }, 404);

  // Get the target message
  const [msg] = await db.select().from(schema.messages)
    .where(eq(schema.messages.id, label.messageId));
  if (!msg) return c.json({ error: 'Message not found' }, 404);

  // Surrounding messages from same author within ±4 hours
  const surrounding = await db.select({
    id: schema.messages.id,
    author: schema.messages.author,
    cleanText: schema.messages.cleanText,
    badges: schema.messages.badges,
    symbols: schema.messages.symbols,
    timestamp: schema.messages.timestamp,
  }).from(schema.messages)
    .where(and(
      eq(schema.messages.author, msg.author),
      sql`${schema.messages.timestamp} >= ${new Date(new Date(msg.timestamp).getTime() - 4 * 60 * 60 * 1000).toISOString()}`,
      sql`${schema.messages.timestamp} <= ${new Date(new Date(msg.timestamp).getTime() + 1 * 60 * 60 * 1000).toISOString()}`,
    ))
    .orderBy(asc(schema.messages.timestamp))
    .limit(30);

  return c.json({
    target: label.messageId,
    author: msg.author,
    messages: surrounding,
  });
});

// ── POST /eval/labels/:id/review — Human review submission ─────────────

app.post('/eval/labels/:id/review', async (c) => {
  const id = c.req.param('id');
  const { humanLabel } = await validateBody(EvalLabelReviewBodySchema, c);

  await db.update(schema.evalLabels)
    .set({
      humanVerified: true,
      humanLabel,
      reviewedAt: new Date().toISOString(),
    })
    .where(eq(schema.evalLabels.id, id));

  return c.json({ ok: true });
});

// ── POST /eval/labels/:id/approve — Quick approve ──────────────────────

app.post('/eval/labels/:id/approve', async (c) => {
  const id = c.req.param('id');

  await db.update(schema.evalLabels)
    .set({
      humanVerified: true,
      humanLabel: null,
      rejectionReason: null,
      feedback: null,
      reviewedAt: new Date().toISOString(),
    })
    .where(eq(schema.evalLabels.id, id));

  return c.json({ ok: true });
});

// ── POST /eval/labels/:id/reject — Reject with reason + optional feedback ──

app.post('/eval/labels/:id/reject', async (c) => {
  const id = c.req.param('id');
  const body = await validateBody(EvalLabelRejectBodySchema, c);

  await db.update(schema.evalLabels)
    .set({
      humanVerified: true,
      humanLabel: null,
      rejectionReason: body.reason,
      feedback: body.feedback || null,
      reviewedAt: new Date().toISOString(),
    })
    .where(eq(schema.evalLabels.id, id));

  return c.json({ ok: true });
});

// ── POST /eval/labels/:id/undo — Undo a review ────────────────────────

app.post('/eval/labels/:id/undo', async (c) => {
  const id = c.req.param('id');

  await db.update(schema.evalLabels)
    .set({
      humanVerified: false,
      humanLabel: null,
      rejectionReason: null,
      feedback: null,
      reviewedAt: null,
    })
    .where(eq(schema.evalLabels.id, id));

  return c.json({ ok: true });
});

// ── GET /eval/metrics — Computed eval summary ───────────────────────────

app.get('/eval/metrics', async (c) => {
  const summary = await getEvalSummary();

  return c.json({
    totalLabels: summary.totalLabels,
    humanVerified: summary.humanVerified,
    goldenDatasetSize: summary.humanVerified,
    bySource: summary.bySource,
    lowConfidence: summary.lowConfidence,
    metrics: summary.metrics,
  });
});

export default app;
