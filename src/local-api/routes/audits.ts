import { Hono } from 'hono';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/db/client.js';
import type { ClassificationAudit } from '@/db/schema.js';
import { getDefaultRuntimeChannelId } from '@/lib/runtime-channels.js';
import { validateBody, validateParams, validateQuery } from '../validate.js';
import {
  ClassificationAuditIdParamsSchema,
  ClassificationAuditListQuerySchema,
  ClassificationAuditListResponseSchema,
  ClassificationAuditResolveBodySchema,
  ClassificationAuditRowSchema,
  ClassificationAuditStatsSchema,
  type ClassificationAuditRow,
} from '../http-schemas.js';

const app = new Hono();

function normalizeAuditRow(row: ClassificationAudit): ClassificationAuditRow {
  return ClassificationAuditRowSchema.parse({
    ...row,
    taskId: row.taskId ?? null,
    runDecisionId: row.runDecisionId ?? null,
    category: row.category ?? null,
    critic: row.critic ?? null,
    alertKey: row.alertKey ?? null,
    alertSentAt: row.alertSentAt ?? null,
    resolvedAt: row.resolvedAt ?? null,
    resolvedReason: row.resolvedReason ?? null,
    createdAt: row.createdAt ?? new Date(0).toISOString(),
  });
}

app.get('/audits', async (c) => {
  const query = validateQuery(ClassificationAuditListQuerySchema, c);
  const channelId = query.channel ?? getDefaultRuntimeChannelId();
  const conditions = [eq(schema.classificationAudits.channelId, channelId)];

  if (query.status) {
    conditions.push(eq(schema.classificationAudits.status, query.status));
  }
  if (query.severity) {
    conditions.push(eq(schema.classificationAudits.severity, query.severity));
  }

  const where = and(...conditions);
  const [totalRow] = await db.select({ total: count() })
    .from(schema.classificationAudits)
    .where(where);

  const rows = await db.select()
    .from(schema.classificationAudits)
    .where(where)
    .orderBy(
      sql`CASE ${schema.classificationAudits.severity}
        WHEN 'critical' THEN 0
        WHEN 'warning' THEN 1
        ELSE 2
      END`,
      desc(schema.classificationAudits.createdAt),
    )
    .limit(query.limit);

  return c.json(ClassificationAuditListResponseSchema.parse({
    rows: rows.map(normalizeAuditRow),
    total: totalRow?.total ?? 0,
  }));
});

app.get('/audits/stats', async (c) => {
  const query = validateQuery(ClassificationAuditListQuerySchema, c);
  const channelId = query.channel ?? getDefaultRuntimeChannelId();

  const [totals] = await db.select({
    total: count(),
    open: sql<number>`SUM(CASE WHEN ${schema.classificationAudits.status} = 'open' THEN 1 ELSE 0 END)`,
    critical: sql<number>`SUM(CASE WHEN ${schema.classificationAudits.status} = 'open' AND ${schema.classificationAudits.severity} = 'critical' THEN 1 ELSE 0 END)`,
    warning: sql<number>`SUM(CASE WHEN ${schema.classificationAudits.status} = 'open' AND ${schema.classificationAudits.severity} = 'warning' THEN 1 ELSE 0 END)`,
  })
    .from(schema.classificationAudits)
    .where(eq(schema.classificationAudits.channelId, channelId));

  const byCategory = await db.select({
    category: schema.classificationAudits.category,
    count: count(),
  })
    .from(schema.classificationAudits)
    .where(and(
      eq(schema.classificationAudits.channelId, channelId),
      eq(schema.classificationAudits.status, 'open'),
    ))
    .groupBy(schema.classificationAudits.category);

  return c.json(ClassificationAuditStatsSchema.parse({
    total: totals?.total ?? 0,
    open: totals?.open ?? 0,
    critical: totals?.critical ?? 0,
    warning: totals?.warning ?? 0,
    byCategory: Object.fromEntries(
      byCategory
        .filter((row) => row.category)
        .map((row) => [row.category!, row.count]),
    ),
  }));
});

app.post('/audits/:id/resolve', async (c) => {
  const { id } = validateParams(ClassificationAuditIdParamsSchema, c);
  const body = await validateBody(ClassificationAuditResolveBodySchema, c);

  const [row] = await db.update(schema.classificationAudits)
    .set({
      status: body.status,
      resolvedAt: new Date().toISOString(),
      resolvedReason: body.reason ?? body.status,
    })
    .where(eq(schema.classificationAudits.id, id))
    .returning();

  if (!row) {
    return c.json({ error: 'Audit not found' }, 404);
  }

  return c.json(normalizeAuditRow(row));
});

export default app;
