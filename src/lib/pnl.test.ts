/**
 * Property-based and deterministic tests for computeTradePnl.
 *
 * Uses fast-check to assert invariants that must hold for ALL valid inputs,
 * plus hand-picked examples for exact-value verification and error paths.
 */

import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import { computeTradePnl } from './pnl.js';
import { contractMultiplier } from './trade.js';
import { roundCents } from './numbers.js';

// ── Arbitraries ──────────────────────────────────────────────────────

const arbEntry = fc.double({ min: 0.01, max: 5000, noNaN: true, noDefaultInfinity: true });
const arbExit = fc.double({ min: 0.01, max: 5000, noNaN: true, noDefaultInfinity: true });
const arbDirection: fc.Arbitrary<'LONG' | 'SHORT'> = fc.constantFrom('LONG', 'SHORT');
const arbStrategy = fc.constantFrom('STOCK', 'CALL', 'PUT', 'CDS', 'PDS');
const arbQuantity = fc.integer({ min: 1, max: 1000 });

// ── Property tests ──────────────────────────────────────────────────

describe('computeTradePnl properties', () => {
  test('direction antisymmetry: PnL(LONG) = -PnL(SHORT) for same inputs', () => {
    fc.assert(
      fc.property(arbEntry, arbExit, arbStrategy, arbQuantity, (entry, exit, strategy, qty) => {
        const longPnl = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction: 'LONG', strategy, quantity: qty });
        const shortPnl = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction: 'SHORT', strategy, quantity: qty });
        // They should sum to zero (rounding applied identically to each, so exact cancellation holds
        // except for the cents-rounding step which can differ by at most 0.01).
        expect(Math.abs(longPnl + shortPnl)).toBeLessThanOrEqual(0.01);
      }),
      { numRuns: 2000 },
    );
  });

  test('quantity linearity: PnL(qty=N) = N * PnL(qty=1) within rounding tolerance', () => {
    fc.assert(
      fc.property(arbEntry, arbExit, arbDirection, arbStrategy, arbQuantity, (entry, exit, direction, strategy, qty) => {
        const pnlN = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy, quantity: qty });
        const pnl1 = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy, quantity: 1 });
        // roundCents(A*N) vs N*roundCents(A) — the qty=1 result is rounded to cents first,
        // then multiplied by N. The qty=N result rounds the full product. The rounding error
        // on the qty=1 value (up to 0.005) is amplified by N, plus one more rounding step
        // (up to 0.005) on the qty=N result. Mathematical bound: 0.005*N + 0.005.
        const tolerance = 0.005 * qty + 0.005;
        expect(Math.abs(pnlN - qty * pnl1)).toBeLessThanOrEqual(tolerance);
      }),
      { numRuns: 2000 },
    );
  });

  test('contract multiplier: option PnL = stock PnL * 100 within rounding tolerance', () => {
    fc.assert(
      fc.property(
        arbEntry,
        arbExit,
        arbDirection,
        arbQuantity,
        fc.constantFrom('CALL', 'PUT', 'CDS', 'PDS'),
        (entry, exit, direction, qty, optionStrategy) => {
          const stockPnl = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy: 'STOCK', quantity: qty });
          const optionPnl = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy: optionStrategy, quantity: qty });
          // roundCents(A * 1) * 100 vs roundCents(A * 100) — rounding at different scales.
          // Stock rounds diff*dir*qty*1, option rounds diff*dir*qty*100. The stock rounding
          // error (up to 0.005) is amplified by 100, so worst case ≈ 0.51. Use 1.0 for safety.
          expect(Math.abs(optionPnl - stockPnl * 100)).toBeLessThanOrEqual(1.0);
        },
      ),
      { numRuns: 2000 },
    );
  });

  test('result always rounded to <= 2 decimal places', () => {
    fc.assert(
      fc.property(arbEntry, arbExit, arbDirection, arbStrategy, arbQuantity, (entry, exit, direction, strategy, qty) => {
        const pnl = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy, quantity: qty });
        // Verify that roundCents is a fixed point: applying it again changes nothing.
        // This avoids IEEE 754 representation noise when checking pnl*100 directly —
        // at large magnitudes (~10^10 cents), the ulp exceeds naive epsilon thresholds.
        expect(roundCents(pnl)).toBe(pnl);
      }),
      { numRuns: 2000 },
    );
  });

  test('sign: LONG + exit > entry → PnL > 0; LONG + exit < entry → PnL < 0', () => {
    fc.assert(
      fc.property(
        arbEntry,
        arbStrategy,
        arbQuantity,
        (entry, strategy, qty) => {
          const up = computeTradePnl({ entryPrice: entry, exitPrice: entry + 1, direction: 'LONG', strategy, quantity: qty });
          expect(up).toBeGreaterThan(0);
          // Only test downside when entry > 0.5 to ensure exit stays positive
          if (entry > 0.5) {
            const down = computeTradePnl({ entryPrice: entry, exitPrice: entry - 0.5, direction: 'LONG', strategy, quantity: qty });
            expect(down).toBeLessThan(0);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  test('sign: SHORT + exit < entry → PnL > 0; SHORT + exit > entry → PnL < 0', () => {
    fc.assert(
      fc.property(
        arbEntry,
        arbStrategy,
        arbQuantity,
        (entry, strategy, qty) => {
          if (entry > 0.5) {
            const down = computeTradePnl({ entryPrice: entry, exitPrice: entry - 0.5, direction: 'SHORT', strategy, quantity: qty });
            expect(down).toBeGreaterThan(0);
          }
          const up = computeTradePnl({ entryPrice: entry, exitPrice: entry + 1, direction: 'SHORT', strategy, quantity: qty });
          expect(up).toBeLessThan(0);
        },
      ),
      { numRuns: 2000 },
    );
  });

  test('zero when entry === exit (both LONG and SHORT, never -0)', () => {
    fc.assert(
      fc.property(arbEntry, arbStrategy, arbQuantity, (price, strategy, qty) => {
        const longPnl = computeTradePnl({ entryPrice: price, exitPrice: price, direction: 'LONG', strategy, quantity: qty });
        const shortPnl = computeTradePnl({ entryPrice: price, exitPrice: price, direction: 'SHORT', strategy, quantity: qty });
        expect(Object.is(longPnl, 0)).toBe(true);  // +0, not -0
        expect(Object.is(shortPnl, 0)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  test('never NaN for finite positive inputs', () => {
    fc.assert(
      fc.property(arbEntry, arbExit, arbDirection, arbStrategy, arbQuantity, (entry, exit, direction, strategy, qty) => {
        const pnl = computeTradePnl({ entryPrice: entry, exitPrice: exit, direction, strategy, quantity: qty });
        expect(Number.isNaN(pnl)).toBe(false);
        expect(Number.isFinite(pnl)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

// ── Deterministic tests ─────────────────────────────────────────────

describe('computeTradePnl deterministic', () => {
  test('LONG STOCK: entry=100, exit=110, qty=10 → $100.00', () => {
    const pnl = computeTradePnl({ entryPrice: 100, exitPrice: 110, direction: 'LONG', strategy: 'STOCK', quantity: 10 });
    expect(pnl).toBe(100.00);
  });

  test('SHORT STOCK: entry=100, exit=90, qty=10 → $100.00', () => {
    const pnl = computeTradePnl({ entryPrice: 100, exitPrice: 90, direction: 'SHORT', strategy: 'STOCK', quantity: 10 });
    expect(pnl).toBe(100.00);
  });

  test('LONG CALL: entry=5, exit=8, qty=2 → $600.00', () => {
    const pnl = computeTradePnl({ entryPrice: 5, exitPrice: 8, direction: 'LONG', strategy: 'CALL', quantity: 2 });
    expect(pnl).toBe(600.00);
  });

  test('SHORT CALL: entry=5, exit=3, qty=2 → $400.00', () => {
    const pnl = computeTradePnl({ entryPrice: 5, exitPrice: 3, direction: 'SHORT', strategy: 'CALL', quantity: 2 });
    expect(pnl).toBe(400.00);
  });

  test('LONG PUT: entry=3, exit=1, qty=1 → -$200.00', () => {
    const pnl = computeTradePnl({ entryPrice: 3, exitPrice: 1, direction: 'LONG', strategy: 'PUT', quantity: 1 });
    expect(pnl).toBe(-200.00);
  });

  test('breakeven LONG STOCK: entry=50, exit=50, qty=100 → $0 (not -0)', () => {
    const pnl = computeTradePnl({ entryPrice: 50, exitPrice: 50, direction: 'LONG', strategy: 'STOCK', quantity: 100 });
    expect(pnl).toBe(0);
    expect(Object.is(pnl, 0)).toBe(true);  // +0, not -0
  });

  test('breakeven SHORT STOCK: entry=50, exit=50, qty=100 → $0 (not -0)', () => {
    const pnl = computeTradePnl({ entryPrice: 50, exitPrice: 50, direction: 'SHORT', strategy: 'STOCK', quantity: 100 });
    expect(pnl).toBe(0);
    expect(Object.is(pnl, 0)).toBe(true);  // +0, not -0
  });

  test('NaN entry throws', () => {
    expect(() =>
      computeTradePnl({ entryPrice: NaN, exitPrice: 100, direction: 'LONG', strategy: 'STOCK', quantity: 1 }),
    ).toThrow('NaN');
  });

  test('Infinity exit throws (guard rejects non-finite results)', () => {
    expect(() =>
      computeTradePnl({ entryPrice: 100, exitPrice: Infinity, direction: 'LONG', strategy: 'STOCK', quantity: 1 }),
    ).toThrow();
  });

  test('NaN quantity throws', () => {
    expect(() =>
      computeTradePnl({ entryPrice: 100, exitPrice: 110, direction: 'LONG', strategy: 'STOCK', quantity: NaN }),
    ).toThrow('NaN');
  });
});
