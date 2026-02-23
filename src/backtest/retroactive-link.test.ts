/**
 * Tests for retroactive closeMessageId linking.
 *
 * When a backtest CLOSE signal doesn't execute (position already closed by
 * sim-broker), retroactiveLinkCloseMessage finds the most recently closed
 * trade matching the signal and stamps its closeMessageId.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';

// In-memory SQLite for isolated DB tests.
vi.mock('../db/client.js', async () => {
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const schema = await import('../db/schema.js');
  const client = createClient({ url: ':memory:' });
  const db = drizzle({ client, schema });
  return { db, schema, sqliteClient: client };
});

import { db, schema } from '../db/client.js';
import { CREATE_TRADES_SQL, CREATE_TRADE_EVENTS_SQL } from './test-fixtures.js';
import { retroactiveLinkCloseMessage } from './retroactive-link.js';

beforeAll(async () => {
  await db.run(CREATE_TRADES_SQL);
  await db.run(CREATE_TRADE_EVENTS_SQL);
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM trade_events`);
  await db.run(sql`DELETE FROM trades`);
});

// ── Helpers ───────────────────────────────────────────────────────

async function insertClosedTrade(opts: {
  id?: string;
  symbol?: string;
  trader?: string;
  runId?: string;
  closedAt?: string;
  closeMessageId?: string | null;
}): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  await db.insert(schema.trades).values({
    id,
    trader: opts.trader ?? 'alice',
    symbol: opts.symbol ?? 'AAPL',
    direction: 'LONG',
    strategy: 'STOCK',
    legs: [{ symbol: opts.symbol ?? 'AAPL', strike: 0, expiry: '2026-12-31', type: 'STOCK', action: 'BUY', quantity: 1 }],
    status: 'CLOSED',
    entryPrice: '150.00',
    exitPrice: '155.00',
    quantity: 1,
    pnl: '5.00',
    isBacktest: true,
    backtestRunId: opts.runId ?? 'run-1',
    openedAt: '2026-01-01T10:00:00Z',
    closedAt: opts.closedAt ?? '2026-01-02T10:00:00Z',
    closeMessageId: opts.closeMessageId ?? null,
  });
  return id;
}

function failedCloseSignal(symbol: string) {
  return { executed: false, signal: { action: 'CLOSE', symbol } };
}

function executedCloseSignal(symbol: string) {
  return { executed: true, orderId: 'order-1', signal: { action: 'CLOSE', symbol } };
}

function pendingCloseSignal(symbol: string) {
  return { executed: false, orderId: 'pending-1', signal: { action: 'CLOSE', symbol } };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('retroactiveLinkCloseMessage', () => {
  test('happy path: links failed CLOSE signal to matching closed trade', async () => {
    const tradeId = await insertClosedTrade({ symbol: 'AAPL', trader: 'alice', runId: 'run-1' });

    const results = [failedCloseSignal('AAPL')];
    const linked = await retroactiveLinkCloseMessage(results, 'msg-close-1', 'alice', 'run-1', db, schema);

    expect(linked).toEqual([tradeId]);

    // Verify DB was updated
    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, tradeId));
    expect(trade.closeMessageId).toBe('msg-close-1');
  });

  test('no match: wrong symbol', async () => {
    await insertClosedTrade({ symbol: 'AAPL', trader: 'alice', runId: 'run-1' });

    const results = [failedCloseSignal('TSLA')];
    const linked = await retroactiveLinkCloseMessage(results, 'msg-1', 'alice', 'run-1', db, schema);

    expect(linked).toEqual([]);
  });

  test('no match: wrong trader', async () => {
    await insertClosedTrade({ symbol: 'AAPL', trader: 'alice', runId: 'run-1' });

    const results = [failedCloseSignal('AAPL')];
    const linked = await retroactiveLinkCloseMessage(results, 'msg-1', 'bob', 'run-1', db, schema);

    expect(linked).toEqual([]);
  });

  test('no match: wrong run', async () => {
    await insertClosedTrade({ symbol: 'AAPL', trader: 'alice', runId: 'run-1' });

    const results = [failedCloseSignal('AAPL')];
    const linked = await retroactiveLinkCloseMessage(results, 'msg-1', 'alice', 'run-2', db, schema);

    expect(linked).toEqual([]);
  });

  test('already linked: trade with existing closeMessageId is NOT overwritten', async () => {
    const tradeId = await insertClosedTrade({
      symbol: 'AAPL',
      trader: 'alice',
      runId: 'run-1',
      closeMessageId: 'existing-msg',
    });

    const results = [failedCloseSignal('AAPL')];
    const linked = await retroactiveLinkCloseMessage(results, 'new-msg', 'alice', 'run-1', db, schema);

    expect(linked).toEqual([]);

    // Original closeMessageId preserved
    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, tradeId));
    expect(trade.closeMessageId).toBe('existing-msg');
  });

  test('most recent wins: links to the trade with the latest closedAt', async () => {
    const olderId = await insertClosedTrade({
      symbol: 'AAPL',
      trader: 'alice',
      runId: 'run-1',
      closedAt: '2026-01-01T10:00:00Z',
    });
    const newerId = await insertClosedTrade({
      symbol: 'AAPL',
      trader: 'alice',
      runId: 'run-1',
      closedAt: '2026-01-02T15:00:00Z',
    });

    const results = [failedCloseSignal('AAPL')];
    const linked = await retroactiveLinkCloseMessage(results, 'msg-1', 'alice', 'run-1', db, schema);

    expect(linked).toEqual([newerId]);

    // Verify only the newer trade was linked
    const [olderTrade] = await db.select().from(schema.trades).where(eq(schema.trades.id, olderId));
    expect(olderTrade.closeMessageId).toBeNull();

    const [newerTrade] = await db.select().from(schema.trades).where(eq(schema.trades.id, newerId));
    expect(newerTrade.closeMessageId).toBe('msg-1');
  });

  test('executed signals are skipped (no retroactive link needed)', async () => {
    await insertClosedTrade({ symbol: 'AAPL', trader: 'alice', runId: 'run-1' });

    const results = [executedCloseSignal('AAPL')];
    const linked = await retroactiveLinkCloseMessage(results, 'msg-1', 'alice', 'run-1', db, schema);

    expect(linked).toEqual([]);
  });

  test('pending orders (with orderId) are skipped', async () => {
    await insertClosedTrade({ symbol: 'AAPL', trader: 'alice', runId: 'run-1' });

    const results = [pendingCloseSignal('AAPL')];
    const linked = await retroactiveLinkCloseMessage(results, 'msg-1', 'alice', 'run-1', db, schema);

    expect(linked).toEqual([]);
  });

  test('multiple failed CLOSE signals link to different trades', async () => {
    const aaplId = await insertClosedTrade({
      symbol: 'AAPL',
      trader: 'alice',
      runId: 'run-1',
      closedAt: '2026-01-02T10:00:00Z',
    });
    const tslaId = await insertClosedTrade({
      symbol: 'TSLA',
      trader: 'alice',
      runId: 'run-1',
      closedAt: '2026-01-02T11:00:00Z',
    });

    const results = [
      failedCloseSignal('AAPL'),
      failedCloseSignal('TSLA'),
    ];
    const linked = await retroactiveLinkCloseMessage(results, 'msg-1', 'alice', 'run-1', db, schema);

    expect(linked).toHaveLength(2);
    expect(linked).toContain(aaplId);
    expect(linked).toContain(tslaId);
  });

  test('non-CLOSE actions are ignored', async () => {
    await insertClosedTrade({ symbol: 'AAPL', trader: 'alice', runId: 'run-1' });

    const results = [
      { executed: false, signal: { action: 'OPEN', symbol: 'AAPL' } },
      { executed: false, signal: { action: 'ADD', symbol: 'AAPL' } },
      { executed: false, signal: { action: 'TRIM', symbol: 'AAPL' } },
    ];
    const linked = await retroactiveLinkCloseMessage(results, 'msg-1', 'alice', 'run-1', db, schema);

    expect(linked).toEqual([]);
  });
});
