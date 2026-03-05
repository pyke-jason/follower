/**
 * Property-based and unit tests for OCC symbology utilities.
 *
 * Pure functions — no DB, no broker needed.
 * Uses fast-check to verify round-trip and structural invariants.
 */

import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import type { OptionType } from '../lib/enums.js';
import {
  formatOccSymbol,
  parseOccSymbol,
  isOccOptionSymbol,
  normalizeExpiry,
  buildOccSymbols,
} from '../lib/occ-symbology.js';

// ── Arbitraries ───────────────────────────────────────────────────────

/** Underlying ticker: 1–5 uppercase letters */
const arbUnderlying = fc.stringMatching(/^[A-Z]{1,5}$/)
  .filter(s => s.length >= 1);

/** Strike price: typical option range, multiple of 0.5 to avoid floating-point drift */
const arbStrike = fc.integer({ min: 1, max: 4000 }).map(n => n * 0.5);

const arbOptionType: fc.Arbitrary<OptionType> = fc.constantFrom('CALL', 'PUT');

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

  test('this-week strings resolve to next Friday on or after refDate', () => {
    // Wednesday 2025-09-10 → this Friday is 2025-09-12
    const wed = new Date(Date.UTC(2025, 8, 10));
    expect(normalizeExpiry('next-expiry', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('this-friday', wed)).toBe('2025-09-12');
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

  test('this-week semantic strings always output YYYY-MM-DD and land on a Friday', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }).filter(d => !isNaN(d.getTime())),
        fc.constantFrom('next-expiry', 'this-friday', 'this-week'),
        (refDate, keyword) => {
          const result = normalizeExpiry(keyword, refDate);
          expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

  test('next-week semantic strings always land on a Friday strictly after refDate week', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }).filter(d => !isNaN(d.getTime())),
        fc.constantFrom('next-week', 'next-friday', 'next friday'),
        (refDate, keyword) => {
          const result = normalizeExpiry(keyword, refDate);
          expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          const [y, m, d] = result.split('-').map(Number);
          const resolved = new Date(Date.UTC(y, m - 1, d));
          expect(resolved.getUTCDay()).toBe(5); // Friday
          // Always strictly after reference date (at least 1 day forward)
          expect(resolved.getTime()).toBeGreaterThan(
            Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate()),
          );
        },
      ),
    );
  });

  // ── New relative-date keywords ──

  test('today resolves to referenceDate itself', () => {
    const ref = new Date(Date.UTC(2025, 8, 10)); // Wed Sep 10
    expect(normalizeExpiry('today', ref)).toBe('2025-09-10');
    expect(normalizeExpiry('TODAY', ref)).toBe('2025-09-10');
    expect(normalizeExpiry('0DTE', ref)).toBe('2025-09-10');
    expect(normalizeExpiry('0 DTE', ref)).toBe('2025-09-10');
    expect(normalizeExpiry('0-DTE', ref)).toBe('2025-09-10');
  });

  test('tomorrow resolves to referenceDate + 1 day', () => {
    const ref = new Date(Date.UTC(2025, 8, 10)); // Wed Sep 10
    expect(normalizeExpiry('tomorrow', ref)).toBe('2025-09-11');
    expect(normalizeExpiry('TOMORROW', ref)).toBe('2025-09-11');
  });

  test('1DTE variants resolve to referenceDate + 1 day', () => {
    const ref = new Date(Date.UTC(2025, 9, 16)); // Thu Oct 16
    expect(normalizeExpiry('1DTE', ref)).toBe('2025-10-17');
    expect(normalizeExpiry('1 DTE', ref)).toBe('2025-10-17');
    expect(normalizeExpiry('1-DTE', ref)).toBe('2025-10-17');
    expect(normalizeExpiry('1dte', ref)).toBe('2025-10-17');
  });

  test('this week / this friday resolve to next Friday on or after refDate', () => {
    const wed = new Date(Date.UTC(2025, 8, 10)); // Wed Sep 10 → Fri Sep 12
    expect(normalizeExpiry('this week', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('this-week', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('this friday', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('this Friday', wed)).toBe('2025-09-12');
  });

  test('next week / next friday resolve to the FOLLOWING week Friday', () => {
    const wed = new Date(Date.UTC(2025, 8, 10)); // Wed Sep 10 → next week Fri = Sep 19
    expect(normalizeExpiry('next week', wed)).toBe('2025-09-19');
    expect(normalizeExpiry('next-week', wed)).toBe('2025-09-19');
    expect(normalizeExpiry('next friday', wed)).toBe('2025-09-19');
    expect(normalizeExpiry('next Friday', wed)).toBe('2025-09-19');
  });

  test('next week on a Friday resolves to the following Friday', () => {
    const fri = new Date(Date.UTC(2025, 8, 19)); // Fri Sep 19 → Sep 26
    expect(normalizeExpiry('next week', fri)).toBe('2025-09-26');
    expect(normalizeExpiry('next friday', fri)).toBe('2025-09-26');
  });

  // ── Weekly keyword ──

  test('weekly/weeklies resolve to nearest Friday on or after refDate', () => {
    const wed = new Date(Date.UTC(2025, 8, 10)); // Wed Sep 10 → Fri Sep 12
    expect(normalizeExpiry('weekly', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('Weekly', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('WEEKLY', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('weeklies', wed)).toBe('2025-09-12');
    expect(normalizeExpiry('Weeklies', wed)).toBe('2025-09-12');
  });

  test('weekly on Friday resolves to that same Friday', () => {
    const fri = new Date(Date.UTC(2025, 8, 12)); // Fri Sep 12
    expect(normalizeExpiry('weekly', fri)).toBe('2025-09-12');
  });

  test('weekly on Saturday resolves to next Friday', () => {
    const sat = new Date(Date.UTC(2025, 8, 13)); // Sat Sep 13 → Fri Sep 19
    expect(normalizeExpiry('weekly', sat)).toBe('2025-09-19');
  });

  test('bare "next" resolves to following Friday (same as "next week")', () => {
    const wed = new Date(Date.UTC(2025, 8, 10)); // Wed Sep 10 → next week Fri = Sep 19
    expect(normalizeExpiry('next', wed)).toBe('2025-09-19');
    const fri = new Date(Date.UTC(2025, 8, 5)); // Fri Sep 5 → Sep 12
    expect(normalizeExpiry('next', fri)).toBe('2025-09-12');
  });

  // ── Suffix stripping ──

  test("tomorrow's resolves same as tomorrow", () => {
    const ref = new Date(Date.UTC(2025, 8, 16)); // Tue Sep 16
    expect(normalizeExpiry("tomorrow's", ref)).toBe('2025-09-17');
    expect(normalizeExpiry('tomorrow\u2019s', ref)).toBe('2025-09-17'); // curly apostrophe
  });

  test('strips trailing "expiration"/"expiry"/"exp" before parsing', () => {
    const fri = new Date(Date.UTC(2025, 8, 19)); // Fri Sep 19
    expect(normalizeExpiry('next week expiration', fri)).toBe('2025-09-26');
    expect(normalizeExpiry('next friday expiry', fri)).toBe('2025-09-26');
    expect(normalizeExpiry('Oct 3 exp', fri)).toBe('2025-10-03');
    expect(normalizeExpiry('LEAP expiration', fri)).toBe('2026-09-19');
  });

  // ── Day-of-week names ──

  test('bare day-of-week name resolves to next occurrence on or after refDate', () => {
    const wed = new Date(Date.UTC(2025, 8, 10)); // Wed Sep 10
    expect(normalizeExpiry('Wednesday', wed)).toBe('2025-09-10'); // same day → today
    expect(normalizeExpiry('Friday', wed)).toBe('2025-09-12');    // 2 days later
    expect(normalizeExpiry('Thursday', wed)).toBe('2025-09-11');
    expect(normalizeExpiry('friday', wed)).toBe('2025-09-12');    // lowercase
    expect(normalizeExpiry('FRIDAY', wed)).toBe('2025-09-12');    // uppercase
  });

  // ── LEAP keyword ──

  test('LEAP / Leaps / LEAPS resolve to referenceDate + 1 year', () => {
    const ref = new Date(Date.UTC(2025, 8, 5)); // Sep 5 2025 → Sep 5 2026
    expect(normalizeExpiry('LEAP',  ref)).toBe('2026-09-05');
    expect(normalizeExpiry('Leaps', ref)).toBe('2026-09-05');
    expect(normalizeExpiry('LEAPS', ref)).toBe('2026-09-05');
    expect(normalizeExpiry('leap',  ref)).toBe('2026-09-05');
  });

  test('LEAP output is always >= 6 months from refDate', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }).filter(d => !isNaN(d.getTime())),
        fc.constantFrom('LEAP', 'Leaps', 'LEAPS'),
        (refDate, keyword) => {
          const result = normalizeExpiry(keyword, refDate);
          expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          const [y, m, d] = result.split('-').map(Number);
          const resolved = new Date(Date.UTC(y, m - 1, d));
          const sixMonthsOut = new Date(Date.UTC(
            refDate.getUTCFullYear(),
            refDate.getUTCMonth() + 6,
            refDate.getUTCDate(),
          ));
          expect(resolved.getTime()).toBeGreaterThanOrEqual(sixMonthsOut.getTime());
        },
      ),
    );
  });

  // ── overnight keyword ──

  test('overnight on Friday skips to Monday (Sep 5 → Sep 8)', () => {
    const fri = new Date(Date.UTC(2025, 8, 5)); // Fri Sep 5 2025
    expect(normalizeExpiry('overnight', fri)).toBe('2025-09-08');
    expect(normalizeExpiry('Overnight', fri)).toBe('2025-09-08');
    expect(normalizeExpiry('OVERNIGHT', fri)).toBe('2025-09-08');
  });

  test('overnight on weekday resolves to next calendar day', () => {
    const mon = new Date(Date.UTC(2025, 8, 8));  // Mon Sep 8  → Tue Sep 9
    const wed = new Date(Date.UTC(2025, 8, 10)); // Wed Sep 10 → Thu Sep 11
    const thu = new Date(Date.UTC(2025, 8, 11)); // Thu Sep 11 → Fri Sep 12
    expect(normalizeExpiry('overnight', mon)).toBe('2025-09-09');
    expect(normalizeExpiry('overnight', wed)).toBe('2025-09-11');
    expect(normalizeExpiry('overnight', thu)).toBe('2025-09-12');
  });

  test('overnight on Saturday skips to Monday', () => {
    const sat = new Date(Date.UTC(2025, 8, 6)); // Sat Sep 6 → Mon Sep 8
    expect(normalizeExpiry('overnight', sat)).toBe('2025-09-08');
  });

  test('overnight result is always a weekday', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }).filter(d => !isNaN(d.getTime())),
        (refDate) => {
          const result = normalizeExpiry('overnight', refDate);
          expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          const [y, m, d] = result.split('-').map(Number);
          const resolved = new Date(Date.UTC(y, m - 1, d));
          const dow = resolved.getUTCDay();
          expect(dow).not.toBe(0); // not Sunday
          expect(dow).not.toBe(6); // not Saturday
        },
      ),
    );
  });

  // ── Junk placeholders ──

  test('dash placeholder throws a recognizable error', () => {
    const ref = new Date(Date.UTC(2025, 8, 10));
    expect(() => normalizeExpiry('-', ref)).toThrow('no date stated');
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
