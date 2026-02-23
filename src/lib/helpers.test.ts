import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import { safeParseFloat, roundCents, round } from './numbers.js';
import { contractMultiplier, assetType, tradeQty } from './trade.js';

// ── safeParseFloat ───────────────────────────────────────────────────

describe('safeParseFloat', () => {
  test('"123.45" -> 123.45', () => {
    expect(safeParseFloat('123.45')).toBe(123.45);
  });

  test('"0" -> 0', () => {
    expect(safeParseFloat('0')).toBe(0);
  });

  test('"" -> 0 (fallback)', () => {
    expect(safeParseFloat('')).toBe(0);
  });

  test('"abc" -> 0', () => {
    expect(safeParseFloat('abc')).toBe(0);
  });

  test('null -> 0', () => {
    expect(safeParseFloat(null)).toBe(0);
  });

  test('undefined -> 0', () => {
    expect(safeParseFloat(undefined)).toBe(0);
  });

  test('NaN -> 0 (not finite)', () => {
    expect(safeParseFloat(NaN)).toBe(0);
  });

  test('Infinity -> 0 (not finite)', () => {
    expect(safeParseFloat(Infinity)).toBe(0);
  });

  test('-Infinity -> 0', () => {
    expect(safeParseFloat(-Infinity)).toBe(0);
  });

  test('42 (number) -> 42', () => {
    expect(safeParseFloat(42)).toBe(42);
  });

  test('custom fallback: safeParseFloat(null, -1) -> -1', () => {
    expect(safeParseFloat(null, -1)).toBe(-1);
  });

  test('property: for any finite number n, safeParseFloat(String(n)) is within 1e-10 of n', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }),
        (n) => {
          const result = safeParseFloat(String(n));
          expect(Math.abs(result - n)).toBeLessThan(1e-10);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ── roundCents ───────────────────────────────────────────────────────

describe('roundCents', () => {
  test('roundCents(1.005) — document IEEE 754 behavior', () => {
    // Due to IEEE 754, 1.005 * 100 = 100.49999..., so Math.round gives 100 -> 1.00
    expect(roundCents(1.005)).toBe(1);
  });

  test('roundCents(1.235) -> 1.24', () => {
    expect(roundCents(1.235)).toBe(1.24);
  });

  test('roundCents(-1.235) -> -1.24', () => {
    // -1.235 * 100 = -123.50000000000001 in IEEE 754, so Math.round gives -124 -> -1.24
    expect(roundCents(-1.235)).toBe(-1.24);
  });

  test('roundCents(0) -> 0', () => {
    expect(roundCents(0)).toBe(0);
  });

  test('idempotency property: roundCents(roundCents(x)) === roundCents(x)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (x) => {
          expect(roundCents(roundCents(x))).toBe(roundCents(x));
        },
      ),
      { numRuns: 1000 },
    );
  });

  test('proximity property: |roundCents(x) - x| < 0.005 + epsilon', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (x) => {
          expect(Math.abs(roundCents(x) - x)).toBeLessThan(0.005 + 1e-10);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

// ── round ────────────────────────────────────────────────────────────

describe('round', () => {
  test('property: round(x, 2) === roundCents(x) for any x', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
        (x) => {
          expect(round(x, 2)).toBe(roundCents(x));
        },
      ),
      { numRuns: 1000 },
    );
  });

  test('round(1.2345, 3) -> 1.235', () => {
    expect(round(1.2345, 3)).toBe(1.235);
  });

  test('round(1.2345, 0) -> 1', () => {
    expect(round(1.2345, 0)).toBe(1);
  });
});

// ── contractMultiplier ───────────────────────────────────────────────

describe('contractMultiplier', () => {
  test("'STOCK' -> 1", () => {
    expect(contractMultiplier('STOCK')).toBe(1);
  });

  test("'CALL' -> 100", () => {
    expect(contractMultiplier('CALL')).toBe(100);
  });

  test("'PUT' -> 100", () => {
    expect(contractMultiplier('PUT')).toBe(100);
  });

  test("'CDS' -> 100", () => {
    expect(contractMultiplier('CDS')).toBe(100);
  });

  test("'PDS' -> 100", () => {
    expect(contractMultiplier('PDS')).toBe(100);
  });
});

// ── assetType ────────────────────────────────────────────────────────

describe('assetType', () => {
  test("'STOCK' -> 'EQ'", () => {
    expect(assetType('STOCK')).toBe('EQ');
  });

  test("'CALL' -> 'OP'", () => {
    expect(assetType('CALL')).toBe('OP');
  });

  test("'PUT' -> 'OP'", () => {
    expect(assetType('PUT')).toBe('OP');
  });

  test("'CDS' -> 'OP'", () => {
    expect(assetType('CDS')).toBe('OP');
  });

  test("'PDS' -> 'OP'", () => {
    expect(assetType('PDS')).toBe('OP');
  });
});

// ── tradeQty ─────────────────────────────────────────────────────────

describe('tradeQty', () => {
  test('null -> 1', () => {
    expect(tradeQty(null)).toBe(1);
  });

  test('undefined -> 1', () => {
    expect(tradeQty(undefined)).toBe(1);
  });

  test('0 -> 0 (validation lives in recordTrade, not here)', () => {
    expect(tradeQty(0)).toBe(0);
  });

  test('negative passes through (validation lives in recordTrade)', () => {
    expect(tradeQty(-1)).toBe(-1);
  });

  test('5 -> 5', () => {
    expect(tradeQty(5)).toBe(5);
  });

  test('100 -> 100', () => {
    expect(tradeQty(100)).toBe(100);
  });
});
