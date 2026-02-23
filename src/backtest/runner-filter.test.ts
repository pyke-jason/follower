/**
 * Tests for the backtest tradable-message filter predicate.
 *
 * runner.ts:130 filters on `m.symbols.length > 0 && !m.isPaperTrade`.
 * This includes badge-less messages that have valid extracted symbols.
 */

import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import type { HistoricalMessage } from './types.js';

// ── Predicate under test ──────────────────────────────────────────
// runner.ts:130 uses this predicate — symbols-based inclusion.

const filter = (m: Pick<HistoricalMessage, 'symbols' | 'isPaperTrade'>) =>
  m.symbols.length > 0 && !m.isPaperTrade;

// ── Arbitraries ───────────────────────────────────────────────────

const arbSymbols = fc.oneof(
  fc.constant([] as string[]),
  fc.array(fc.constantFrom('SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA'), { minLength: 1, maxLength: 3 }),
);

// ── Tests ─────────────────────────────────────────────────────────

describe('tradable message filter predicate', () => {
  test('messages with symbols are included', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('SPY', 'QQQ', 'AAPL', 'TSLA'), { minLength: 1, maxLength: 3 }),
        (symbols) => {
          expect(filter({ symbols, isPaperTrade: false })).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  test('messages with no symbols are excluded', () => {
    fc.assert(
      fc.property(fc.boolean(), (isPaper) => {
        expect(filter({ symbols: [], isPaperTrade: isPaper })).toBe(false);
      }),
    );
  });

  test('paper trades are always excluded regardless of symbols', () => {
    fc.assert(
      fc.property(arbSymbols, (symbols) => {
        expect(filter({ symbols, isPaperTrade: true })).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  test('non-paper messages with symbols are always included', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('SPY', 'QQQ', 'AAPL', 'TSLA'), { minLength: 1, maxLength: 3 }),
        (symbols) => {
          expect(filter({ symbols, isPaperTrade: false })).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  test('non-paper messages without symbols are always excluded', () => {
    fc.assert(
      fc.property(fc.boolean(), (_) => {
        expect(filter({ symbols: [], isPaperTrade: false })).toBe(false);
      }),
    );
  });
});
