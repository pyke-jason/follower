import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import { computeTradeCommission, computeEntrySideCommission } from './commission.js';
import type { CommissionSchedule } from '../db/schema.js';
import { roundCents } from './numbers.js';

// ── Arbitraries ──────────────────────────────────────────────────────

const arbStrategy = fc.constantFrom('STOCK', 'CALL', 'PUT', 'CDS', 'PDS');
const arbQuantity = fc.integer({ min: 1, max: 100 });
const arbLegs = fc.array(fc.constant({}), { minLength: 1, maxLength: 4 });

const arbSchedule: fc.Arbitrary<CommissionSchedule> = fc.record({
  stock: fc.record({
    perShare: fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
    minimum: fc.double({ min: 0, max: 5, noNaN: true, noDefaultInfinity: true }),
    maximum: fc.double({ min: 5, max: 100, noNaN: true, noDefaultInfinity: true }),
  }),
  option: fc.record({
    perContract: fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }),
  }),
});

function makeTrade(strategy: string, quantity: number | null, legs: unknown[] | null, openLegCount?: number) {
  return { strategy, quantity, legs, metadata: openLegCount != null ? { openLegCount } : undefined };
}

// ── Property tests ───────────────────────────────────────────────────

describe('commission property tests', () => {
  test('without openLegCount: round-trip = 2x entry', () => {
    fc.assert(
      fc.property(arbStrategy, arbQuantity, arbLegs, arbSchedule, (strategy, qty, legs, schedule) => {
        const trade = makeTrade(strategy, qty, legs);
        const roundTrip = computeTradeCommission(trade, schedule);
        const entry = computeEntrySideCommission(trade, schedule);
        expect(roundTrip).toBe(roundCents(entry * 2));
      }),
      { numRuns: 1000 },
    );
  });

  test('no schedule -> 0', () => {
    fc.assert(
      fc.property(arbStrategy, arbQuantity, arbLegs, (strategy, qty, legs) => {
        const trade = makeTrade(strategy, qty, legs);
        expect(computeTradeCommission(trade, undefined)).toBe(0);
        expect(computeEntrySideCommission(trade, undefined)).toBe(0);
      }),
    );
  });

  test('non-negative: commission >= 0 always', () => {
    fc.assert(
      fc.property(arbStrategy, arbQuantity, arbLegs, arbSchedule, (strategy, qty, legs, schedule) => {
        const trade = makeTrade(strategy, qty, legs);
        expect(computeTradeCommission(trade, schedule)).toBeGreaterThanOrEqual(0);
        expect(computeEntrySideCommission(trade, schedule)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 1000 },
    );
  });

  test('stock perShare=0 -> 0 regardless of qty', () => {
    fc.assert(
      fc.property(arbQuantity, (qty) => {
        const trade = makeTrade('STOCK', qty, null);
        const schedule: CommissionSchedule = { stock: { perShare: 0 }, option: { perContract: 0.65 } };
        expect(computeTradeCommission(trade, schedule)).toBe(0);
        expect(computeEntrySideCommission(trade, schedule)).toBe(0);
      }),
    );
  });

  test('option perContract=0 -> 0 regardless of qty/legs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('CALL', 'PUT', 'CDS', 'PDS'),
        arbQuantity,
        arbLegs,
        (strategy, qty, legs) => {
          const trade = makeTrade(strategy, qty, legs);
          const schedule: CommissionSchedule = { stock: { perShare: 0.005 }, option: { perContract: 0 } };
          expect(computeTradeCommission(trade, schedule)).toBe(0);
          expect(computeEntrySideCommission(trade, schedule)).toBe(0);
        },
      ),
    );
  });
});

// ── Deterministic tests ──────────────────────────────────────────────

describe('commission deterministic tests', () => {
  const stdSchedule: CommissionSchedule = {
    stock: { perShare: 0.005 },
    option: { perContract: 0.65 },
  };

  test('STOCK, qty=100, perShare=$0.005 -> entry=$0.50, roundTrip=$1.00', () => {
    const trade = makeTrade('STOCK', 100, null);
    expect(computeEntrySideCommission(trade, stdSchedule)).toBe(0.5);
    expect(computeTradeCommission(trade, stdSchedule)).toBe(1.0);
  });

  test('STOCK, qty=100, perShare=$0.005, min=$1.00 -> entry=$1.00, roundTrip=$2.00', () => {
    const trade = makeTrade('STOCK', 100, null);
    const schedule: CommissionSchedule = {
      stock: { perShare: 0.005, minimum: 1.0 },
      option: { perContract: 0.65 },
    };
    expect(computeEntrySideCommission(trade, schedule)).toBe(1.0);
    expect(computeTradeCommission(trade, schedule)).toBe(2.0);
  });

  test('STOCK, qty=100, perShare=$0.005, max=$0.25 -> entry=$0.25, roundTrip=$0.50', () => {
    const trade = makeTrade('STOCK', 100, null);
    const schedule: CommissionSchedule = {
      stock: { perShare: 0.005, maximum: 0.25 },
      option: { perContract: 0.65 },
    };
    expect(computeEntrySideCommission(trade, schedule)).toBe(0.25);
    expect(computeTradeCommission(trade, schedule)).toBe(0.5);
  });

  test('CALL, qty=5, 1 leg, perContract=$0.65 -> entry=$3.25, roundTrip=$6.50', () => {
    const trade = makeTrade('CALL', 5, [{}]);
    expect(computeEntrySideCommission(trade, stdSchedule)).toBe(3.25);
    expect(computeTradeCommission(trade, stdSchedule)).toBe(6.5);
  });

  test('CDS, qty=5, 2 legs, perContract=$0.65 -> entry=$6.50, roundTrip=$13.00', () => {
    const trade = makeTrade('CDS', 5, [{}, {}]);
    expect(computeEntrySideCommission(trade, stdSchedule)).toBe(6.5);
    expect(computeTradeCommission(trade, stdSchedule)).toBe(13.0);
  });

  test('PDS, qty=3, 2 legs, perContract=$0.65 -> entry=$3.90, roundTrip=$7.80', () => {
    const trade = makeTrade('PDS', 3, [{}, {}]);
    expect(computeEntrySideCommission(trade, stdSchedule)).toBe(3.9);
    expect(computeTradeCommission(trade, stdSchedule)).toBe(7.8);
  });

  test('null legs -> 1 leg: CALL, qty=5, legs=null, perContract=$0.65 -> entry=$3.25', () => {
    const trade = makeTrade('CALL', 5, null);
    expect(computeEntrySideCommission(trade, stdSchedule)).toBe(3.25);
  });

  test('null quantity -> 1: CALL, qty=null, 1 leg, perContract=$0.65 -> entry=$0.65', () => {
    const trade = makeTrade('CALL', null, [{}]);
    expect(computeEntrySideCommission(trade, stdSchedule)).toBe(0.65);
  });

  test('STOCK min > max throws', () => {
    const trade = makeTrade('STOCK', 100, null);
    const schedule: CommissionSchedule = {
      stock: { perShare: 0.005, minimum: 10, maximum: 5 },
      option: { perContract: 0.65 },
    };
    expect(() => computeEntrySideCommission(trade, schedule)).toThrow('minimum');
    expect(() => computeTradeCommission(trade, schedule)).toThrow('minimum');
  });
});

// ── LEG_OFF asymmetric commission tests ──────────────────────────────

describe('LEG_OFF openLegCount', () => {
  const schedule: CommissionSchedule = {
    option: { perContract: 0.50 },
  };

  test('PDS with LEG_OFF: open=2 legs, close=1 leg -> asymmetric commission', () => {
    // UNH scenario: opened as PDS (2 legs), LEG_OFF removed one, closed as PUT (1 leg)
    const trade = makeTrade('PUT', 5, [{}], 2);
    // open side: 0.50 × 5 × 2 = $5.00
    // close side: 0.50 × 5 × 1 = $2.50
    // total: $7.50
    expect(computeTradeCommission(trade, schedule)).toBe(7.5);
    // entry side should use openLegCount
    expect(computeEntrySideCommission(trade, schedule)).toBe(5.0);
  });

  test('without openLegCount metadata, falls back to current legs', () => {
    const trade = makeTrade('PUT', 5, [{}]);
    // Both sides use legs.length = 1
    // 0.50 × 5 × 1 × 2 = $5.00
    expect(computeTradeCommission(trade, schedule)).toBe(5.0);
    expect(computeEntrySideCommission(trade, schedule)).toBe(2.5);
  });

  test('openLegCount same as current legs -> same as symmetric', () => {
    const trade = makeTrade('CDS', 5, [{}, {}], 2);
    // openLegCount=2, legs.length=2 -> symmetric
    // 0.50 × 5 × 2 × 2 = $10.00
    expect(computeTradeCommission(trade, schedule)).toBe(10.0);
  });

  test('open position after LEG_OFF uses openLegCount for entry commission', () => {
    // WBD-like: opened as CDS (2 legs), LEG_OFF removed one, still open
    const trade = makeTrade('CALL', 6, [{}], 2);
    // entry side: 0.50 × 6 × 2 = $6.00
    expect(computeEntrySideCommission(trade, schedule)).toBe(6.0);
  });

  test('stock ignores openLegCount (stocks have no legs)', () => {
    const trade = makeTrade('STOCK', 100, null, 2);
    const stockSchedule: CommissionSchedule = {
      stock: { perShare: 0.005 },
      option: { perContract: 0.50 },
    };
    expect(computeTradeCommission(trade, stockSchedule)).toBe(1.0);
  });
});
