import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { CREATE_TRADES_SQL, CREATE_TASKS_SQL, CREATE_TASKS_UNIQUE_IDX } from '@/backtest/test-fixtures.js';
import { LIVE_RISK_DEFAULTS } from '@/config/risk-defaults.js';

vi.mock('@/db/client.js', async () => {
  const { createPgTestClient } = await import('@/test/pg-test-client.js');
  return createPgTestClient('web_queries_risk');
});

import { db, schema } from '@/db/client.js';
import app from './web-queries.js';

// ── Minimal DDL for tables not covered by shared fixtures ──────────────

const CREATE_DAILY_BALANCES_SQL = sql`
  CREATE TABLE IF NOT EXISTS daily_balances (
    id text PRIMARY KEY,
    channel_id text NOT NULL,
    date text NOT NULL,
    cash_balance text NOT NULL DEFAULT '0',
    buying_power text NOT NULL DEFAULT '0',
    equity text NOT NULL,
    market_value text NOT NULL DEFAULT '0',
    unrealized_pnl text NOT NULL DEFAULT '0',
    realized_pnl text NOT NULL DEFAULT '0',
    captured_at text
  )
`;

const CREATE_RECON_ALERTS_SQL = sql`
  CREATE TABLE IF NOT EXISTS reconciliation_alerts (
    id text PRIMARY KEY,
    channel_id text NOT NULL,
    type text NOT NULL,
    symbol text NOT NULL,
    trade_id text,
    expected jsonb,
    actual jsonb,
    resolved boolean DEFAULT false,
    resolved_at text,
    resolved_reason text,
    created_at text
  )
`;

const CREATE_BACKTEST_RUNS_SQL = sql`
  CREATE TABLE IF NOT EXISTS backtest_runs (
    id text PRIMARY KEY,
    status text NOT NULL DEFAULT 'PENDING',
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    summary jsonb,
    created_at text
  )
`;

const CREATE_RUNTIME_HEALTH_SQL = sql`
  CREATE TABLE IF NOT EXISTS runtime_health (
    channel_id text PRIMARY KEY,
    broker_healthy boolean NOT NULL DEFAULT true,
    circuit_open boolean NOT NULL DEFAULT false,
    last_error text,
    updated_at text NOT NULL
  )
`;

const CHANNEL = 'ibkr:live:U99999';

beforeAll(async () => {
  await db.execute(CREATE_TRADES_SQL);
  await db.execute(CREATE_TASKS_SQL);
  await db.execute(CREATE_TASKS_UNIQUE_IDX);
  await db.execute(CREATE_DAILY_BALANCES_SQL);
  await db.execute(CREATE_RECON_ALERTS_SQL);
  await db.execute(CREATE_BACKTEST_RUNS_SQL);
  await db.execute(CREATE_RUNTIME_HEALTH_SQL);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM daily_balances`);
  await db.execute(sql`DELETE FROM reconciliation_alerts`);
  await db.execute(sql`DELETE FROM trades`);
});

// ── helper ──────────────────────────────────────────────────────────────

async function getDashboardRisk(channelId = CHANNEL) {
  const res = await app.request(`/dashboard?channel=${channelId}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.risk as {
    maxDrawdownPct: number;
    drawdownPct: number;
    tradingBlocked: boolean;
    openPositions: number;
    maxPositions: number;
    unresolvedAlerts: number;
  };
}

// ── maxDrawdownPct reads from config, not hardcoded ─────────────────────

describe('GET /dashboard risk.maxDrawdownPct', () => {
  test('returns LIVE_RISK_DEFAULTS.maxDrawdownPct, not a hardcoded 5', async () => {
    const risk = await getDashboardRisk();
    expect(risk.maxDrawdownPct).toBe(LIVE_RISK_DEFAULTS.maxDrawdownPct);
  });

  test('tradingBlocked triggers at config threshold, not hardcoded 5%', async () => {
    const threshold = LIVE_RISK_DEFAULTS.maxDrawdownPct;
    // peak equity 100k, current equity slightly below threshold
    const peak = 100_000;
    const current = peak * (1 - (threshold + 0.5) / 100); // 0.5% over threshold

    await db.insert(schema.dailyBalances).values([
      {
        id: 'peak',
        channelId: CHANNEL,
        date: '2026-04-01',
        equity: String(peak),
        cashBalance: '0',
        buyingPower: '0',
        marketValue: '0',
        unrealizedPnl: '0',
        realizedPnl: '0',
      },
      {
        id: 'current',
        channelId: CHANNEL,
        date: '2026-04-24',
        equity: String(current),
        cashBalance: '0',
        buyingPower: '0',
        marketValue: '0',
        unrealizedPnl: '0',
        realizedPnl: '0',
      },
    ]);

    const risk = await getDashboardRisk();
    expect(risk.drawdownPct).toBeGreaterThan(threshold);
    expect(risk.tradingBlocked).toBe(true);
  });

  test('tradingBlocked is false when drawdown is below threshold', async () => {
    const threshold = LIVE_RISK_DEFAULTS.maxDrawdownPct;
    const peak = 100_000;
    const current = peak * (1 - (threshold - 1) / 100); // 1% below threshold

    await db.insert(schema.dailyBalances).values([
      {
        id: 'peak2',
        channelId: CHANNEL,
        date: '2026-04-01',
        equity: String(peak),
        cashBalance: '0',
        buyingPower: '0',
        marketValue: '0',
        unrealizedPnl: '0',
        realizedPnl: '0',
      },
      {
        id: 'current2',
        channelId: CHANNEL,
        date: '2026-04-24',
        equity: String(current),
        cashBalance: '0',
        buyingPower: '0',
        marketValue: '0',
        unrealizedPnl: '0',
        realizedPnl: '0',
      },
    ]);

    const risk = await getDashboardRisk();
    expect(risk.tradingBlocked).toBe(false);
  });
});

// ── recentAlerts included in dashboard response ──────────────────────────

describe('GET /dashboard recentAlerts', () => {
  test('returns recent reconciliation alerts for the channel', async () => {
    await db.insert(schema.reconciliationAlerts).values([
      {
        id: 'alert-1',
        channelId: CHANNEL,
        type: 'DB_ONLY',
        symbol: 'AAPL',
        resolved: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'alert-2',
        channelId: CHANNEL,
        type: 'BROKER_ONLY',
        symbol: 'SPY',
        resolved: true,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
      // different channel — must not appear
      {
        id: 'alert-other',
        channelId: 'ibkr:live:OTHER',
        type: 'DB_ONLY',
        symbol: 'MSFT',
        resolved: false,
        createdAt: new Date().toISOString(),
      },
    ]);

    const res = await app.request(`/dashboard?channel=${CHANNEL}`);
    const body = await res.json();
    const ids = (body.recentAlerts as { id: string }[]).map((a) => a.id);

    expect(ids).toContain('alert-1');
    expect(ids).toContain('alert-2');
    expect(ids).not.toContain('alert-other');
  });

  test('tradingBlocked when DB_ONLY alert is unresolved', async () => {
    await db.insert(schema.reconciliationAlerts).values({
      id: 'db-only',
      channelId: CHANNEL,
      type: 'DB_ONLY',
      symbol: 'AAPL',
      resolved: false,
      createdAt: new Date().toISOString(),
    });

    const risk = await getDashboardRisk();
    expect(risk.tradingBlocked).toBe(true);
    expect(risk.unresolvedAlerts).toBeGreaterThan(0);
  });
});

// ── accountMode in /status response ─────────────────────────────────────

describe('GET /status accountMode', () => {
  test('returns live for ibkr:live: channel', async () => {
    await db.insert(schema.runtimeHealth).values({
      channelId: 'ibkr:live:U99999',
      brokerHealthy: true,
      circuitOpen: false,
      updatedAt: new Date().toISOString(),
    });

    const res = await app.request('/status?channel=ibkr:live:U99999');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountMode).toBe('live');
  });

  test('returns paper for ibkr:paper: channel', async () => {
    await db.insert(schema.runtimeHealth).values({
      channelId: 'ibkr:paper:DU12345',
      brokerHealthy: true,
      circuitOpen: false,
      updatedAt: new Date().toISOString(),
    });

    const res = await app.request('/status?channel=ibkr:paper:DU12345');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountMode).toBe('paper');
  });
});
