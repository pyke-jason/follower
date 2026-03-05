/**
 * Property-based tests for the Reg-T margin model.
 *
 * Pure functions — no DB, no SimBroker instance needed.
 * Uses fast-check to verify margin invariants hold across all inputs.
 */

import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import { computeMarginRequirement } from './margin-model.js';
import { getSpreadWidth } from '../lib/trade.js';
import type { TradeLeg } from '../db/schema.js';

// ── Arbitraries ──────────────────────────────────────────────────────

const arbDirection: fc.Arbitrary<'LONG' | 'SHORT'> = fc.constantFrom('LONG', 'SHORT');
const arbPrice = fc.double({ min: 0.01, max: 5000, noNaN: true, noDefaultInfinity: true });
const arbQuantity = fc.integer({ min: 1, max: 50 });
const arbStrike = fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true });
const arbUnderlyingPrice = fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true });
const arbPremium = fc.double({ min: 0.01, max: 100, noNaN: true, noDefaultInfinity: true });

function makeLeg(overrides: Partial<TradeLeg> = {}): TradeLeg {
  return {
    symbol: 'SPY',
    strike: 0,
    expiry: '2026-12-31',
    type: 'STOCK',
    action: 'BUY',
    quantity: 1,
    ...overrides,
  } as TradeLeg;
}

function makeSpreadLegs(strike1: number, strike2: number, type: 'CALL' | 'PUT'): TradeLeg[] {
  return [
    makeLeg({ strike: strike1, type, action: 'BUY' }),
    makeLeg({ strike: strike2, type, action: 'SELL' }),
  ];
}

// ── 1. getSpreadWidth ────────────────────────────────────────────────

describe('getSpreadWidth', () => {
  test('returns 0 for < 2 option legs', () => {
    expect(getSpreadWidth([])).toBe(0);
    expect(getSpreadWidth([makeLeg({ type: 'CALL', strike: 100 })])).toBe(0);
  });

  test('returns |strike0 - strike1| for 2 option legs', () => {
    fc.assert(
      fc.property(arbStrike, arbStrike, (s1, s2) => {
        const legs = makeSpreadLegs(s1, s2, 'CALL');
        expect(getSpreadWidth(legs)).toBeCloseTo(Math.abs(s1 - s2), 8);
      }),
    );
  });

  test('always >= 0', () => {
    fc.assert(
      fc.property(arbStrike, arbStrike, (s1, s2) => {
        const width = getSpreadWidth(makeSpreadLegs(s1, s2, 'PUT'));
        expect(width).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  test('ignores STOCK legs', () => {
    const legs = [
      makeLeg({ type: 'STOCK', strike: 500 }),
      makeLeg({ type: 'CALL', strike: 100 }),
      makeLeg({ type: 'CALL', strike: 110 }),
    ];
    expect(getSpreadWidth(legs)).toBeCloseTo(10, 8);
  });
});

// ── 2. computeMarginRequirement: STOCK ───────────────────────────────

describe('computeMarginRequirement STOCK', () => {
  test('LONG: initial = 50% market value', () => {
    fc.assert(
      fc.property(arbPrice, arbQuantity, arbUnderlyingPrice, (entry, qty, underlying) => {
        const result = computeMarginRequirement({
          strategy: 'STOCK', direction: 'LONG', entryPrice: entry,
          quantity: qty, legs: [makeLeg()], underlyingPrice: underlying,
        });
        expect(result.initial).toBeCloseTo(entry * qty * 0.50, 4);
      }),
    );
  });

  test('LONG: maintenance = 25% current market value', () => {
    fc.assert(
      fc.property(arbPrice, arbQuantity, arbUnderlyingPrice, (entry, qty, underlying) => {
        const result = computeMarginRequirement({
          strategy: 'STOCK', direction: 'LONG', entryPrice: entry,
          quantity: qty, legs: [makeLeg()], underlyingPrice: underlying,
        });
        expect(result.maintenance).toBeCloseTo(underlying * qty * 0.25, 4);
      }),
    );
  });

  test('LONG: cashEffect = -marketValue (debit)', () => {
    fc.assert(
      fc.property(arbPrice, arbQuantity, arbUnderlyingPrice, (entry, qty, underlying) => {
        const result = computeMarginRequirement({
          strategy: 'STOCK', direction: 'LONG', entryPrice: entry,
          quantity: qty, legs: [makeLeg()], underlyingPrice: underlying,
        });
        expect(result.cashEffect).toBeCloseTo(-(entry * qty), 4);
      }),
    );
  });

  test('SHORT: initial = 50% market value', () => {
    fc.assert(
      fc.property(arbPrice, arbQuantity, arbUnderlyingPrice, (entry, qty, underlying) => {
        const result = computeMarginRequirement({
          strategy: 'STOCK', direction: 'SHORT', entryPrice: entry,
          quantity: qty, legs: [makeLeg()], underlyingPrice: underlying,
        });
        expect(result.initial).toBeCloseTo(entry * qty * 0.50, 4);
      }),
    );
  });

  test('SHORT: maintenance = 30% current market value', () => {
    fc.assert(
      fc.property(arbPrice, arbQuantity, arbUnderlyingPrice, (entry, qty, underlying) => {
        const result = computeMarginRequirement({
          strategy: 'STOCK', direction: 'SHORT', entryPrice: entry,
          quantity: qty, legs: [makeLeg()], underlyingPrice: underlying,
        });
        expect(result.maintenance).toBeCloseTo(underlying * qty * 0.30, 4);
      }),
    );
  });

  test('SHORT: cashEffect = +marketValue (credit)', () => {
    fc.assert(
      fc.property(arbPrice, arbQuantity, arbUnderlyingPrice, (entry, qty, underlying) => {
        const result = computeMarginRequirement({
          strategy: 'STOCK', direction: 'SHORT', entryPrice: entry,
          quantity: qty, legs: [makeLeg()], underlyingPrice: underlying,
        });
        expect(result.cashEffect).toBeCloseTo(entry * qty, 4);
      }),
    );
  });
});

// ── 3. computeMarginRequirement: single-leg options ──────────────────

describe('computeMarginRequirement CALL/PUT', () => {
  test('LONG CALL: initial = premium, maintenance = 0', () => {
    fc.assert(
      fc.property(arbPremium, arbQuantity, arbStrike, arbUnderlyingPrice, (premium, qty, strike, underlying) => {
        const result = computeMarginRequirement({
          strategy: 'CALL', direction: 'LONG', entryPrice: premium,
          quantity: qty, legs: [makeLeg({ type: 'CALL', strike })], underlyingPrice: underlying,
        });
        expect(result.initial).toBeCloseTo(premium * qty * 100, 2);
        expect(result.maintenance).toBe(0);
        expect(result.cashEffect).toBeCloseTo(-(premium * qty * 100), 2);
      }),
    );
  });

  test('LONG PUT: initial = premium, maintenance = 0', () => {
    fc.assert(
      fc.property(arbPremium, arbQuantity, arbStrike, arbUnderlyingPrice, (premium, qty, strike, underlying) => {
        const result = computeMarginRequirement({
          strategy: 'PUT', direction: 'LONG', entryPrice: premium,
          quantity: qty, legs: [makeLeg({ type: 'PUT', strike })], underlyingPrice: underlying,
        });
        expect(result.initial).toBeCloseTo(premium * qty * 100, 2);
        expect(result.maintenance).toBe(0);
        expect(result.cashEffect).toBeCloseTo(-(premium * qty * 100), 2);
      }),
    );
  });

  test('SHORT CALL: margin > premium (naked call requires more)', () => {
    fc.assert(
      fc.property(arbPremium, arbQuantity, arbStrike, arbUnderlyingPrice, (premium, qty, strike, underlying) => {
        const result = computeMarginRequirement({
          strategy: 'CALL', direction: 'SHORT', entryPrice: premium,
          quantity: qty, legs: [makeLeg({ type: 'CALL', strike })], underlyingPrice: underlying,
        });
        // Naked margin is always >= max(FINRA floor, 10% rule)
        const finraFloor = (0.50 + premium) * qty * 100;
        const rule10 = (0.10 * underlying + premium) * qty * 100;
        const minMargin = Math.max(finraFloor, rule10);
        expect(result.initial).toBeGreaterThanOrEqual(minMargin - 0.01);
        expect(result.maintenance).toBeCloseTo(result.initial, 4);
        expect(result.cashEffect).toBeCloseTo(premium * qty * 100, 2);
      }),
    );
  });

  test('SHORT PUT: margin > premium (naked put requires more)', () => {
    fc.assert(
      fc.property(arbPremium, arbQuantity, arbStrike, arbUnderlyingPrice, (premium, qty, strike, underlying) => {
        const result = computeMarginRequirement({
          strategy: 'PUT', direction: 'SHORT', entryPrice: premium,
          quantity: qty, legs: [makeLeg({ type: 'PUT', strike })], underlyingPrice: underlying,
        });
        // Naked put: min is max(FINRA floor, 10% strike + premium)
        const finraFloor = (0.50 + premium) * qty * 100;
        const rule10 = (0.10 * strike + premium) * qty * 100;
        const minMargin = Math.max(finraFloor, rule10);
        expect(result.initial).toBeGreaterThanOrEqual(minMargin - 0.01);
        expect(result.maintenance).toBeCloseTo(result.initial, 4);
        expect(result.cashEffect).toBeCloseTo(premium * qty * 100, 2);
      }),
    );
  });
});

// ── 4. computeMarginRequirement: vertical spreads ────────────────────

describe('computeMarginRequirement CDS/PDS (vertical spreads)', () => {
  test('LONG debit spread: initial = debit paid, maintenance = 0', () => {
    fc.assert(
      fc.property(
        arbPremium, arbQuantity, arbStrike, arbStrike, arbUnderlyingPrice,
        fc.constantFrom('CDS', 'PDS'),
        (premium, qty, s1, s2, underlying, strategy) => {
          const legs = makeSpreadLegs(s1, s2, strategy === 'CDS' ? 'CALL' : 'PUT');
          const result = computeMarginRequirement({
            strategy, direction: 'LONG', entryPrice: premium,
            quantity: qty, legs, underlyingPrice: underlying,
          });
          expect(result.initial).toBeCloseTo(premium * qty * 100, 2);
          expect(result.maintenance).toBe(0);
          expect(result.cashEffect).toBeCloseTo(-(premium * qty * 100), 2);
        },
      ),
    );
  });

  test('SHORT credit spread: initial = net margin = (width − premium) × qty × 100', () => {
    fc.assert(
      fc.property(
        arbPremium, arbQuantity, arbStrike, arbStrike, arbUnderlyingPrice,
        fc.constantFrom('CDS', 'PDS'),
        (premium, qty, s1, s2, underlying, strategy) => {
          const legs = makeSpreadLegs(s1, s2, strategy === 'CDS' ? 'CALL' : 'PUT');
          const width = Math.abs(s1 - s2);
          const result = computeMarginRequirement({
            strategy, direction: 'SHORT', entryPrice: premium,
            quantity: qty, legs, underlyingPrice: underlying,
          });
          const expectedMargin = Math.max(0, (width - premium)) * qty * 100;
          expect(result.initial).toBeCloseTo(expectedMargin, 2);
          expect(result.maintenance).toBeCloseTo(result.initial, 4);
          expect(result.cashEffect).toBeCloseTo(premium * qty * 100, 2);
        },
      ),
    );
  });

  test('credit spread margin = net risk (width − credit), floored at 0', () => {
    fc.assert(
      fc.property(arbPremium, arbQuantity, (premium, qty) => {
        const legs = makeSpreadLegs(100, 105, 'CALL');
        const result = computeMarginRequirement({
          strategy: 'CDS', direction: 'SHORT', entryPrice: premium,
          quantity: qty, legs, underlyingPrice: 100,
        });
        expect(result.initial).toBeCloseTo(Math.max(0, (5 - premium)) * qty * 100, 2);
      }),
    );
  });
});

// ── 5. Cross-cutting properties ──────────────────────────────────────

describe('computeMarginRequirement cross-cutting properties', () => {
  test('initial and maintenance are always >= 0', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('STOCK', 'CALL', 'PUT', 'CDS', 'PDS'),
        arbDirection, arbPrice, arbQuantity, arbUnderlyingPrice,
        (strategy, direction, entry, qty, underlying) => {
          const legs = strategy === 'CDS' || strategy === 'PDS'
            ? makeSpreadLegs(100, 110, strategy === 'CDS' ? 'CALL' : 'PUT')
            : strategy === 'STOCK'
              ? [makeLeg()]
              : [makeLeg({ type: strategy as 'CALL' | 'PUT', strike: 100 })];

          const result = computeMarginRequirement({
            strategy, direction, entryPrice: entry,
            quantity: qty, legs, underlyingPrice: underlying,
          });
          expect(result.initial).toBeGreaterThanOrEqual(0);
          expect(result.maintenance).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  test('LONG strategies always debit (cashEffect <= 0)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('STOCK', 'CALL', 'PUT', 'CDS', 'PDS'),
        arbPrice, arbQuantity, arbUnderlyingPrice,
        (strategy, entry, qty, underlying) => {
          const legs = strategy === 'CDS' || strategy === 'PDS'
            ? makeSpreadLegs(100, 110, strategy === 'CDS' ? 'CALL' : 'PUT')
            : strategy === 'STOCK'
              ? [makeLeg()]
              : [makeLeg({ type: strategy as 'CALL' | 'PUT', strike: 100 })];

          const result = computeMarginRequirement({
            strategy, direction: 'LONG', entryPrice: entry,
            quantity: qty, legs, underlyingPrice: underlying,
          });
          expect(result.cashEffect).toBeLessThanOrEqual(0);
        },
      ),
    );
  });

  test('SHORT strategies always credit (cashEffect >= 0)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('STOCK', 'CALL', 'PUT', 'CDS', 'PDS'),
        arbPrice, arbQuantity, arbUnderlyingPrice,
        (strategy, entry, qty, underlying) => {
          const legs = strategy === 'CDS' || strategy === 'PDS'
            ? makeSpreadLegs(100, 110, strategy === 'CDS' ? 'CALL' : 'PUT')
            : strategy === 'STOCK'
              ? [makeLeg()]
              : [makeLeg({ type: strategy as 'CALL' | 'PUT', strike: 100 })];

          const result = computeMarginRequirement({
            strategy, direction: 'SHORT', entryPrice: entry,
            quantity: qty, legs, underlyingPrice: underlying,
          });
          expect(result.cashEffect).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  test('defined-risk LONG: initial = |cashEffect| (you pay exactly the debit)', () => {
    // For LONG options and debit spreads, initial margin = premium = |cashEffect|
    fc.assert(
      fc.property(
        fc.constantFrom('CALL', 'PUT', 'CDS', 'PDS'),
        arbPremium, arbQuantity, arbUnderlyingPrice,
        (strategy, premium, qty, underlying) => {
          const legs = strategy === 'CDS' || strategy === 'PDS'
            ? makeSpreadLegs(100, 110, strategy === 'CDS' ? 'CALL' : 'PUT')
            : [makeLeg({ type: strategy as 'CALL' | 'PUT', strike: 100 })];

          const result = computeMarginRequirement({
            strategy, direction: 'LONG', entryPrice: premium,
            quantity: qty, legs, underlyingPrice: underlying,
          });
          expect(result.initial).toBeCloseTo(Math.abs(result.cashEffect), 2);
        },
      ),
    );
  });

  test('unknown strategy falls back to notional × 100', () => {
    const result = computeMarginRequirement({
      strategy: 'BUTTERFLY', direction: 'LONG', entryPrice: 2,
      quantity: 1, legs: [makeLeg({ type: 'CALL', strike: 100 })], underlyingPrice: 100,
    });
    expect(result.initial).toBeCloseTo(200, 2);
    expect(result.maintenance).toBeCloseTo(200, 2);
    expect(result.cashEffect).toBeCloseTo(-200, 2);
  });
});

// ── 6. Concrete examples (sanity checks) ────────────────────────────

describe('computeMarginRequirement concrete examples', () => {
  test('buy 100 shares of SPY at $450: margin = $22,500, cash = -$45,000', () => {
    const result = computeMarginRequirement({
      strategy: 'STOCK', direction: 'LONG', entryPrice: 450,
      quantity: 100, legs: [makeLeg()], underlyingPrice: 450,
    });
    expect(result.initial).toBeCloseTo(22500, 0);
    expect(result.maintenance).toBeCloseTo(11250, 0);
    expect(result.cashEffect).toBeCloseTo(-45000, 0);
  });

  test('sell 5-wide CDS for $2 credit (1 contract): margin = $300, cash = +$200', () => {
    const result = computeMarginRequirement({
      strategy: 'CDS', direction: 'SHORT', entryPrice: 2,
      quantity: 1, legs: makeSpreadLegs(200, 205, 'CALL'), underlyingPrice: 200,
    });
    expect(result.initial).toBeCloseTo(300, 0);
    expect(result.maintenance).toBeCloseTo(300, 0);
    expect(result.cashEffect).toBeCloseTo(200, 0);
  });

  test('buy 10-wide PDS for $3 debit (2 contracts): margin = $600, cash = -$600', () => {
    const result = computeMarginRequirement({
      strategy: 'PDS', direction: 'LONG', entryPrice: 3,
      quantity: 2, legs: makeSpreadLegs(300, 290, 'PUT'), underlyingPrice: 295,
    });
    expect(result.initial).toBeCloseTo(600, 0);
    expect(result.maintenance).toBe(0);
    expect(result.cashEffect).toBeCloseTo(-600, 0);
  });

  test('buy 1 CALL at $5 premium: margin = $500, cash = -$500', () => {
    const result = computeMarginRequirement({
      strategy: 'CALL', direction: 'LONG', entryPrice: 5,
      quantity: 1, legs: [makeLeg({ type: 'CALL', strike: 200 })], underlyingPrice: 195,
    });
    expect(result.initial).toBeCloseTo(500, 0);
    expect(result.maintenance).toBe(0);
    expect(result.cashEffect).toBeCloseTo(-500, 0);
  });

  test('naked short call: SPY at $450, sell 460C for $3', () => {
    // OTM = max(0, 460-450) = 10
    // Formula a: 0.20*450 - 10 + 3 = 83
    // Formula b: 0.10*450 + 3 = 48
    // Per-contract margin: max(83, 48) = 83
    // Total: 83 * 1 * 100 = 8300
    const result = computeMarginRequirement({
      strategy: 'CALL', direction: 'SHORT', entryPrice: 3,
      quantity: 1, legs: [makeLeg({ type: 'CALL', strike: 460 })], underlyingPrice: 450,
    });
    expect(result.initial).toBeCloseTo(8300, 0);
    expect(result.cashEffect).toBeCloseTo(300, 0);
  });

  test('naked short put: SPY at $450, sell 440P for $2', () => {
    // OTM = max(0, 450-440) = 10
    // Formula a: 0.20*450 - 10 + 2 = 82
    // Formula b: 0.10*440 + 2 = 46
    // Per-contract margin: max(82, 46) = 82
    // Total: 82 * 1 * 100 = 8200
    const result = computeMarginRequirement({
      strategy: 'PUT', direction: 'SHORT', entryPrice: 2,
      quantity: 1, legs: [makeLeg({ type: 'PUT', strike: 440 })], underlyingPrice: 450,
    });
    expect(result.initial).toBeCloseTo(8200, 0);
    expect(result.cashEffect).toBeCloseTo(200, 0);
  });
});
