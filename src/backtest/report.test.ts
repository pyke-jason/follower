import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import { computeCoreStats, type MtmSnapshot } from './report.js';
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
    const { summary } = computeCoreStats(trades, undefined, schedule);
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
    const { summary } = computeCoreStats(trades, undefined, schedule);
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
    const { summary } = computeCoreStats(trades, undefined, schedule);
    // grossPnl = 200 - 80 + 30 = 150
    expect(summary.totalPnl).toBe(150);
    // commissions: qty50 -> 0.005*50*2=0.50, qty100 -> 0.005*100*2=1.00, qty200 -> 0.005*200*2=2.00 => total=3.50
    expect(summary.totalCommissions).toBe(3.5);
    // netPnl = 150 - 3.50 = 146.50
    expect(summary.netPnl).toBe(146.5);
  });
});

// ── MTM-aware drawdown tests ────────────────────────────────────────

describe('computeCoreStats MTM-aware drawdown', () => {
  test('maxDrawdown reflects unrealized dip when MTM snapshots are provided', () => {
    // Scenario: Position opens, drops $5k unrealized mid-run, recovers, closes at +$100.
    // Realized-only drawdown = $0 (only one winning trade).
    // True MTM-aware drawdown = $5,000 (the unrealized dip).
    //
    // Day 1: trade opens (no close yet), MTM shows -$5000 unrealized
    // Day 2: MTM shows -$2000 unrealized (recovering)
    // Day 3: trade closes at +$100
    const trades = [
      makeTrade({ pnl: '100', status: 'CLOSED',
        openedAt: '2025-01-01T10:00:00Z', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const mtmSnapshots: MtmSnapshot[] = [
      { date: '2025-01-01', unrealizedPnl: -5000 },
      { date: '2025-01-02', unrealizedPnl: -2000 },
      { date: '2025-01-03', unrealizedPnl: 0 },
    ];

    const { summary, equityCurve } = computeCoreStats(trades, mtmSnapshots);

    // Equity curve should have MTM data
    expect(equityCurve.some((pt) => pt.equity != null)).toBe(true);

    // Day 1: cumPnl=0, unrealized=-5000, equity=-5000
    // Day 2: cumPnl=0, unrealized=-2000, equity=-2000
    // Day 3: cumPnl=100, unrealized=0, equity=100
    // Peak starts at 0. On day 1: equity=-5000, dd=0-(-5000)=5000.
    // maxDrawdown must be 5000, NOT 0 (realized-only).
    expect(summary.maxDrawdown).toBe(5000);
  });

  test('maxDrawdown uses realized PnL when no MTM snapshots provided', () => {
    // This tests the existing fallback behavior: three trades, realized drawdown = $300.
    const trades = [
      makeTrade({ pnl: '100', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-300', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '50', closedAt: '2025-01-03T15:00:00Z' }),
    ];

    const { summary } = computeCoreStats(trades);

    // Running: 100, -200, -150. Peak=100. After -300: dd=100-(-200)=300
    expect(summary.maxDrawdown).toBe(300);
  });

  test('maxDrawdown uses realized PnL when MTM snapshots are empty', () => {
    const trades = [
      makeTrade({ pnl: '200', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-150', closedAt: '2025-01-02T15:00:00Z' }),
    ];

    const { summary } = computeCoreStats(trades, []);

    // Running: 200, 50. Peak=200. After -150: dd=200-50=150
    expect(summary.maxDrawdown).toBe(150);
  });

  test('MTM drawdown exceeds realized drawdown with multiple trades', () => {
    // Two trades close profitably, but MTM shows a big unrealized dip between them.
    // Day 1: first trade closes +$500
    // Day 2: new position tanks unrealized -$3000 (equity = 500 + (-3000) = -2500)
    // Day 3: recovers, second trade closes +$200
    const trades = [
      makeTrade({ pnl: '500', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '200', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const mtmSnapshots: MtmSnapshot[] = [
      { date: '2025-01-01', unrealizedPnl: 0 },
      { date: '2025-01-02', unrealizedPnl: -3000 },
      { date: '2025-01-03', unrealizedPnl: 0 },
    ];

    const { summary } = computeCoreStats(trades, mtmSnapshots);

    // Realized-only drawdown = $0 (both trades are winners, running cumPnl: 500, 700)
    // Equity curve:
    //   Day 1: cumPnl=500, unrealized=0, equity=500 (new peak=500)
    //   Day 2: cumPnl=500, unrealized=-3000, equity=-2500 (dd=500-(-2500)=3000)
    //   Day 3: cumPnl=700, unrealized=0, equity=700 (new peak=700)
    // maxDrawdown = 3000
    expect(summary.maxDrawdown).toBe(3000);
  });
});

// ── MTM edge cases ──────────────────────────────────────────────────

describe('computeCoreStats MTM edge cases', () => {
  test('all-open trades with MTM losses (no closed trades)', () => {
    // No closed trades at all — only open positions with unrealized losses.
    // The MTM snapshots alone should produce a drawdown.
    const trades = [
      makeTrade({ pnl: null, status: 'OPEN',
        openedAt: '2025-01-01T10:00:00Z', closedAt: null }),
    ];
    const mtmSnapshots: MtmSnapshot[] = [
      { date: '2025-01-01', unrealizedPnl: -2000 },
      { date: '2025-01-02', unrealizedPnl: -5000 },
      { date: '2025-01-03', unrealizedPnl: -1000 },
    ];

    const { summary, equityCurve } = computeCoreStats(trades, mtmSnapshots);

    // Equity curve should have 3 points (one per MTM day)
    expect(equityCurve).toHaveLength(3);

    // cumPnl=0 throughout (no closed trades), so equity = 0 + unrealized
    expect(equityCurve[0]).toMatchObject({ date: '2025-01-01', cumPnl: 0, equity: -2000 });
    expect(equityCurve[1]).toMatchObject({ date: '2025-01-02', cumPnl: 0, equity: -5000 });
    expect(equityCurve[2]).toMatchObject({ date: '2025-01-03', cumPnl: 0, equity: -1000 });

    // Peak starts at 0, deepest equity = -5000, so maxDrawdown = 0 - (-5000) = 5000
    expect(summary.maxDrawdown).toBe(5000);
  });

  test('multi-day gap with peak carry-forward', () => {
    // Trade closed on Jan 2 at +$500, another on Jan 6 (Monday) at -$200.
    // MTM on Jan 2: unrealized=+100 → equity peak = 500+100 = 600
    // Weekend gap: no data for Jan 3-5
    // MTM on Jan 6: unrealized=-300 → equity = (500-200) + (-300) = 0
    // Peak (600) must carry across the gap. maxDrawdown = 600 - 0 = 600.
    const trades = [
      makeTrade({ pnl: '500', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '-200', closedAt: '2025-01-06T15:00:00Z' }),
    ];
    const mtmSnapshots: MtmSnapshot[] = [
      { date: '2025-01-02', unrealizedPnl: 100 },
      { date: '2025-01-06', unrealizedPnl: -300 },
    ];

    const { summary, equityCurve } = computeCoreStats(trades, mtmSnapshots);

    // Day 2025-01-02: cumPnl=500, unrealized=100, equity=600 (peak)
    expect(equityCurve[0]).toMatchObject({ date: '2025-01-02', cumPnl: 500, equity: 600 });
    // Day 2025-01-06: cumPnl=500-200=300, unrealized=-300, equity=0
    expect(equityCurve[1]).toMatchObject({ date: '2025-01-06', cumPnl: 300, equity: 0 });

    // maxDrawdown = peak(600) - trough(0) = 600
    expect(summary.maxDrawdown).toBe(600);
  });

  test('mixed MTM and non-MTM days in same curve', () => {
    // Day 1: trade closes at +$300, MTM snapshot unrealized=-100 → equity = 300 + (-100) = 200
    // Day 2: trade closes at -$500, NO MTM snapshot → equity fallback to cumPnl = 300-500 = -200
    // Day 3: trade closes at +$100, MTM snapshot unrealized=+50 → equity = -200+100+50 = -50
    const trades = [
      makeTrade({ pnl: '300', closedAt: '2025-01-01T15:00:00Z' }),
      makeTrade({ pnl: '-500', closedAt: '2025-01-02T15:00:00Z' }),
      makeTrade({ pnl: '100', closedAt: '2025-01-03T15:00:00Z' }),
    ];
    const mtmSnapshots: MtmSnapshot[] = [
      { date: '2025-01-01', unrealizedPnl: -100 },
      // No snapshot for 2025-01-02 — tests the fallback path
      { date: '2025-01-03', unrealizedPnl: 50 },
    ];

    const { summary, equityCurve } = computeCoreStats(trades, mtmSnapshots);

    // Day 1: cumPnl=300, unrealized=-100, equity=200
    expect(equityCurve[0]).toMatchObject({ date: '2025-01-01', cumPnl: 300, equity: 200 });
    // Day 2: cumPnl=-200, no MTM → equity undefined, fallback uses cumPnl=-200
    expect(equityCurve[1]).toMatchObject({ date: '2025-01-02', cumPnl: -200 });
    expect(equityCurve[1].equity).toBeUndefined();
    // Day 3: cumPnl=-100, unrealized=50, equity=-50
    expect(equityCurve[2]).toMatchObject({ date: '2025-01-03', cumPnl: -100, equity: -50 });

    // Equity sequence (with fallback): 200, -200, -50
    // Peak = 200 (day 1). Trough = -200 (day 2). maxDrawdown = 200 - (-200) = 400
    expect(summary.maxDrawdown).toBe(400);
  });
});
