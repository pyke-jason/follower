import { describe, it, expect } from 'vitest';
import { checkRiskLimits } from './risk-check.js';
import type { RiskCheckDeps, RiskCheckConfig } from './risk-check.js';
import type { Trade } from '../db/schema.js';

const config: RiskCheckConfig = {
  maxOnSymbol: 2,
  maxTotalPositions: 5,
  maxDrawdownPct: 5,
  maxNotionalMultiplier: 2,
};

const OLD_OPEN = new Date(Date.now() - 120_000).toISOString(); // 2 min ago — outside 30s dup guard

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: crypto.randomUUID(),
    channelId: 'ibkr:live:U123',
    symbol: 'AAPL',
    direction: 'LONG',
    strategy: 'STOCK',
    status: 'OPEN',
    quantity: 100,
    entryPrice: '100.00',
    exitPrice: null,
    pnl: null,
    openedAt: OLD_OPEN,
    closedAt: null,
    taskId: null,
    trader: 'test',
    legs: [],
    metadata: {},
    avgEntryPrice: null,
    brokerFillPrice: null,
    brokerFillQty: null,
    brokerCommission: null,
    brokerFillTime: null,
    brokerLegFills: null,
    exitPercent: null,
    targetStrategy: null,
    ...overrides,
  } as Trade;
}

function makeDeps(overrides: Partial<RiskCheckDeps> = {}): RiskCheckDeps {
  return {
    getOpenTrades: async () => [],
    getDailyClosedPnl: async () => 0,
    getStartingEquity: async () => 100_000,
    getCurrentEquity: async () => 100_000,
    getReconciliationAlertCount: async () => 0,
    getWorkingOrderExposure: () => ({ countBySymbol: new Map(), totalCount: 0, totalNotional: 0 }),
    getMaintenanceMargin: async () => null,
    ...overrides,
  };
}

const input = { symbol: 'AAPL', strategy: 'STOCK', trader: 'test', action: 'OPEN', direction: 'LONG' };

describe('checkRiskLimits', () => {
  it('allows a clean open', async () => {
    const result = await checkRiskLimits(input, makeDeps(), config);
    expect(result.allowed).toBe(true);
  });

  it('always allows CLOSE regardless of limits', async () => {
    const deps = makeDeps({
      getOpenTrades: async () => Array.from({ length: 10 }, () => makeTrade()),
      getReconciliationAlertCount: async () => 5,
    });
    const result = await checkRiskLimits({ ...input, action: 'CLOSE' }, deps, config);
    expect(result.allowed).toBe(true);
  });

  it('blocks when maxTotalPositions is reached', async () => {
    const openTrades = Array.from({ length: 5 }, (_, i) =>
      makeTrade({ id: String(i), symbol: `SYM${i}` }),
    );
    const deps = makeDeps({ getOpenTrades: async () => openTrades });
    const result = await checkRiskLimits(input, deps, config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/total positions/i);
  });

  it('blocks when maxOnSymbol is reached', async () => {
    const openTrades = [makeTrade({ symbol: 'AAPL' }), makeTrade({ symbol: 'AAPL' })];
    const deps = makeDeps({ getOpenTrades: async () => openTrades });
    const result = await checkRiskLimits(input, deps, config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/positions.*AAPL/i);
  });

  it('blocks when drawdown exceeds threshold', async () => {
    const deps = makeDeps({
      getDailyClosedPnl: async () => -6_000, // 6% of 100k > maxDrawdownPct 5%
      getStartingEquity: async () => 100_000,
    });
    const result = await checkRiskLimits(input, deps, config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/drawdown/i);
    expect(result.currentDrawdownPct).toBeGreaterThanOrEqual(5);
  });

  it('does not trigger drawdown halt when pnl is positive', async () => {
    const deps = makeDeps({
      getDailyClosedPnl: async () => 3_000,
      getStartingEquity: async () => 100_000,
    });
    const result = await checkRiskLimits(input, deps, config);
    expect(result.allowed).toBe(true);
  });

  it('blocks when notional exposure exceeds maxNotionalMultiplier', async () => {
    // 10 trades × 100 shares × $100 = $100k notional; equity=$40k → 2x cap = $80k → blocked
    const openTrades = Array.from({ length: 10 }, () =>
      makeTrade({ quantity: 100, entryPrice: '100.00', strategy: 'STOCK' }),
    );
    const deps = makeDeps({
      getOpenTrades: async () => openTrades,
      getCurrentEquity: async () => 40_000,
    });
    // Raise position limit so that doesn't trigger first
    const looseLimits = { ...config, maxTotalPositions: 100, maxOnSymbol: 100 };
    const result = await checkRiskLimits(input, deps, looseLimits);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/notional/i);
  });

  it('blocks when there are unresolved reconciliation alerts', async () => {
    const deps = makeDeps({ getReconciliationAlertCount: async () => 2 });
    const result = await checkRiskLimits(input, deps, config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/reconciliation/i);
    expect(result.reconciliationAlerts).toBe(2);
  });
});
