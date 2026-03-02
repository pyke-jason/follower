/**
 * Tests for buildPipelineDeps() factory.
 *
 * Verifies that the factory correctly wires scope-based filtering,
 * risk deps, trade recording, and pending intent tracking for both
 * live and backtest scopes.
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

// Mock getTrader
vi.mock('../config/traders.js', () => ({
  getTrader: async () => undefined,
  getTrackedTraders: async () => new Map(),
  isTrackedTrader: async () => true,
}));

// Mock getTodayStartingBalance
vi.mock('../reconciliation/daily-balance.js', () => ({
  getTodayStartingBalance: async () => ({ equity: 100_000 }),
}));

import { db, schema } from '../db/client.js';
import { buildPipelineDeps } from './build-deps.js';
import type { BrokerService } from '../broker/interface.js';
import type { AccountBalance, OrderResult, Quote, BrokerPosition } from '../broker/types.js';
import { CREATE_TRADES_SQL, CREATE_TRADE_EVENTS_SQL } from '../backtest/test-fixtures.js';

// Additional table DDL for tables the factory queries
const CREATE_RECON_ALERTS_SQL = sql`
  CREATE TABLE IF NOT EXISTS reconciliation_alerts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    trade_id TEXT,
    expected TEXT,
    actual TEXT,
    detected_at TEXT NOT NULL,
    resolved INTEGER DEFAULT 0,
    resolved_at TEXT,
    notes TEXT
  )
`;

const CREATE_ORPHAN_FILLS_SQL = sql`
  CREATE TABLE IF NOT EXISTS orphan_fills (
    order_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    strategy TEXT NOT NULL,
    direction TEXT NOT NULL,
    filled_price REAL NOT NULL,
    filled_at TEXT NOT NULL,
    filled_quantity INTEGER,
    commission REAL,
    legs TEXT,
    raw_order TEXT,
    detected_at TEXT NOT NULL,
    task_id TEXT,
    backtest_run_id TEXT
  )
`;

const CREATE_RUN_DECISIONS_SQL = sql`
  CREATE TABLE IF NOT EXISTS run_decisions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    backtest_run_id TEXT,
    task_id TEXT,
    event TEXT NOT NULL,
    signal_index INTEGER,
    outcome TEXT,
    phase TEXT,
    reasoning TEXT,
    trade_id TEXT,
    skip_category TEXT,
    snapshot TEXT DEFAULT '{}',
    pnl TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    latency_ms INTEGER,
    created_at TEXT
  )
`;

const CREATE_DAILY_BALANCES_SQL = sql`
  CREATE TABLE IF NOT EXISTS daily_balances (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL UNIQUE,
    equity REAL NOT NULL,
    buying_power REAL,
    captured_at TEXT NOT NULL
  )
`;

// ── Mock broker ──

const now = new Date().toISOString();

function createMockBroker(equity = 100_000): BrokerService {
  return {
    getQuote: async (): Promise<Quote> => ({ bid: 100, ask: 101, last: 100.5, symbol: 'SPY', volume: 1000, timestamp: now }),
    placeOrder: async (): Promise<OrderResult> => ({ orderId: 'mock-order', status: 'FILLED', filledPrice: 100, fillTimestamp: now }),
    modifyOrder: async (): Promise<OrderResult> => ({ orderId: 'mock-order', status: 'PENDING' }),
    cancelOrder: async (): Promise<OrderResult> => ({ orderId: 'mock-order', status: 'CANCELLED' }),
    getOrderStatus: async (): Promise<OrderResult> => ({ orderId: 'mock-order', status: 'PENDING' }),
    getPositions: async (): Promise<BrokerPosition[]> => [],
    getAccountBalance: async (): Promise<AccountBalance> => ({
      accountId: 'test', cashBalance: equity, buyingPower: equity * 2,
      equity, marketValue: 0, unrealizedPnl: 0, realizedPnl: 0, timestamp: now,
    }),
    isHealthy: async () => true,
  };
}

// ── Setup ──

beforeAll(async () => {
  await db.run(CREATE_TRADES_SQL);
  await db.run(CREATE_TRADE_EVENTS_SQL);
  await db.run(CREATE_RECON_ALERTS_SQL);
  await db.run(CREATE_ORPHAN_FILLS_SQL);
  await db.run(CREATE_RUN_DECISIONS_SQL);
  await db.run(CREATE_DAILY_BALANCES_SQL);
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM trades`);
  await db.run(sql`DELETE FROM trade_events`);
  await db.run(sql`DELETE FROM reconciliation_alerts`);
  await db.run(sql`DELETE FROM run_decisions`);
});

// ── Helpers ──

async function insertTrade(overrides: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await db.run(sql`
    INSERT INTO trades (id, trader, symbol, direction, strategy, status, entry_price, quantity, legs, is_backtest, backtest_run_id, opened_at, pnl, closed_at, metadata)
    VALUES (
      ${overrides.id ?? id},
      ${overrides.trader ?? 'alice'},
      ${overrides.symbol ?? 'SPY'},
      ${overrides.direction ?? 'LONG'},
      ${overrides.strategy ?? 'CALL'},
      ${overrides.status ?? 'OPEN'},
      ${overrides.entryPrice ?? '5.00'},
      ${overrides.quantity ?? 1},
      ${overrides.legs ?? '[]'},
      ${overrides.isBacktest ?? 0},
      ${overrides.backtestRunId ?? null},
      ${overrides.openedAt ?? new Date().toISOString()},
      ${overrides.pnl ?? null},
      ${overrides.closedAt ?? null},
      ${overrides.metadata ?? '{}'}
    )
  `);
  return id;
}

// ── Tests ──

describe('buildPipelineDeps', () => {
  test('backtest scope: getOpenPositions returns only run-scoped trades', async () => {
    const broker = createMockBroker();
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => new Date(), scope: { kind: 'backtest', backtestRunId: 'run-1' } },
      config: { riskConfig: { maxOnSymbol: 5, maxTotalPositions: 20, maxDrawdownPct: 5, maxNotionalMultiplier: 2 }, agentIdentity: { provider: 'test', model: 'test' } },
    });

    // Insert trades: one scoped to run-1, one scoped to run-2, one live
    await insertTrade({ backtestRunId: 'run-1', isBacktest: 1 });
    await insertTrade({ backtestRunId: 'run-2', isBacktest: 1 });
    await insertTrade({ isBacktest: 0 });

    const positions = await bundle.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].backtestRunId).toBe('run-1');

    bundle.destroy();
  });

  test('live scope: getOpenPositions returns only non-backtest trades', async () => {
    const broker = createMockBroker();
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => new Date(), scope: { kind: 'live' } },
      config: { riskConfig: { maxOnSymbol: 5, maxTotalPositions: 20, maxDrawdownPct: 5, maxNotionalMultiplier: 2 }, agentIdentity: { provider: 'test', model: 'test' } },
    });

    await insertTrade({ isBacktest: 0 });
    await insertTrade({ backtestRunId: 'run-1', isBacktest: 1 });

    const positions = await bundle.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].isBacktest).toBe(false);

    bundle.destroy();
  });

  test('recordTrade: backtest scope sets backtestRunId and isBacktest', async () => {
    const broker = createMockBroker();
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => new Date(), scope: { kind: 'backtest', backtestRunId: 'run-1' } },
      config: { riskConfig: { maxOnSymbol: 5, maxTotalPositions: 20, maxDrawdownPct: 5, maxNotionalMultiplier: 2 }, agentIdentity: { provider: 'anthropic', model: 'claude-4' } },
    });

    const result = await bundle.pipelineDeps.recordTrade({
      symbol: 'AAPL',
      trader: 'alice',
      direction: 'LONG',
      strategy: 'CALL',
      entryPrice: 5.00,
      quantity: 1,
      legs: [{ symbol: 'AAPL 250321C00200000', action: 'BUY', quantity: 1, expiry: '2025-03-21', strike: 200, type: 'CALL' }],
      openedAt: new Date().toISOString(),
    });

    expect(result).not.toBeNull();
    const trade = result!.trade;
    expect(trade.backtestRunId).toBe('run-1');
    expect(trade.isBacktest).toBe(true);
    // agentModel in metadata
    const metadata = typeof trade.metadata === 'string' ? JSON.parse(trade.metadata) : trade.metadata;
    expect(metadata.agentModel).toBe('anthropic:claude-4');

    bundle.destroy();
  });

  test('recordTrade: live scope sets isBacktest=false (taskId injected by processTask, not factory)', async () => {
    const broker = createMockBroker();
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => new Date(), scope: { kind: 'live' } },
      config: { riskConfig: { maxOnSymbol: 5, maxTotalPositions: 20, maxDrawdownPct: 5, maxNotionalMultiplier: 2 }, agentIdentity: { provider: 'xai', model: 'grok' } },
    });

    const result = await bundle.pipelineDeps.recordTrade({
      symbol: 'TSLA',
      trader: 'alice',
      direction: 'LONG',
      strategy: 'CALL',
      entryPrice: 3.00,
      quantity: 2,
      legs: [{ symbol: 'TSLA 250321C00250000', action: 'BUY', quantity: 2, expiry: '2025-03-21', strike: 250, type: 'CALL' }],
      openedAt: new Date().toISOString(),
    });

    expect(result).not.toBeNull();
    const trade = result!.trade;
    // Factory-level live recordTrade does NOT inject taskId — that's processTask's job
    expect(trade.taskId).toBeNull();
    expect(trade.isBacktest).toBe(false);
    const metadata = typeof trade.metadata === 'string' ? JSON.parse(trade.metadata) : trade.metadata;
    expect(metadata.agentModel).toBe('xai:grok');

    bundle.destroy();
  });

  test('disableRiskLimits bypasses risk checks', async () => {
    const broker = createMockBroker();
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => new Date(), scope: { kind: 'backtest', backtestRunId: 'run-1' } },
      config: {
        riskConfig: { maxOnSymbol: 1, maxTotalPositions: 1, maxDrawdownPct: 1, maxNotionalMultiplier: 0.01 },
        agentIdentity: { provider: 'test', model: 'test' },
        disableRiskLimits: true,
      },
    });

    const result = await bundle.pipelineDeps.checkRiskLimits({
      symbol: 'SPY', strategy: 'CALL', trader: 'alice',
    });
    expect(result.allowed).toBe(true);

    bundle.destroy();
  });

  test('onPending stores in pendingIntents', () => {
    const broker = createMockBroker();
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => new Date(), scope: { kind: 'live' } },
      config: { riskConfig: { maxOnSymbol: 5, maxTotalPositions: 20, maxDrawdownPct: 5, maxNotionalMultiplier: 2 }, agentIdentity: { provider: 'test', model: 'test' } },
    });

    const ctx = {
      symbol: 'SPY', direction: 'LONG' as const, strategy: 'CALL' as const,
      quantity: 1, legs: [], messageId: 'msg-1',
      recordFill: async () => null,
    };
    bundle.pipelineDeps.onPending('order-1', ctx);
    expect(bundle.pendingIntents.has('order-1')).toBe(true);

    bundle.destroy();
  });

  test('destroy cleans up OrderManager and pendingIntents', () => {
    const broker = createMockBroker();
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => new Date(), scope: { kind: 'live' } },
      config: { riskConfig: { maxOnSymbol: 5, maxTotalPositions: 20, maxDrawdownPct: 5, maxNotionalMultiplier: 2 }, agentIdentity: { provider: 'test', model: 'test' } },
    });

    bundle.pipelineDeps.onPending('order-1', {
      symbol: 'SPY', direction: 'LONG' as const, strategy: 'CALL' as const,
      quantity: 1, legs: [], recordFill: async () => null,
    });

    bundle.destroy();
    expect(bundle.pendingIntents.size).toBe(0);
  });

  test('reconciliationAlertCount: backtest always returns 0', async () => {
    const broker = createMockBroker();
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => new Date(), scope: { kind: 'backtest', backtestRunId: 'run-1' } },
      config: { riskConfig: { maxOnSymbol: 5, maxTotalPositions: 20, maxDrawdownPct: 5, maxNotionalMultiplier: 2 }, agentIdentity: { provider: 'test', model: 'test' } },
    });

    // Insert a DB_ONLY alert
    await db.run(sql`INSERT INTO reconciliation_alerts (id, type, symbol, detected_at) VALUES ('alert-1', 'DB_ONLY', 'SPY', '2026-01-01')`);

    // Backtest risk check should not be blocked by reconciliation alerts
    const result = await bundle.pipelineDeps.checkRiskLimits({
      symbol: 'SPY', strategy: 'CALL', trader: 'alice',
    });
    expect(result.allowed).toBe(true);

    bundle.destroy();
  });

  test('reconciliationAlertCount: live scope queries DB', async () => {
    const broker = createMockBroker();
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => new Date(), scope: { kind: 'live' } },
      config: { riskConfig: { maxOnSymbol: 5, maxTotalPositions: 20, maxDrawdownPct: 5, maxNotionalMultiplier: 2 }, agentIdentity: { provider: 'test', model: 'test' } },
    });

    // Insert a DB_ONLY alert (unresolved)
    await db.run(sql`INSERT INTO reconciliation_alerts (id, type, symbol, detected_at, resolved) VALUES ('alert-1', 'DB_ONLY', 'SPY', '2026-01-01', 0)`);

    // Live risk check should be blocked by reconciliation alerts
    const result = await bundle.pipelineDeps.checkRiskLimits({
      symbol: 'SPY', strategy: 'CALL', trader: 'alice',
    });
    expect(result.allowed).toBe(false);
    expect(result.reconciliationAlerts).toBe(1);

    bundle.destroy();
  });

  test('getStartingEquity: backtest uses config value for drawdown', async () => {
    const broker = createMockBroker();
    // Use a fixed clock time so toDateKeyET is deterministic
    const fixedTime = new Date('2026-03-01T15:00:00Z'); // 10am ET
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => fixedTime, scope: { kind: 'backtest', backtestRunId: 'run-1' } },
      config: {
        riskConfig: { maxOnSymbol: 5, maxTotalPositions: 20, maxDrawdownPct: 5, maxNotionalMultiplier: 2 },
        agentIdentity: { provider: 'test', model: 'test' },
        startingEquity: 50_000,
      },
    });

    // Insert a losing trade closed "today" (2026-03-01 in ET)
    await insertTrade({ backtestRunId: 'run-1', isBacktest: 1, status: 'CLOSED', pnl: '-3000', closedAt: '2026-03-01T14:30:00Z' });

    const result = await bundle.pipelineDeps.checkRiskLimits({
      symbol: 'SPY', strategy: 'CALL', trader: 'alice',
    });
    // 3000/50000 = 6% > 5% drawdown limit → blocked
    expect(result.allowed).toBe(false);
    expect(result.startingEquity).toBe(50_000);
    expect(result.currentDrawdownPct).toBeGreaterThanOrEqual(5);

    bundle.destroy();
  });

  test('calculatePositionSize forwards spreadMaxRisk', async () => {
    const broker = createMockBroker(100_000);
    const bundle = buildPipelineDeps({
      broker,
      env: { clock: () => new Date(), scope: { kind: 'live' } },
      config: { riskConfig: { maxOnSymbol: 5, maxTotalPositions: 20, maxDrawdownPct: 5, maxNotionalMultiplier: 2 }, agentIdentity: { provider: 'test', model: 'test' } },
    });

    const size = await bundle.pipelineDeps.calculatePositionSize({
      trader: 'alice',
      symbol: 'SPY',
      entryPrice: 5.00,
      strategy: 'CDS',
      spreadMaxRisk: 2.50,
    });

    expect(size.quantity).toBeGreaterThan(0);
    expect(size.reasoning).toBeDefined();

    bundle.destroy();
  });
});
