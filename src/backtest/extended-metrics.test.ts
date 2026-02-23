import { describe, test, expect } from 'vitest';
import { generateReportFromTrades } from './report.js';
import { roundCents } from '../lib/numbers.js';

// ── Trade factory ────────────────────────────────────────────────────

type TestTrade = {
  pnl: string | null; status: string; trader: string; strategy: string;
  quantity: number | null; legs: unknown[] | null;
  entryPrice: string | null; openedAt: string | null; closedAt: string | null;
};

function makeTrade(overrides: Partial<TestTrade> = {}): TestTrade {
  return {
    pnl: '100', status: 'CLOSED', trader: 'alice', strategy: 'STOCK',
    quantity: 1, legs: null, entryPrice: '100.00',
    openedAt: '2025-01-01T10:00:00Z',
    closedAt: '2025-01-01T15:00:00Z', ...overrides,
  };
}

function makeDecisions(count: number) {
  return Array.from({ length: count }, () => ({ path: 'agent', decision: 'EXECUTE' }));
}

// ── Extended metrics tests ───────────────────────────────────────────

describe('extended metrics', () => {
  test('all winning trades -> sortinoRatio = 0 (no downside deviation)', () => {
    // 5 trades on different days so we get daily PnL variance
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '200', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '150', closedAt: '2025-01-03T15:00:00Z' }),
      makeTrade({ pnl: '50', closedAt: '2025-01-06T15:00:00Z' }),
      makeTrade({ pnl: '300', closedAt: '2025-01-07T15:00:00Z' }),
    ];
    const result = generateReportFromTrades({
      trades,
      decisions: makeDecisions(trades.length),
      startingEquity: 100_000,
    });
    expect(result.extendedMetrics.sortinoRatio).toBe(0);
  });

  test('constant daily PnL -> sharpeRatio = 0 (no variance)', () => {
    // All same PnL on different days: std dev = 0 -> sharpe = 0
    // Need at least 2 days for the delta-based daily pnl computation to work
    // Without MTM, it uses equityCurve pnl directly (not deltas)
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '100', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '100', closedAt: '2025-01-03T15:00:00Z' }),
      makeTrade({ pnl: '100', closedAt: '2025-01-06T15:00:00Z' }),
      makeTrade({ pnl: '100', closedAt: '2025-01-07T15:00:00Z' }),
    ];
    const result = generateReportFromTrades({
      trades,
      decisions: makeDecisions(trades.length),
      startingEquity: 100_000,
    });
    expect(result.extendedMetrics.sharpeRatio).toBe(0);
  });

  test('consecutive streaks: [+,+,+,-,+,-,-] -> maxConsecutiveWins=3, maxConsecutiveLosses=2', () => {
    const pnls = ['100', '200', '50', '-100', '75', '-50', '-25'];
    const trades = pnls.map((pnl, i) =>
      makeTrade({
        pnl,
        closedAt: `2025-01-${String(i + 1).padStart(2, '0')}T15:00:00Z`,
      }),
    );
    const result = generateReportFromTrades({
      trades,
      decisions: makeDecisions(trades.length),
      startingEquity: 100_000,
    });
    expect(result.extendedMetrics.maxConsecutiveWins).toBe(3);
    expect(result.extendedMetrics.maxConsecutiveLosses).toBe(2);
  });

  test('median PnL odd count: [100, 200, 300] -> median=200', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '200', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '300', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const result = generateReportFromTrades({
      trades,
      decisions: makeDecisions(trades.length),
      startingEquity: 100_000,
    });
    expect(result.extendedMetrics.medianPnl).toBe(200);
  });

  test('median PnL even count: [100, 200, 300, 400] -> median=250', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '200', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '300', closedAt: '2025-01-03T15:00:00Z' }),
      makeTrade({ pnl: '400', closedAt: '2025-01-06T15:00:00Z' }),
    ];
    const result = generateReportFromTrades({
      trades,
      decisions: makeDecisions(trades.length),
      startingEquity: 100_000,
    });
    expect(result.extendedMetrics.medianPnl).toBe(250);
  });

  test('avg holding period: two trades, 2hrs and 4hrs -> avg=3hrs', () => {
    const trades = [
      makeTrade({
        pnl: '100',
        openedAt: '2025-01-01T10:00:00Z',
        closedAt: '2025-01-01T12:00:00Z', // 2 hours
      }),
      makeTrade({
        pnl: '50',
        openedAt: '2025-01-02T10:00:00Z',
        closedAt: '2025-01-02T14:00:00Z', // 4 hours
      }),
    ];
    const result = generateReportFromTrades({
      trades,
      decisions: makeDecisions(trades.length),
      startingEquity: 100_000,
    });
    expect(result.extendedMetrics.avgHoldingPeriodHours).toBe(3);
  });

  test('recovery factor: totalPnl=1000, maxDrawdown=500 -> recoveryFactor=2.0', () => {
    // Need to engineer trades: net PnL = 1000, max drawdown = 500
    // Sequence: +1500, -500 -> running: 1500, 1000. Peak=1500, dd=500. netPnl=1000
    const trades = [
      makeTrade({ pnl: '1500', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-500', closedAt: '2025-01-02T15:00:00Z' }),
    ];
    const result = generateReportFromTrades({
      trades,
      decisions: makeDecisions(trades.length),
      startingEquity: 100_000,
    });
    expect(result.summary.netPnl).toBe(1000);
    expect(result.summary.maxDrawdown).toBe(500);
    expect(result.extendedMetrics.recoveryFactor).toBe(2.0);
  });

  test('no trades -> all metrics = 0', () => {
    const result = generateReportFromTrades({
      trades: [],
      decisions: [],
      startingEquity: 100_000,
    });
    const em = result.extendedMetrics;
    expect(em.sharpeRatio).toBe(0);
    expect(em.sortinoRatio).toBe(0);
    expect(em.calmarRatio).toBe(0);
    expect(em.recoveryFactor).toBe(0);
    expect(em.maxConsecutiveWins).toBe(0);
    expect(em.maxConsecutiveLosses).toBe(0);
    expect(em.avgHoldingPeriodHours).toBe(0);
    expect(em.medianPnl).toBe(0);
    expect(em.pnlStdDev).toBe(0);
  });
});
