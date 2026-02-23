import { describe, test, expect } from 'vitest';
import { computeCoreStats } from './report.js';
import { roundCents } from '../lib/numbers.js';
import type { MtmSnapshot } from './report.js';
import type { CommissionSchedule } from '../db/schema.js';

// ── Trade factory ────────────────────────────────────────────────────

type TestTrade = {
  pnl: string | null; status: string; trader: string; strategy: string;
  quantity: number | null; legs: unknown[] | null;
  openedAt: string | null; closedAt: string | null;
};

function makeTrade(overrides: Partial<TestTrade> = {}): TestTrade {
  return {
    pnl: '100', status: 'CLOSED', trader: 'alice', strategy: 'STOCK',
    quantity: 1, legs: null, openedAt: '2025-01-01T10:00:00Z',
    closedAt: '2025-01-01T15:00:00Z', ...overrides,
  };
}

// ── Equity curve tests ───────────────────────────────────────────────

describe('equity curve', () => {
  test('chronological: equityCurve dates are sorted ascending', () => {
    const trades = [
      makeTrade({ pnl: '50', closedAt: '2025-01-03T15:00:00Z' }),
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-30', closedAt: '2025-01-02T15:00:00Z' }),
    ];
    const { equityCurve } = computeCoreStats(trades);
    const dates = equityCurve.map((pt) => pt.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  test('cumulative consistency: cumPnl[i] = cumPnl[i-1] + pnl[i]', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-30', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '50', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { equityCurve } = computeCoreStats(trades);
    for (let i = 1; i < equityCurve.length; i++) {
      expect(equityCurve[i].cumPnl).toBe(roundCents(equityCurve[i - 1].cumPnl + equityCurve[i].pnl));
    }
  });

  test('final cumPnl = sum of all pnl values in curve', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-30', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '50', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { equityCurve } = computeCoreStats(trades);
    const pnlSum = roundCents(equityCurve.reduce((s, pt) => s + pt.pnl, 0));
    expect(equityCurve[equityCurve.length - 1].cumPnl).toBe(pnlSum);
  });

  test('trade count: sum of equityCurve trades = totalTrades', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-30', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '50', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { summary, equityCurve } = computeCoreStats(trades);
    const curveTradeSum = equityCurve.reduce((s, pt) => s + pt.trades, 0);
    expect(curveTradeSum).toBe(summary.totalTrades);
  });

  test('same-day aggregation: two trades on same day -> single curve point with summed pnl', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T14:00:00Z' }),
      makeTrade({ pnl: '50', closedAt: '2025-01-01T15:00:00Z' }),
    ];
    const { equityCurve } = computeCoreStats(trades);
    expect(equityCurve).toHaveLength(1);
    expect(equityCurve[0].pnl).toBe(150);
    expect(equityCurve[0].trades).toBe(2);
  });

  test('multi-day: 3 trades on 3 different days -> 3 curve points', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-30', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '50', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { equityCurve } = computeCoreStats(trades);
    expect(equityCurve).toHaveLength(3);
    expect(equityCurve.map((pt) => pt.date)).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);
  });

  test('MTM merge: mtmSnapshot on date with no trades appears in curve with pnl=0', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
    ];
    const mtm: MtmSnapshot[] = [
      { date: '2025-01-02', unrealizedPnl: 50 },
    ];
    const { equityCurve } = computeCoreStats(trades, mtm);
    expect(equityCurve).toHaveLength(2);
    const jan2 = equityCurve.find((pt) => pt.date === '2025-01-02');
    expect(jan2).toBeDefined();
    expect(jan2!.pnl).toBe(0);
    expect(jan2!.trades).toBe(0);
  });

  test('MTM equity field: equity = cumPnl + unrealizedPnl', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
    ];
    const mtm: MtmSnapshot[] = [
      { date: '2025-01-01', unrealizedPnl: 25 },
    ];
    const { equityCurve } = computeCoreStats(trades, mtm);
    const pt = equityCurve[0];
    expect(pt.unrealizedPnl).toBe(25);
    expect(pt.equity).toBe(roundCents(pt.cumPnl + 25));
  });

  test('no MTM: unrealizedPnl and equity are undefined', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
    ];
    const { equityCurve } = computeCoreStats(trades);
    expect(equityCurve[0].unrealizedPnl).toBeUndefined();
    expect(equityCurve[0].equity).toBeUndefined();
  });

  test('rounding: all pnl and cumPnl values pass roundCents check', () => {
    const trades = [
      makeTrade({ pnl: '33.33', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-11.11', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '7.77', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { equityCurve } = computeCoreStats(trades);
    for (const pt of equityCurve) {
      expect(pt.pnl).toBe(roundCents(pt.pnl));
      expect(pt.cumPnl).toBe(roundCents(pt.cumPnl));
    }
  });

  test('final cumPnl matches summary.netPnl (no commissions)', () => {
    const trades = [
      makeTrade({ pnl: '100.50', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-30.25', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '50.75', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { summary, equityCurve } = computeCoreStats(trades);
    const finalCumPnl = equityCurve[equityCurve.length - 1].cumPnl;
    expect(finalCumPnl).toBe(summary.netPnl);
  });

  test('final cumPnl matches summary.netPnl (with commissions)', () => {
    const schedule: CommissionSchedule = { stock: { perShare: 0.005 } };
    const trades = [
      makeTrade({ pnl: '200', quantity: 50, closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-80', quantity: 100, closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '30', quantity: 200, closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { summary, equityCurve } = computeCoreStats(trades, undefined, schedule);
    const finalCumPnl = equityCurve[equityCurve.length - 1].cumPnl;
    // Equity curve uses netPnlOf() per trade, summary.netPnl = gross - commissions
    // These must agree
    expect(finalCumPnl).toBe(summary.netPnl);
  });
});
