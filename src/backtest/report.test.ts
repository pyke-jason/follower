import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import { computeCoreStats } from './report.js';
import { roundCents, PROFIT_FACTOR_INF } from '../lib/numbers.js';
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

// ── Arbitraries ──────────────────────────────────────────────────────

const arbPnl = fc.oneof(
  fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }).map((v) => String(roundCents(v))),
  fc.constant(null),
);

const arbTrader = fc.constantFrom('alice', 'bob', 'carol');
const arbStrategy = fc.constantFrom('STOCK', 'CALL', 'PUT', 'CDS', 'PDS');

// Sequential dates: base day + index offset so closedAt is chronological
function arbTrades(count: { min: number; max: number }) {
  return fc.array(
    fc.record({
      pnl: arbPnl,
      trader: arbTrader,
      strategy: arbStrategy,
    }),
    count,
  ).map((items) =>
    items.map((item, i) => makeTrade({
      pnl: item.pnl,
      trader: item.trader,
      strategy: item.strategy,
      closedAt: `2025-01-${String(i + 1).padStart(2, '0')}T15:00:00Z`,
    })),
  );
}

// ── Property tests ───────────────────────────────────────────────────

describe('computeCoreStats property tests', () => {
  test('wins + losses <= totalTrades (breakeven trades are neither)', () => {
    fc.assert(
      fc.property(arbTrades({ min: 0, max: 30 }), (trades) => {
        const { summary } = computeCoreStats(trades);
        expect(summary.wins + summary.losses).toBeLessThanOrEqual(summary.totalTrades);
      }),
      { numRuns: 500 },
    );
  });

  test('0 <= winRate <= 1', () => {
    fc.assert(
      fc.property(arbTrades({ min: 0, max: 30 }), (trades) => {
        const { summary } = computeCoreStats(trades);
        expect(summary.winRate).toBeGreaterThanOrEqual(0);
        expect(summary.winRate).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });

  test('maxDrawdown >= 0', () => {
    fc.assert(
      fc.property(arbTrades({ min: 0, max: 30 }), (trades) => {
        const { summary } = computeCoreStats(trades);
        expect(summary.maxDrawdown).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 500 },
    );
  });

  test('byTrader trade counts sum to totalTrades', () => {
    fc.assert(
      fc.property(arbTrades({ min: 0, max: 30 }), (trades) => {
        const { summary, byTrader } = computeCoreStats(trades);
        const traderSum = Object.values(byTrader).reduce((s, ts) => s + ts.trades, 0);
        expect(traderSum).toBe(summary.totalTrades);
      }),
      { numRuns: 500 },
    );
  });

  test('byStrategy trade counts sum to totalTrades', () => {
    fc.assert(
      fc.property(arbTrades({ min: 0, max: 30 }), (trades) => {
        const { summary, byStrategy } = computeCoreStats(trades);
        const stratSum = Object.values(byStrategy).reduce((s, ss) => s + ss.trades, 0);
        expect(stratSum).toBe(summary.totalTrades);
      }),
      { numRuns: 500 },
    );
  });

  test('netPnl = totalPnl - totalCommissions (no commissions -> equal)', () => {
    fc.assert(
      fc.property(arbTrades({ min: 1, max: 20 }), (trades) => {
        const { summary } = computeCoreStats(trades);
        // Without commission schedule, netPnl should equal totalPnl
        expect(summary.netPnl).toBe(summary.totalPnl);
        expect(summary.totalCommissions).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  test('empty trades -> summary all zeros, equityCurve empty', () => {
    const { summary, equityCurve } = computeCoreStats([]);
    expect(summary.totalTrades).toBe(0);
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(0);
    expect(summary.winRate).toBe(0);
    expect(summary.totalPnl).toBe(0);
    expect(summary.maxDrawdown).toBe(0);
    expect(summary.profitFactor).toBe(0);
    expect(equityCurve).toEqual([]);
  });
});

// ── Deterministic tests ──────────────────────────────────────────────

describe('computeCoreStats deterministic tests', () => {
  test('single winning trade', () => {
    const { summary } = computeCoreStats([makeTrade({ pnl: '100' })]);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(0);
    expect(summary.winRate).toBe(1);
    expect(summary.totalPnl).toBe(100);
    expect(summary.maxDrawdown).toBe(0);
    expect(summary.profitFactor).toBe(PROFIT_FACTOR_INF);
  });

  test('single losing trade', () => {
    const { summary } = computeCoreStats([makeTrade({ pnl: '-50' })]);
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBe(0);
    expect(summary.totalPnl).toBe(-50);
    expect(summary.maxDrawdown).toBe(50);
    expect(summary.profitFactor).toBe(0);
  });

  test('two trades: +200, -100', () => {
    const trades = [
      makeTrade({ pnl: '200', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-100', closedAt: '2025-01-02T15:00:00Z' }),
    ];
    const { summary } = computeCoreStats(trades);
    expect(summary.totalPnl).toBe(100);
    expect(summary.maxDrawdown).toBe(100);
    expect(summary.profitFactor).toBe(2.0);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBe(0.5);
  });

  test('three trades drawdown: +100, -300, +50', () => {
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-300', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '50', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { summary } = computeCoreStats(trades);
    // Running: 100, -200, -150. Peak=100. After -300: dd=100-(-200)=300. maxDrawdown=300
    expect(summary.maxDrawdown).toBe(300);
  });

  test('with commission schedule: stock perShare=$0.005, qty=100', () => {
    const schedule: CommissionSchedule = { stock: { perShare: 0.005 } };
    const trades = [makeTrade({ pnl: '10', quantity: 100 })];
    const { summary } = computeCoreStats(trades, undefined, 100_000, schedule);
    // grossPnl = 10
    expect(summary.totalPnl).toBe(10);
    // commission: roundCents(0.005 * 100) * 2 = $1.00
    expect(summary.totalCommissions).toBe(1.0);
    // netPnl = 10 - 1 = 9
    expect(summary.netPnl).toBe(9);
  });

  test('open trades do not count in wins/losses but add entry-side commission', () => {
    const schedule: CommissionSchedule = { stock: { perShare: 0.005 } };
    const trades = [
      makeTrade({ pnl: '100', status: 'CLOSED', quantity: 100 }),
      makeTrade({ pnl: null, status: 'OPEN', quantity: 100 }),
    ];
    const { summary } = computeCoreStats(trades, undefined, 100_000, schedule);
    expect(summary.totalTrades).toBe(1); // only closed count
    expect(summary.openAtEnd).toBe(1);
    // closed commission: roundCents(0.005*100)*2 = $1.00
    // open commission: roundCents(0.005*100)*1 = $0.50
    expect(summary.totalCommissions).toBe(1.5);
  });

  test('mixed traders: 2 alice, 1 bob', () => {
    const trades = [
      makeTrade({ trader: 'alice', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ trader: 'alice', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ trader: 'bob', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { byTrader } = computeCoreStats(trades);
    expect(byTrader['alice'].trades).toBe(2);
    expect(byTrader['bob'].trades).toBe(1);
  });

  test('mixed strategies: STOCK and CALL', () => {
    const trades = [
      makeTrade({ strategy: 'STOCK', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ strategy: 'CALL', closedAt: '2025-01-02T15:00:00Z' }),
    ];
    const { byStrategy } = computeCoreStats(trades);
    expect(byStrategy['STOCK'].trades).toBe(1);
    expect(byStrategy['CALL'].trades).toBe(1);
  });

  test('net PnL conservation: sum of per-trade net PnL = summary.netPnl (no commissions)', () => {
    const trades = [
      makeTrade({ pnl: '100.33', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-50.17', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '25.84', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { summary } = computeCoreStats(trades);
    const perTradeSum = roundCents(100.33 + -50.17 + 25.84);
    expect(summary.netPnl).toBe(perTradeSum);
    expect(summary.totalPnl).toBe(perTradeSum);
  });

  test('net PnL conservation: sum of per-trade net PnL = summary.netPnl (with commissions)', () => {
    const schedule: CommissionSchedule = { stock: { perShare: 0.005 } };
    const trades = [
      makeTrade({ pnl: '200', quantity: 50, closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-80', quantity: 100, closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '30', quantity: 200, closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const { summary } = computeCoreStats(trades, undefined, 100_000, schedule);
    // grossPnl = 200 - 80 + 30 = 150
    expect(summary.totalPnl).toBe(150);
    // commissions: qty50 -> 0.005*50*2=0.50, qty100 -> 0.005*100*2=1.00, qty200 -> 0.005*200*2=2.00 => total=3.50
    expect(summary.totalCommissions).toBe(3.5);
    // netPnl = 150 - 3.50 = 146.50
    expect(summary.netPnl).toBe(146.5);
  });
});
