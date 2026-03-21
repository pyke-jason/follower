/**
 * OCC option symbol construction, parsing, and detection.
 *
 * Format: 6-char space-padded underlying + YYMMDD + C/P + 8-digit zero-padded strike*1000
 * Example: "AAPL  260221C00250000" = AAPL Feb 21 2026 $250 Call
 */

import type { CallPutAbbrev, OptionType } from './enums.js';
import {
  toDateKeyET,
  getETComponents,
  ymd,
  etAnchor,
  nextFridayET,
  nextWeekFriday,
  thirdFriday,
  addBusinessDays,
} from './et-date.js';

export interface OccOptionParts {
  underlying: string;
  expiration: Date;
  type: OptionType;
  strike: number;
}

export function isOccOptionSymbol(symbol: string): boolean {
  if (symbol.length !== 21) return false;

  const optionType = symbol[12];
  if (optionType !== 'C' && optionType !== 'P') return false;

  const datePart = symbol.slice(6, 12);
  if (!/^\d{6}$/.test(datePart)) return false;

  const strikePart = symbol.slice(13, 21);
  if (!/^\d{8}$/.test(strikePart)) return false;

  return true;
}

export function parseOccSymbol(symbol: string): OccOptionParts | null {
  if (!isOccOptionSymbol(symbol)) return null;

  const underlying = symbol.slice(0, 6).trim();
  const dateStr = symbol.slice(6, 12);
  const optionType = symbol[12] as CallPutAbbrev;
  const strikeStr = symbol.slice(13, 21);

  const year = 2000 + parseInt(dateStr.slice(0, 2), 10);
  const month = parseInt(dateStr.slice(2, 4), 10) - 1;
  const day = parseInt(dateStr.slice(4, 6), 10);
  // 20:00 UTC = 4:00 PM ET (EDT) — OCC equity option settlement time
  const expiration = new Date(Date.UTC(year, month, day, 20));

  const strike = parseInt(strikeStr, 10) / 1000;

  return {
    underlying,
    expiration,
    type: optionType === 'C' ? 'CALL' : 'PUT',
    strike,
  };
}

/**
 * Extract the underlying ticker from an OCC option symbol or return the symbol
 * as-is if it's already a plain ticker.
 *
 * OCC format: "AAPL  260307C00180000" — leading alpha chars before the date.
 * Spaces between the ticker and date are variable (0-5).
 */
export function extractUnderlying(occOrTicker: string): string {
  const match = /^([A-Z]{1,6})\s*\d{6}[CP]/i.exec(occOrTicker);
  return match ? match[1] : occOrTicker;
}

// Maps lowercase month name/abbreviation → 0-based month index (for et-date helpers).
// Handles both abbreviated ("jan") and full ("january") forms, plus "sept".
const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Resolve a month string to a 0-based month index, or undefined. */
function resolveMonth(s: string): number | undefined {
  return MONTH_MAP[s.toLowerCase()];
}

// Maps lowercase day-of-week name → JS day number (0=Sun).
// Handles both abbreviated ("mon") and full ("monday") forms.
const DOW_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/**
 * Normalize a trader-supplied expiry string to YYYY-MM-DD.
 *
 * Uses ET-aware date math (via et-date helpers) so results are correct
 * regardless of UTC offset / DST. All relative keywords ("tomorrow",
 * "next friday", etc.) resolve relative to the ET calendar day of
 * referenceDate.
 *
 * Accepts:
 *   YYYY-MM-DD (pass-through)
 *   MM/DD, MM/DD/YY, MM/DD/YYYY
 *   M-DD, MM-DD, MM-DD-YY, MM-DD-YYYY (dash-separated)
 *   "Oct 18", "Oct 18th", "October 18", "October 18, 2025" (month-name first)
 *   "18 Oct", "18th Oct", "18 October", "18 October 2025" (day first)
 *   "Oct (10)", "October (10)" (parenthesized day — LLM sometimes emits this)
 *   "Oct", "October" (bare month → 3rd Friday, standard monthly expiry)
 *   "Friday", "Wednesday", etc. (day-of-week → next occurrence on or after referenceDate)
 *   "next monday", "next tuesday", etc. (strictly next week's occurrence)
 *   "tomorrow", "tomorrow's", "1DTE", "1 DTE", "1-DTE" (relative → next calendar day)
 *   "today", "0DTE" (referenceDate itself)
 *   "overnight" (next business day, holiday-aware)
 *   "weekly", "weeklies" (this week's Friday)
 *   "LEAP", "LEAPS" (3rd Friday of same month, 1 year out)
 *   "this week", "this friday", "next-expiry" (this week's Friday)
 *   "next week", "next friday", "next" (next week's Friday)
 *
 * For formats without a year: uses the next occurrence on or after referenceDate.
 */
export function normalizeExpiry(expiry: string, referenceDate: Date): string {
  expiry = expiry.trim();

  // Strip possessive suffix so "tomorrow's" → "tomorrow" (ASCII and curly apostrophes)
  expiry = expiry.replace(/['\u2018\u2019]s$/i, '');

  // Strip trailing "expiration"/"expiry"/"exp" — LLM may include these with the date text
  expiry = expiry.replace(/\s+(expiration|expiry|exp)$/i, '');

  // Junk placeholder the LLM emits when no expiry is stated
  if (expiry === '-' || expiry === '') {
    throw new Error('normalizeExpiry: expiry placeholder — no date stated');
  }

  // Already canonical
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return expiry;

  // ── Relative keywords ────────────────────────────────────────────

  // "today" / "0DTE" / "0 DTE" / "0-DTE" → ET calendar day of referenceDate.
  if (/^(today|0[\s-]?DTE)$/i.test(expiry)) {
    return toDateKeyET(referenceDate);
  }

  // "tomorrow" / "1DTE" / "1 DTE" / "1-DTE" → next calendar day.
  if (/^(tomorrow|1[\s-]?DTE)$/i.test(expiry)) {
    const anchor = etAnchor(referenceDate);
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + 1);
    return toDateKeyET(d);
  }

  // "overnight" → next business day (holiday-aware).
  if (/^overnight$/i.test(expiry)) {
    return toDateKeyET(addBusinessDays(referenceDate, 1));
  }

  // "weekly" / "weeklies" — nearest Friday on or after referenceDate.
  if (/^weekl(y|ies)$/i.test(expiry)) {
    return toDateKeyET(nextFridayET(referenceDate));
  }

  // "LEAP" / "Leaps" / "LEAPS" — 3rd Friday of the same month, 1 year out.
  if (/^leaps?$/i.test(expiry)) {
    const { year, month } = getETComponents(referenceDate);
    return toDateKeyET(thirdFriday(year + 1, month - 1));
  }

  // ── Friday-relative keywords ──────────────────────────────────────

  // "this week/friday", "next-expiry" → nearest Friday on or after referenceDate.
  if (/^(next-expiry|this[\s-](friday|week))$/i.test(expiry)) {
    return toDateKeyET(nextFridayET(referenceDate));
  }

  // "next week", "next friday", bare "next" → next week's Friday.
  if (/^next([\s-](friday|week))?$/i.test(expiry)) {
    return toDateKeyET(nextWeekFriday(referenceDate));
  }

  // "next monday", "next tuesday", etc. → strictly next week's occurrence.
  const nextDayMatch = expiry.match(/^next[\s-]+(\w+)$/i);
  if (nextDayMatch) {
    const dayName = nextDayMatch[1].toLowerCase();
    const targetDow = DOW_NAMES[dayName];
    if (targetDow !== undefined) {
      const anchor = etAnchor(referenceDate);
      const currentDow = anchor.getUTCDay();
      // Days until next Monday (start of next week)
      const daysToNextMonday = (8 - currentDow) % 7 || 7;
      const result = new Date(anchor);
      result.setUTCDate(result.getUTCDate() + daysToNextMonday);
      // From Monday, advance to the target day
      const deltaFromMonday = (targetDow - 1 + 7) % 7;
      result.setUTCDate(result.getUTCDate() + deltaFromMonday);
      return toDateKeyET(result);
    }
  }

  // "Oct (10)" / "October (10)" → "Oct 10" (parenthesized day notation)
  expiry = expiry.replace(/^([A-Za-z]+)\s+\((\d{1,2})\)/, '$1 $2');

  // Month-name formats: "Oct 18", "Oct 18th", "October 18, 2025", "18th October 2025", etc.
  const monthFirst = expiry.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:[,\s]+(\d{2,4}))?$/i);
  const dayFirst   = expiry.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:[,\s]+(\d{2,4}))?$/i);
  const nameMatch  = monthFirst ?? dayFirst;
  if (nameMatch) {
    const [, a, b, yearStr] = nameMatch;
    const [monthStr, dayStr] = monthFirst ? [a, b] : [b, a];
    const monthIdx = resolveMonth(monthStr);
    if (monthIdx === undefined) throw new Error(`normalizeExpiry: unrecognized month name "${monthStr}" in "${expiry}"`);
    const monthNum = monthIdx + 1; // 1-based for slash format
    expiry = yearStr ? `${monthNum}/${dayStr}/${yearStr}` : `${monthNum}/${dayStr}`;
    // falls through to the slash-parsing logic below
  }

  // Bare word: day-of-week name OR month name.
  const bareWord = expiry.match(/^([A-Za-z]{3,9})$/i);
  if (bareWord) {
    const word = bareWord[1].toLowerCase();

    // Day-of-week: "Friday", "Wednesday", etc. → next occurrence on or after referenceDate.
    const dowNum = DOW_NAMES[word] ?? DOW_NAMES[word.slice(0, 3)];
    if (dowNum !== undefined) {
      const anchor = etAnchor(referenceDate);
      const dow = anchor.getUTCDay();
      const daysToTarget = (dowNum - dow + 7) % 7;
      const d = new Date(anchor);
      d.setUTCDate(d.getUTCDate() + daysToTarget);
      return toDateKeyET(d);
    }

    // Bare month name: "Oct", "October" → 3rd Friday of that month (standard monthly expiry).
    const monthIdx = resolveMonth(word);
    if (monthIdx === undefined) throw new Error(`normalizeExpiry: unrecognized month name "${expiry}"`);
    let year = getETComponents(referenceDate).year;
    const candidate = thirdFriday(year, monthIdx);
    if (candidate < referenceDate) {
      year++;
    }
    return toDateKeyET(thirdFriday(year, monthIdx));
  }

  // Normalize dash-separated M-DD / MM-DD / MM-DD-YY / MM-DD-YYYY to slash form
  // Only treat as dash-separated if the first segment is 1-2 digits (month), not 4 (year already handled above)
  const dashMatch = expiry.match(/^(\d{1,2})-(\d{1,2})(?:-(\d{2,4}))?$/);
  if (dashMatch) {
    expiry = dashMatch[3]
      ? `${dashMatch[1]}/${dashMatch[2]}/${dashMatch[3]}`
      : `${dashMatch[1]}/${dashMatch[2]}`;
  }

  const slashParts = expiry.split('/');
  if (slashParts.length < 2 || slashParts.length > 3) {
    throw new Error(`normalizeExpiry: unrecognized expiry format "${expiry}"`);
  }

  const rawMonth = parseInt(slashParts[0], 10);
  const day = parseInt(slashParts[1], 10);
  if (isNaN(rawMonth) || isNaN(day) || rawMonth < 1 || rawMonth > 12 || day < 1 || day > 31) {
    throw new Error(`normalizeExpiry: invalid month/day in "${expiry}"`);
  }

  let year: number;
  if (slashParts.length === 3) {
    const rawYear = parseInt(slashParts[2], 10);
    if (isNaN(rawYear)) throw new Error(`normalizeExpiry: invalid year in "${expiry}"`);
    year = rawYear < 100 ? 2000 + rawYear : rawYear;
  } else {
    // MM/DD: pick the next occurrence of that calendar date on or after referenceDate (ET)
    year = getETComponents(referenceDate).year;
    if (ymd(year, rawMonth, day) < toDateKeyET(referenceDate)) year++;
  }

  return ymd(year, rawMonth, day);
}

export function formatOccSymbol(option: {
  underlying: string;
  expiration: string; // YYYY-MM-DD
  type: OptionType;
  strike: number;
}): string {
  const underlying = option.underlying.padEnd(6, ' ');

  // Parse YYYY-MM-DD expiration string
  const [yearStr, monthStr, dayStr] = option.expiration.split('-');
  const year = parseInt(yearStr, 10) % 100;
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) {
    throw new Error(`formatOccSymbol: invalid expiration "${option.expiration}" — expected YYYY-MM-DD`);
  }
  const dateStr = `${year.toString().padStart(2, '0')}${month
    .toString()
    .padStart(2, '0')}${day.toString().padStart(2, '0')}`;

  const optionType = option.type === 'CALL' ? 'C' : 'P';

  const strikeInt = Math.round(option.strike * 1000);
  const strikeStr = strikeInt.toString().padStart(8, '0');

  return `${underlying}${dateStr}${optionType}${strikeStr}`;
}

/** Pick a strike interval based on underlying price.
 *  Uses $0.50 increments for stocks up to $200 because exchanges list
 *  $0.50/$1 strikes near ATM. */
function strikeInterval(price: number): number {
  if (price < 25) return 0.5;
  if (price < 200) return 0.5;
  return 5;
}

// ── Strike Inference ─────────────────────────────────────────────────

export type InferredSpread = {
  longStrike: number;
  shortStrike: number;
  width: number;
};

/** Spread width heuristic based on stock price. */
function spreadWidth(price: number): number {
  if (price < 50) return 2.5;
  if (price < 200) return 5;
  return 10;
}

/**
 * Infer ATM spread strikes from stock price + strategy.
 * Pure function — no I/O, no LLM calls.
 */
export function inferATMSpread(
  stockPrice: number,
  strategy: 'CDS' | 'PDS',
): InferredSpread {
  const interval = strikeInterval(stockPrice);
  const atm = Math.round(stockPrice / interval) * interval;
  const width = spreadWidth(stockPrice);

  if (strategy === 'CDS') {
    return { longStrike: atm, shortStrike: atm + width, width };
  }
  return { longStrike: atm, shortStrike: atm - width, width };
}

/** Infer ATM strike for naked call/put. */
export function inferATMStrike(stockPrice: number): number {
  const interval = strikeInterval(stockPrice);
  return Math.round(stockPrice / interval) * interval;
}

// ── OCC Symbol Generation ───────────────────────────────────────────

/**
 * Generate candidate OCC symbols for a given underlying, expiry, option type,
 * and strike range. Uses standard strike intervals based on price.
 * Some symbols may not correspond to real contracts — that's fine,
 * Databento returns no data for non-existent symbols.
 */
export function buildOccSymbols(params: {
  underlying: string;
  expiry: string;       // YYYY-MM-DD
  optionType: OptionType;
  priceLow: number;
  priceHigh: number;
}): string[] {
  const interval = strikeInterval((params.priceLow + params.priceHigh) / 2);
  const startStep = Math.floor(params.priceLow / interval);
  const endStep = Math.ceil(params.priceHigh / interval);

  const symbols: string[] = [];
  for (let step = startStep; step <= endStep; step++) {
    const strike = step * interval;
    if (strike <= 0) continue;
    symbols.push(formatOccSymbol({
      underlying: params.underlying,
      expiration: params.expiry,
      type: params.optionType,
      strike,
    }));
  }
  return symbols;
}
