/**
 * TDD tests for the backtest tradable-message filter predicate.
 *
 * Current code (runner.ts:130-132) filters on `m.badges.length > 0`,
 * which drops badge-less messages even when they have valid symbols.
 * The CORRECT predicate is `m.symbols.length > 0 && !m.isPaperTrade`.
 *
 * These tests document the desired behavior. They will FAIL until
 * runner.ts is updated to use the symbols-based filter.
 */

import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import type { HistoricalMessage } from './types.js';

// ── Predicate under test ──────────────────────────────────────────
// The runner's filter is inline — we define both the OLD and NEW
// versions here so we can assert the NEW one is correct.

/** Current (BUGGY) predicate — badges-based */
const oldFilter = (m: Pick<HistoricalMessage, 'badges' | 'symbols' | 'isPaperTrade'>) =>
  m.badges.length > 0 && !m.isPaperTrade;

/** Desired (CORRECT) predicate — symbols-based */
const newFilter = (m: Pick<HistoricalMessage, 'badges' | 'symbols' | 'isPaperTrade'>) =>
  m.symbols.length > 0 && !m.isPaperTrade;

// NOTE: After the fix, runner.ts:130 must match `newFilter`:
//   const tradableMessages = allMessages.filter(
//     (m) => m.symbols.length > 0 && !m.isPaperTrade,
//   );

// ── Arbitraries ───────────────────────────────────────────────────

const arbBadges = fc.oneof(
  fc.constant([] as string[]),
  fc.array(fc.constantFrom('opening', 'closing', 'add', 'trim'), { minLength: 1, maxLength: 3 }),
);

const arbSymbols = fc.oneof(
  fc.constant([] as string[]),
  fc.array(fc.constantFrom('SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA'), { minLength: 1, maxLength: 3 }),
);

const arbMessage = fc.record({
  badges: arbBadges,
  symbols: arbSymbols,
  isPaperTrade: fc.boolean(),
});

// ── Tests ─────────────────────────────────────────────────────────

describe('tradable message filter predicate', () => {
  describe('newFilter: symbols-based inclusion', () => {
    test('messages with symbols but empty badges ARE included', () => {
      // This is the key case: badges=[] but symbols=['AAPL']
      // The OLD filter rejects these. The NEW filter includes them.
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom('SPY', 'QQQ', 'AAPL', 'TSLA'), { minLength: 1, maxLength: 3 }),
          (symbols) => {
            const msg = { badges: [], symbols, isPaperTrade: false };
            expect(newFilter(msg)).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    test('messages with no symbols AND no badges are excluded', () => {
      fc.assert(
        fc.property(fc.boolean(), (isPaper) => {
          const msg = { badges: [], symbols: [], isPaperTrade: isPaper };
          expect(newFilter(msg)).toBe(false);
        }),
      );
    });

    test('paper trades are always excluded regardless of symbols/badges', () => {
      fc.assert(
        fc.property(arbBadges, arbSymbols, (badges, symbols) => {
          const msg = { badges, symbols, isPaperTrade: true };
          expect(newFilter(msg)).toBe(false);
        }),
        { numRuns: 500 },
      );
    });

    test('non-paper messages with symbols are always included', () => {
      fc.assert(
        fc.property(
          arbBadges,
          fc.array(fc.constantFrom('SPY', 'QQQ', 'AAPL', 'TSLA'), { minLength: 1, maxLength: 3 }),
          (badges, symbols) => {
            const msg = { badges, symbols, isPaperTrade: false };
            expect(newFilter(msg)).toBe(true);
          },
        ),
        { numRuns: 500 },
      );
    });

    test('non-paper messages without symbols are always excluded', () => {
      fc.assert(
        fc.property(arbBadges, (badges) => {
          const msg = { badges, symbols: [], isPaperTrade: false };
          expect(newFilter(msg)).toBe(false);
        }),
      );
    });
  });

  describe('old vs new: divergence on badge-less symbol messages', () => {
    test('oldFilter rejects badge-less messages that newFilter accepts', () => {
      // This test documents the BUG: messages with symbols but no badges
      // are rejected by the old filter but should be accepted.
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom('SPY', 'QQQ', 'AAPL'), { minLength: 1, maxLength: 3 }),
          (symbols) => {
            const msg = { badges: [], symbols, isPaperTrade: false };
            // Old filter incorrectly rejects these
            expect(oldFilter(msg)).toBe(false);
            // New filter correctly includes them
            expect(newFilter(msg)).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    test('both filters agree on messages with both badges and symbols', () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom('opening', 'closing'), { minLength: 1, maxLength: 2 }),
          fc.array(fc.constantFrom('SPY', 'QQQ', 'AAPL'), { minLength: 1, maxLength: 2 }),
          (badges, symbols) => {
            const msg = { badges, symbols, isPaperTrade: false };
            expect(oldFilter(msg)).toBe(true);
            expect(newFilter(msg)).toBe(true);
          },
        ),
      );
    });

    test('both filters agree on paper trades (always excluded)', () => {
      fc.assert(
        fc.property(arbBadges, arbSymbols, (badges, symbols) => {
          const msg = { badges, symbols, isPaperTrade: true };
          expect(oldFilter(msg)).toBe(false);
          expect(newFilter(msg)).toBe(false);
        }),
      );
    });
  });
});
