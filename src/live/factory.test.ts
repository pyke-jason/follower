/**
 * Tests for task factory safety gates.
 *
 * factory.ts accepts messages with badges OR symbols.
 * Badge-less messages with symbols always route to REVIEW_MESSAGE (safety gate).
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';

// In-memory SQLite
vi.mock('../db/client.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('../db/schema.js');
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  return {
    db, schema, sqliteClient: sqlite,
    runTx: (cb: any) => db.transaction(cb),
    withBusyRetry: (fn: any) => fn(),
  };
});

// Mock isTrackedTrader to always return true
vi.mock('../config/traders.js', () => ({
  isTrackedTrader: async () => true,
  getTrackedTraders: async () => new Map(),
  getTrader: async () => undefined,
}));

import { db, schema } from '../db/client.js';
import { createTaskFromMessage } from './factory.js';
import { CREATE_MESSAGES_SQL, CREATE_TASKS_SQL, CREATE_TASKS_UNIQUE_IDX } from '../backtest/test-fixtures.js';
import type { Message } from '../db/schema.js';

const CHANNEL_ID = 'ibkr:paper:test-account';

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
    contentHash: null,
    reactions: [],
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
  test('badge-less with symbols creates REVIEW_MESSAGE task', async () => {
    const msg = await insertMessage({
      badges: [],
      symbols: ['AAPL'],
      confidence: '0.95',
    });

    const taskId = await createTaskFromMessage(msg, CHANNEL_ID);

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

    const taskId = await createTaskFromMessage(msg, CHANNEL_ID);
    expect(taskId).toBeNull();
  });

  test('with badges + high confidence creates EXECUTE_TRADE', async () => {
    const msg = await insertMessage({
      badges: ['opening'],
      symbols: ['AAPL'],
      confidence: '0.85',
    });

    const taskId = await createTaskFromMessage(msg, CHANNEL_ID);
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

    const taskId = await createTaskFromMessage(msg, CHANNEL_ID);
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

    const taskId = await createTaskFromMessage(msg, CHANNEL_ID);
    expect(taskId).toBeNull();
  });

  test('badge-less with symbols + high confidence still routes to REVIEW_MESSAGE (safety gate)', async () => {
    // Even with confidence >= 0.7, badge-less messages must go to REVIEW_MESSAGE
    // because there's no badge to confirm the trade action.
    const msg = await insertMessage({
      badges: [],
      symbols: ['AAPL'],
      confidence: '0.95',
    });

    const taskId = await createTaskFromMessage(msg, CHANNEL_ID);

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

    const taskId1 = await createTaskFromMessage(msg, CHANNEL_ID);
    const taskId2 = await createTaskFromMessage(msg, CHANNEL_ID);

    expect(taskId1).not.toBeNull();
    expect(taskId2).toBeNull(); // unique constraint prevents duplicate

    const tasks = await db.select().from(schema.tasks);
    expect(tasks).toHaveLength(1);
  });
});
