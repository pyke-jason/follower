/**
 * Property-based and unit tests for OCC symbology utilities.
 *
 * Pure functions — no DB, no broker needed.
 * Uses fast-check to verify round-trip and structural invariants.
 */

import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import {
  formatOccSymbol,
  parseOccSymbol,
  isOccOptionSymbol,
  normalizeExpiry,
  buildOccSymbols,
} from './occ-symbology.js';

// ── Arbitraries ───────────────────────────────────────────────────────

/** Underlying ticker: 1–5 uppercase letters */
const arbUnderlying = fc.stringMatching(/^[A-Z]{1,5}$/)
  .filter(s => s.length >= 1);

/** Strike price: typical option range, multiple of 0.5 to avoid floating-point drift */
const arbStrike = fc.integer({ min: 1, max: 4000 }).map(n => n * 0.5);

const arbOptionType: fc.Arbitrary<'CALL' | 'PUT'> = fc.constantFrom('CALL', 'PUT');

/** Year: 2-digit year in range fast-check can comfortably generate */
const arbYear = fc.integer({ min: 2024, max: 2035 });
const arbMonth = fc.integer({ min: 1, max: 12 });

/** Day within a safe range — avoids leap-year and month-length edge cases */
const arbDay = fc.integer({ min: 1, max: 28 });

/** A valid YYYY-MM-DD expiration string */
const arbExpiry = fc.tuple(arbYear, arbMonth, arbDay).map(
  ([y, m, d]) =>
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
);

// ── formatOccSymbol / parseOccSymbol round-trip ───────────────────────

describe('formatOccSymbol / parseOccSymbol', () => {
  test('round-trip: parse(format(x)) = x', () => {
    fc.assert(
      fc.property(arbUnderlying, arbExpiry, arbOptionType, arbStrike, (underlying, expiration, type, strike) => {
        const symbol = formatOccSymbol({ underlying, expiration, type, strike });
        const parsed = parseOccSymbol(symbol);
        expect(parsed).not.toBeNull();
        expect(parsed!.underlying).toBe(underlying);
        expect(parsed!.type).toBe(type);
        expect(parsed!.strike).toBeCloseTo(strike, 3);
        const [y, m, d] = expiration.split('-').map(Number);
        expect(parsed!.expiration.getUTCFullYear()).toBe(y);
        expect(parsed!.expiration.getUTCMonth() + 1).toBe(m);
        expect(parsed!.expiration.getUTCDate()).toBe(d);
      }),
    );
  });

  test('output is always exactly 21 characters', () => {
    fc.assert(
      fc.property(arbUnderlying, arbExpiry, arbOptionType, arbStrike, (underlying, expiration, type, strike) => {
        const symbol = formatOccSymbol({ underlying, expiration, type, strike });
        expect(symbol).toHaveLength(21);
      }),
    );
  });

  test('isOccOptionSymbol recognizes every formatted symbol', () => {
    fc.assert(
      fc.property(arbUnderlying, arbExpiry, arbOptionType, arbStrike, (underlying, expiration, type, strike) => {
        const symbol = formatOccSymbol({ underlying, expiration, type, strike });
        expect(isOccOptionSymbol(symbol)).toBe(true);
      }),
    );
  });

  test('underlying is left-aligned, space-padded to 6 chars', () => {
    fc.assert(
      fc.property(arbUnderlying, arbExpiry, arbOptionType, arbStrike, (underlying, expiration, type, strike) => {
        const symbol = formatOccSymbol({ underlying, expiration, type, strike });
        expect(symbol.slice(0, 6)).toBe(underlying.padEnd(6, ' '));
      }),
    );
  });

  test('C/P character is at position 12', () => {
    fc.assert(
      fc.property(arbUnderlying, arbExpiry, arbOptionType, arbStrike, (underlying, expiration, type, strike) => {
        const symbol = formatOccSymbol({ underlying, expiration, type, strike });
        expect(symbol[12]).toBe(type === 'CALL' ? 'C' : 'P');
      }),
    );
  });

  test('strike encodes as 8-digit zero-padded integer (×1000)', () => {
    fc.assert(
      fc.property(arbUnderlying, arbExpiry, arbOptionType, arbStrike, (underlying, expiration, type, strike) => {
        const symbol = formatOccSymbol({ underlying, expiration, type, strike });
        const encoded = parseInt(symbol.slice(13), 10);
        expect(encoded).toBe(Math.round(strike * 1000));
      }),
    );
  });
});

// ── isOccOptionSymbol ─────────────────────────────────────────────────

describe('isOccOptionSymbol', () => {
  test('rejects strings shorter or longer than 21 chars', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 30 }).filter(s => s.length !== 21),
        s => !isOccOptionSymbol(s),
      ),
    );
  });

  test('rejects symbols with wrong type character', () => {
    fc.assert(
      fc.property(arbUnderlying, arbExpiry, arbOptionType, arbStrike, (underlying, expiration, type, strike) => {
        const sym = formatOccSymbol({ underlying, expiration, type, strike });
        const corrupted = sym.slice(0, 12) + 'X' + sym.slice(13);
        expect(isOccOptionSymbol(corrupted)).toBe(false);
      }),
    );
  });
});

// ── normalizeExpiry ───────────────────────────────────────────────────

const REF = new Date('2025-01-01');

/** All supported month-name abbreviations */
const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULLS   = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ORDINALS      = ['', 'st', 'nd', 'rd', 'th'];

describe('normalizeExpiry', () => {
  test('YYYY-MM-DD passes through unchanged', () => {
    fc.assert(
      fc.property(arbExpiry, expiry => {
        expect(normalizeExpiry(expiry, REF)).toBe(expiry);
      }),
    );
  });

  test('output is always YYYY-MM-DD', () => {
    const formats = fc.oneof(
      arbExpiry,
      // MM/DD
      fc.tuple(arbMonth, arbDay).map(([m, d]) => `${m}/${d}`),
      // MM/DD/YYYY
      fc.tuple(arbMonth, arbDay, arbYear).map(([m, d, y]) => `${m}/${d}/${y}`),
    );
    fc.assert(
      fc.property(formats, input => {
        const result = normalizeExpiry(input, REF);
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }),
    );
  });

  test('MM/DD/YYYY and YYYY-MM-DD resolve to same date', () => {
    fc.assert(
      fc.property(arbYear, arbMonth, arbDay, (y, m, d) => {
        const slash = `${m}/${d}/${y}`;
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        expect(normalizeExpiry(slash, REF)).toBe(normalizeExpiry(iso, REF));
      }),
    );
  });

  test('MM/DD/YY (2-digit year) resolves to 2000+YY', () => {
    fc.assert(
      fc.property(arbMonth, arbDay, fc.integer({ min: 24, max: 35 }), (m, d, yy) => {
        const result = normalizeExpiry(`${m}/${d}/${yy}`, REF);
        expect(result.startsWith(`${2000 + yy}-`)).toBe(true);
      }),
    );
  });

  test('dash-separated M-DD matches slash MM/DD', () => {
    fc.assert(
      fc.property(arbMonth, arbDay, (m, d) => {
        const dash = `${m}-${String(d).padStart(2, '0')}`;
        const slash = `${m}/${d}`;
        expect(normalizeExpiry(dash, REF)).toBe(normalizeExpiry(slash, REF));
      }),
    );
  });

  test('year-free formats yield refYear or refYear+1', () => {
    // Avoid UTC vs local-time mismatch by comparing year integers, not Date objects.
    // normalizeExpiry uses local-time Date comparisons internally, so comparing the
    // output year string against the reference year is the timezone-safe approach.
    fc.assert(
      fc.property(arbMonth, arbDay, arbYear, (m, d, refYear) => {
        const ref = new Date(refYear, m - 1, d);
        const result = normalizeExpiry(`${m}/${d}`, ref);
        const resultYear = parseInt(result.split('-')[0], 10);
        return resultYear === refYear || resultYear === refYear + 1;
      }),
    );
  });

  // ── Month-name format properties ──

  test('abbreviated month name (e.g. "Oct 18") resolves same as MM/DD', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 11 }),
        arbDay,
        (monthIdx, day) => {
          const abbrev = MONTH_ABBREVS[monthIdx];
          const m = monthIdx + 1;
          const nameForm = `${abbrev} ${day}`;
          const slashForm = `${m}/${day}`;
          expect(normalizeExpiry(nameForm, REF)).toBe(normalizeExpiry(slashForm, REF));
        },
      ),
    );
  });

  test('full month name (e.g. "October 18") resolves same as abbreviated', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 11 }),
        arbDay,
        (monthIdx, day) => {
          const abbrev = MONTH_ABBREVS[monthIdx];
          const full = MONTH_FULLS[monthIdx];
          const ref = new Date('2025-06-01');
          expect(normalizeExpiry(`${full} ${day}`, ref)).toBe(normalizeExpiry(`${abbrev} ${day}`, ref));
        },
      ),
    );
  });

  test('ordinal suffixes (st/nd/rd/th) are ignored', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 11 }),
        arbDay,
        fc.constantFrom(...ORDINALS),
        (monthIdx, day, suffix) => {
          const abbrev = MONTH_ABBREVS[monthIdx];
          const withSuffix = `${abbrev} ${day}${suffix}`;
          const without = `${abbrev} ${day}`;
          expect(normalizeExpiry(withSuffix, REF)).toBe(normalizeExpiry(without, REF));
        },
      ),
    );
  });

  test('day-first order (e.g. "18 Oct") resolves same as month-first', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 11 }),
        arbDay,
        (monthIdx, day) => {
          const abbrev = MONTH_ABBREVS[monthIdx];
          const monthFirst = `${abbrev} ${day}`;
          const dayFirst   = `${day} ${abbrev}`;
          expect(normalizeExpiry(dayFirst, REF)).toBe(normalizeExpiry(monthFirst, REF));
        },
      ),
    );
  });

  test('month-name with explicit year resolves to that year', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 11 }),
        arbDay,
        arbYear,
        (monthIdx, day, year) => {
          const abbrev = MONTH_ABBREVS[monthIdx];
          const m = monthIdx + 1;
          const result = normalizeExpiry(`${abbrev} ${day}, ${year}`, REF);
          expect(result).toBe(`${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        },
      ),
    );
  });

  test('case-insensitive month names', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 11 }),
        arbDay,
        fc.constantFrom('lower', 'upper', 'mixed') as fc.Arbitrary<'lower' | 'upper' | 'mixed'>,
        (monthIdx, day, caseStyle) => {
          const abbrev = MONTH_ABBREVS[monthIdx];
          const cased =
            caseStyle === 'lower' ? abbrev.toLowerCase() :
            caseStyle === 'upper' ? abbrev.toUpperCase() :
            abbrev;
          expect(normalizeExpiry(`${cased} ${day}`, REF)).toBe(normalizeExpiry(`${abbrev} ${day}`, REF));
        },
      ),
    );
  });

  // ── Spot checks for known inputs ──

  test('spot checks — all formats', () => {
    const ref = new Date('2025-09-01');
    expect(normalizeExpiry('Oct 18',          ref)).toBe('2025-10-18');
    expect(normalizeExpiry('Oct 18th',        ref)).toBe('2025-10-18');
    expect(normalizeExpiry('October 18',      ref)).toBe('2025-10-18');
    expect(normalizeExpiry('October 18th',    ref)).toBe('2025-10-18');
    expect(normalizeExpiry('october 18',      ref)).toBe('2025-10-18');
    expect(normalizeExpiry('OCTOBER 18',      ref)).toBe('2025-10-18');
    expect(normalizeExpiry('18 Oct',          ref)).toBe('2025-10-18');
    expect(normalizeExpiry('18th Oct',        ref)).toBe('2025-10-18');
    expect(normalizeExpiry('18 October',      ref)).toBe('2025-10-18');
    expect(normalizeExpiry('Oct 18, 2025',    ref)).toBe('2025-10-18');
    expect(normalizeExpiry('October 18 2025', ref)).toBe('2025-10-18');
    expect(normalizeExpiry('18 Oct 2025',     ref)).toBe('2025-10-18');
    // Pre-existing formats still work
    expect(normalizeExpiry('2025-10-18',      ref)).toBe('2025-10-18');
    expect(normalizeExpiry('10/18',           ref)).toBe('2025-10-18');
    expect(normalizeExpiry('10/18/25',        ref)).toBe('2025-10-18');
    expect(normalizeExpiry('10/18/2025',      ref)).toBe('2025-10-18');
    expect(normalizeExpiry('10-18',           ref)).toBe('2025-10-18');
  });

  test('year rollover: month in the past rolls to next year', () => {
    const ref = new Date('2025-11-01');
    // October is before November, so "Oct 18" should resolve to 2026
    expect(normalizeExpiry('Oct 18', ref)).toBe('2026-10-18');
    expect(normalizeExpiry('10/18',  ref)).toBe('2026-10-18');
  });

  // ── Semantic expiry strings (LLM fallback) ──

  test('semantic strings resolve to next Friday on or after refDate', () => {
    // Wednesday 2025-09-10 → next Friday is 2025-09-12
    const wed = new Date(Date.UTC(2025, 8, 10));
    expect(normalizeExpiry('next-expiry', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('this-friday', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('next-friday', wed)).toBe('2025-09-12');
  });

  test('semantic strings on Friday resolve to that same Friday', () => {
    // Friday 2025-09-12
    const fri = new Date(Date.UTC(2025, 8, 12));
    expect(normalizeExpiry('next-expiry', fri)).toBe('2025-09-12');
  });

  test('semantic strings on Saturday resolve to next Friday', () => {
    // Saturday 2025-09-13 → next Friday is 2025-09-19
    const sat = new Date(Date.UTC(2025, 8, 13));
    expect(normalizeExpiry('next-expiry', sat)).toBe('2025-09-19');
  });

  test('semantic strings on Sunday resolve to next Friday', () => {
    // Sunday 2025-09-14 → next Friday is 2025-09-19
    const sun = new Date(Date.UTC(2025, 8, 14));
    expect(normalizeExpiry('next-expiry', sun)).toBe('2025-09-19');
  });

  test('semantic strings are case-insensitive', () => {
    const wed = new Date(Date.UTC(2025, 8, 10));
    expect(normalizeExpiry('NEXT-EXPIRY', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('Next-Expiry', wed)).toBe('2025-09-12');
  });

  test('semantic strings always output YYYY-MM-DD and land on a Friday', () => {
    fc.assert(
      fc.property(
        // Random reference date within a few years
        fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }),
        fc.constantFrom('next-expiry', 'this-friday', 'next-friday'),
        (refDate, keyword) => {
          const result = normalizeExpiry(keyword, refDate);
          // Output format
          expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          // Actually a Friday
          const [y, m, d] = result.split('-').map(Number);
          const resolved = new Date(Date.UTC(y, m - 1, d));
          expect(resolved.getUTCDay()).toBe(5); // Friday
          // On or after reference date
          expect(resolved.getTime()).toBeGreaterThanOrEqual(
            Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate()),
          );
        },
      ),
    );
  });
});

// ── buildOccSymbols ───────────────────────────────────────────────────

describe('buildOccSymbols', () => {
  test('every symbol in the result is a valid OCC symbol', () => {
    fc.assert(
      fc.property(
        arbUnderlying,
        arbExpiry,
        arbOptionType,
        fc.double({ min: 10, max: 500, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }),
        (underlying, expiry, optionType, mid, halfRange) => {
          const priceLow  = Math.max(1, mid - halfRange);
          const priceHigh = mid + halfRange;
          if (priceLow >= priceHigh) return; // skip degenerate ranges
          const symbols = buildOccSymbols({ underlying, expiry, optionType, priceLow, priceHigh });
          for (const sym of symbols) {
            expect(isOccOptionSymbol(sym)).toBe(true);
          }
        },
      ),
    );
  });

  test('all symbols have the correct underlying prefix', () => {
    fc.assert(
      fc.property(
        arbUnderlying,
        arbExpiry,
        arbOptionType,
        fc.double({ min: 50, max: 200, noNaN: true, noDefaultInfinity: true }),
        (underlying, expiry, optionType, price) => {
          const symbols = buildOccSymbols({ underlying, expiry, optionType, priceLow: price * 0.9, priceHigh: price * 1.1 });
          const prefix = underlying.padEnd(6, ' ');
          for (const sym of symbols) {
            expect(sym.slice(0, 6)).toBe(prefix);
          }
        },
      ),
    );
  });

  test('all symbols have the correct option type character', () => {
    fc.assert(
      fc.property(
        arbUnderlying,
        arbExpiry,
        arbOptionType,
        fc.double({ min: 50, max: 200, noNaN: true, noDefaultInfinity: true }),
        (underlying, expiry, optionType, price) => {
          const symbols = buildOccSymbols({ underlying, expiry, optionType, priceLow: price * 0.9, priceHigh: price * 1.1 });
          const expected = optionType === 'CALL' ? 'C' : 'P';
          for (const sym of symbols) {
            expect(sym[12]).toBe(expected);
          }
        },
      ),
    );
  });

  test('strikes are within [priceLow, priceHigh] or at most one interval outside', () => {
    fc.assert(
      fc.property(
        arbUnderlying,
        arbExpiry,
        arbOptionType,
        fc.double({ min: 10, max: 500, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }),
        (underlying, expiry, optionType, mid, halfRange) => {
          const priceLow  = Math.max(1, mid - halfRange);
          const priceHigh = mid + halfRange;
          if (priceLow >= priceHigh) return; // skip degenerate ranges

          // Mirror strikeInterval exactly: use (priceLow + priceHigh) / 2, same as buildOccSymbols.
          // Computing from `mid` alone fails at the $200 boundary where floating-point
          // rounding of (priceLow + priceHigh) / 2 can land on exactly 200.
          const internalMid = (priceLow + priceHigh) / 2;
          const interval = internalMid < 25 ? 0.5 : internalMid < 200 ? 0.5 : 5;

          const symbols = buildOccSymbols({ underlying, expiry, optionType, priceLow, priceHigh });
          for (const sym of symbols) {
            const parsed = parseOccSymbol(sym);
            expect(parsed).not.toBeNull();
            expect(parsed!.strike).toBeGreaterThanOrEqual(priceLow - interval);
            expect(parsed!.strike).toBeLessThanOrEqual(priceHigh + interval);
          }
        },
      ),
    );
  });
});
