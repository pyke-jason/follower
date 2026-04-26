import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

vi.mock('@/db/client.js', async () => {
  const { createPgTestClient } = await import('@/test/pg-test-client.js');
  return createPgTestClient('classification_audits');
});

vi.mock('@/lib/runtime-channels.js', () => ({
  getDefaultRuntimeChannelId: () => 'ibkr:paper:test',
}));

import { db, schema } from '@/db/client.js';
import type { NewClassificationAudit } from '@/db/schema.js';
import app from './audits.js';
import { ClassificationAuditListResponseSchema } from '../http-schemas.js';

const CHANNEL = 'ibkr:paper:test';

const CREATE_CLASSIFICATION_AUDITS_SQL = sql`
  CREATE TABLE IF NOT EXISTS classification_audits (
    id text PRIMARY KEY,
    channel_id text NOT NULL,
    task_id text,
    message_id text NOT NULL,
    run_decision_id text,
    audit_kind text NOT NULL,
    severity text NOT NULL,
    status text NOT NULL DEFAULT 'open',
    confidence real NOT NULL DEFAULT 0,
    category text,
    title text NOT NULL,
    details text NOT NULL,
    findings jsonb NOT NULL DEFAULT '[]'::jsonb,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    critic jsonb,
    alert_key text,
    alert_sent_at text,
    resolved_at text,
    resolved_reason text,
    created_at text
  )
`;

const payload = {
  message: {
    id: 'msg-1',
    author: 'Trader',
    timestamp: '2026-04-26T14:00:00.000Z',
    cleanText: 'AAPL 200 calls for 1.20',
    badges: [],
    symbols: ['AAPL'],
  },
  classifier: {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    outcome: 'EXECUTE',
    reasoning: 'test',
    route: 'test route',
    signals: null,
  },
  execution: {
    runDecisionId: 'decision-1',
    tradeId: null,
    signalIndex: null,
    snapshot: null,
  },
  gate: null,
  critic: null,
};

beforeAll(async () => {
  await db.execute(CREATE_CLASSIFICATION_AUDITS_SQL);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM classification_audits`);
});

async function insertAudit(overrides: Partial<NewClassificationAudit> = {}) {
  const row = {
    id: crypto.randomUUID(),
    channelId: CHANNEL,
    messageId: 'msg-1',
    auditKind: 'postmortem' as const,
    severity: 'critical' as const,
    status: 'open' as const,
    confidence: 0.9,
    category: 'stock_options_mismatch' as const,
    title: 'Execution mismatch',
    details: 'Options text resolved as stock',
    findings: [{
      category: 'stock_options_mismatch' as const,
      severity: 'critical' as const,
      message: 'Execution mismatch',
      evidence: 'AAPL calls',
      confidence: 0.9,
    }],
    payload,
    createdAt: '2026-04-26T14:00:00.000Z',
    ...overrides,
  };
  await db.insert(schema.classificationAudits).values(row);
  return row;
}

describe('audit routes', () => {
  test('lists audit rows with Zod-validated response payload', async () => {
    await insertAudit();
    await insertAudit({ id: 'other-channel', channelId: 'ibkr:paper:other' });

    const res = await app.request(`/audits?channel=${encodeURIComponent(CHANNEL)}`);

    expect(res.status).toBe(200);
    const body = ClassificationAuditListResponseSchema.parse(await res.json());
    expect(body.total).toBe(1);
    expect(body.rows[0]?.severity).toBe('critical');
  });

  test('resolves and dismisses audit rows through validated mutation bodies', async () => {
    const audit = await insertAudit({ id: 'audit-1' });

    const res = await app.request(`/audits/${audit.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed', reason: 'false positive' }),
    });

    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.classificationAudits).where(eq(schema.classificationAudits.id, audit.id));
    expect(row?.status).toBe('dismissed');
    expect(row?.resolvedReason).toBe('false positive');
  });
});
