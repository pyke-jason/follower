/**
 * TDD tests for task factory safety gates.
 *
 * Current code (factory.ts:15) rejects badge-less messages entirely:
 *   if (badges.length === 0) return null;
 *
 * The FIX will change this to:
 *   if (badges.length === 0 && symbols.length === 0) return null;
 * AND: badge-less messages with symbols always route to REVIEW_MESSAGE.
 *
 * Tests marked "FAILS currently" will fail until the fix is applied.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';

// In-memory SQLite
vi.mock('../db/client.js', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const schema = await import('../db/schema.js');
  const client = createClient({ url: ':memory:' });
  const db = drizzle({ client, schema });
  return { db, schema, sqliteClient: client };
});

// Mock isTrackedTrader to always return true
vi.mock('../config/traders.js', () => ({
  isTrackedTrader: async () => true,
  getTrackedTraders: async () => new Map(),
  getTrader: async () => undefined,
}));

import { db, schema } from '../db/client.js';
import { createTaskFromMessage } from './factory.js';
import type { Message } from '../db/schema.js';

// ── DB setup ──────────────────────────────────────────────────────

const CREATE_MESSAGES_SQL = sql`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    raw_html TEXT NOT NULL,
    clean_text TEXT NOT NULL,
    badges TEXT DEFAULT '[]',
    symbols TEXT DEFAULT '[]',
    action_hint TEXT,
    direction_hint TEXT,
    detected_strategies TEXT DEFAULT '[]',
    is_paper_trade INTEGER DEFAULT 0,
    confidence TEXT,
    ingested_at TEXT
  )
`;

const CREATE_TASKS_SQL = sql`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    assignee TEXT NOT NULL DEFAULT 'agent',
    priority INTEGER DEFAULT 0,
    context TEXT DEFAULT '{}',
    result TEXT,
    created_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    model_provider TEXT,
    model_name TEXT,
    backtest_run_id TEXT
  )
`;

// Unique index on message_id WHERE message_id IS NOT NULL (mirrors schema.ts:73)
const CREATE_TASKS_UNIQUE_IDX = sql`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_message_unique
  ON tasks(message_id) WHERE message_id IS NOT NULL
`;

beforeAll(async () => {
  await db.run(CREATE_MESSAGES_SQL);
  await db.run(CREATE_TASKS_SQL);
  await db.run(CREATE_TASKS_UNIQUE_IDX);
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM tasks`);
  await db.run(sql`DELETE FROM messages`);
});

// ── Helpers ───────────────────────────────────────────────────────

function makeMessage(overrides: Partial<Message> = {}): Message {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    author: 'alice',
    timestamp: '2026-01-15T14:30:00Z',
    rawHtml: '<p>Buy AAPL</p>',
    cleanText: 'Buy AAPL',
    badges: ['opening'],
    symbols: ['AAPL'],
    actionHint: 'OPEN',
    directionHint: 'LONG',
    detectedStrategies: [],
    isPaperTrade: false,
    confidence: '0.85',
    ingestedAt: '2026-01-15T14:30:05Z',
    ...overrides,
  };
}

async function insertMessage(overrides: Partial<Message> = {}): Promise<Message> {
  const msg = makeMessage(overrides);
  await db.insert(schema.messages).values(msg);
  return msg;
}

// ── Tests ─────────────────────────────────────────────────────────

describe('createTaskFromMessage', () => {
  test('badge-less with symbols creates REVIEW_MESSAGE task (FAILS currently - returns null)', async () => {
    const msg = await insertMessage({
      badges: [],
      symbols: ['AAPL'],
      confidence: '0.95',
    });

    const taskId = await createTaskFromMessage(msg);

    // Current code returns null because badges.length === 0.
    // After fix, it should create a REVIEW_MESSAGE task.
    expect(taskId).not.toBeNull();

    const [task] = await db.select().from(schema.tasks);
    expect(task.taskType).toBe('REVIEW_MESSAGE');
    expect(task.messageId).toBe(msg.id);
  });

  test('badge-less without symbols returns null', async () => {
    const msg = await insertMessage({
      badges: [],
      symbols: [],
      confidence: '0.85',
    });

    const taskId = await createTaskFromMessage(msg);
    expect(taskId).toBeNull();
  });

  test('with badges + high confidence creates EXECUTE_TRADE', async () => {
    const msg = await insertMessage({
      badges: ['opening'],
      symbols: ['AAPL'],
      confidence: '0.85',
    });

    const taskId = await createTaskFromMessage(msg);
    expect(taskId).not.toBeNull();

    const [task] = await db.select().from(schema.tasks);
    expect(task.taskType).toBe('EXECUTE_TRADE');
  });

  test('with badges + low confidence creates REVIEW_MESSAGE', async () => {
    const msg = await insertMessage({
      badges: ['opening'],
      symbols: ['AAPL'],
      confidence: '0.50',
    });

    const taskId = await createTaskFromMessage(msg);
    expect(taskId).not.toBeNull();

    const [task] = await db.select().from(schema.tasks);
    expect(task.taskType).toBe('REVIEW_MESSAGE');
  });

  test('paper trade returns null', async () => {
    const msg = await insertMessage({
      badges: ['opening'],
      symbols: ['AAPL'],
      confidence: '0.85',
      isPaperTrade: true,
    });

    const taskId = await createTaskFromMessage(msg);
    expect(taskId).toBeNull();
  });

  test('badge-less with symbols + high confidence still routes to REVIEW_MESSAGE (safety gate) (FAILS currently)', async () => {
    // Even with confidence >= 0.7, badge-less messages must go to REVIEW_MESSAGE
    // because there's no badge to confirm the trade action.
    const msg = await insertMessage({
      badges: [],
      symbols: ['AAPL'],
      confidence: '0.95',
    });

    const taskId = await createTaskFromMessage(msg);

    // After fix, this should create a task...
    expect(taskId).not.toBeNull();

    // ...but always REVIEW_MESSAGE, never EXECUTE_TRADE
    const [task] = await db.select().from(schema.tasks);
    expect(task.taskType).toBe('REVIEW_MESSAGE');
  });

  test('duplicate message does not create second task', async () => {
    const msg = await insertMessage({
      badges: ['opening'],
      symbols: ['AAPL'],
      confidence: '0.85',
    });

    const taskId1 = await createTaskFromMessage(msg);
    const taskId2 = await createTaskFromMessage(msg);

    expect(taskId1).not.toBeNull();
    expect(taskId2).toBeNull(); // unique constraint prevents duplicate

    const tasks = await db.select().from(schema.tasks);
    expect(tasks).toHaveLength(1);
  });
});
