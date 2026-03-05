// TODO: consolidate normalizeExpiry with src/intents/orchestrator/expiry-resolver.ts
/**
 * OCC option symbol construction, parsing, and detection.
 *
 * Format: 6-char space-padded underlying + YYMMDD + C/P + 8-digit zero-padded strike*1000
 * Example: "AAPL  260221C00250000" = AAPL Feb 21 2026 $250 Call
 */

import type { CallPutAbbrev, OptionType } from './enums.js';

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

// Maps 3-char lowercase month abbreviation → month number (1-based).
// Taking the first 3 chars of any name handles both "Jan" and "January".
const MONTH_ABBREVS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Maps 3-char lowercase day-of-week abbreviation → JS day number (0=Sun).
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Returns the day-of-month of the Nth Friday in a given month. */
function nthFriday(year: number, month: number, n: number): number {
  // month is 1-based
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=Sun
  const daysToFirstFriday = (5 - firstDow + 7) % 7;
  return 1 + daysToFirstFriday + (n - 1) * 7;
}

/**
 * Normalize a trader-supplied expiry string to YYYY-MM-DD.
 * Accepts:
 *   YYYY-MM-DD (pass-through)
 *   MM/DD, MM/DD/YY, MM/DD/YYYY
 *   M-DD, MM-DD, MM-DD-YY, MM-DD-YYYY (dash-separated)
 *   "Oct 18", "Oct 18th", "October 18", "October 18, 2025" (month-name first)
 *   "18 Oct", "18th Oct", "18 October", "18 October 2025" (day first)
 *   "Oct (10)", "October (10)" (parenthesized day — LLM sometimes emits this)
 *   "Oct", "October" (bare month → 3rd Friday, standard monthly expiry)
 *   "Friday", "Wednesday", etc. (day-of-week → next occurrence on or after referenceDate)
 *   "tomorrow", "tomorrow's", "1DTE", "1 DTE", "1-DTE" (relative → referenceDate + 1 day)
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

  // "weekly" / "weeklies" — short-dated option, same as "this week" (nearest Friday).
  if (/^weekl(y|ies)$/i.test(expiry)) {
    const dow = referenceDate.getUTCDay();
    const daysToFriday = (5 - dow + 7) % 7;
    const d = new Date(Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate() + daysToFriday,
    ));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  // "LEAP" / "Leaps" / "LEAPS" — long-dated option, 1+ year out.
  // Return referenceDate + 1 year as a canonical proxy for a standard LEAPS expiry.
  if (/^leaps?$/i.test(expiry)) {
    const d = new Date(Date.UTC(
      referenceDate.getUTCFullYear() + 1,
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate(),
    ));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  // Already canonical
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return expiry;

  // "today" / "0DTE" / "0 DTE" / "0-DTE" → referenceDate itself.
  if (/^(today|0[\s-]?DTE)$/i.test(expiry)) {
    return `${referenceDate.getUTCFullYear()}-${String(referenceDate.getUTCMonth() + 1).padStart(2, '0')}-${String(referenceDate.getUTCDate()).padStart(2, '0')}`;
  }

  // "tomorrow" / "1DTE" / "1 DTE" / "1-DTE" → referenceDate + 1 calendar day.
  if (/^(tomorrow|1[\s-]?DTE)$/i.test(expiry)) {
    const d = new Date(Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate() + 1,
    ));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  // "overnight" → next trading day (skips weekends).
  // Used when a trader says "for overnight" — position must expire on or after the next session.
  // A Friday message → Monday; Mon–Thu → next calendar day.
  if (/^overnight$/i.test(expiry)) {
    let d = new Date(Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate() + 1,
    ));
    while (d.getUTCDay() === 6 || d.getUTCDay() === 0) {
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
    }
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  // Semantic expiry strings the LLM emits instead of a real date.
  // "this week/friday", "next-expiry" → nearest Friday on or after referenceDate.
  // "next week/friday" → Friday of the FOLLOWING week (always >0 days forward from current Friday).
  // Bare "next" = following Friday (LLM strips "week" from "next week"; only real occurrence means next week).
  const isNextWeek = /^next([\s-](friday|week))?$/i.test(expiry);
  if (isNextWeek || /^(next-expiry|this[\s-]friday|this[\s-]week)$/i.test(expiry)) {
    const refYear = referenceDate.getUTCFullYear();
    const refMonth = referenceDate.getUTCMonth(); // 0-based
    const refDay = referenceDate.getUTCDate();
    const dow = referenceDate.getUTCDay(); // 0=Sun
    let daysToFriday = (5 - dow + 7) % 7; // 0 if already Friday
    // "next week/friday" means at least 7 days out when already on Friday,
    // and the following week's Friday when mid-week.
    if (isNextWeek) daysToFriday = daysToFriday === 0 ? 7 : daysToFriday + 7;
    const d = new Date(Date.UTC(refYear, refMonth, refDay + daysToFriday));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
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
    const monthNum = MONTH_ABBREVS[monthStr.toLowerCase().slice(0, 3)];
    if (!monthNum) throw new Error(`normalizeExpiry: unrecognized month name "${monthStr}" in "${expiry}"`);
    expiry = yearStr ? `${monthNum}/${dayStr}/${yearStr}` : `${monthNum}/${dayStr}`;
    // falls through to the slash-parsing logic below
  }

  // Bare word: day-of-week name OR month name.
  const bareWord = expiry.match(/^([A-Za-z]{3,9})$/i);
  if (bareWord) {
    const word = bareWord[1].toLowerCase().slice(0, 3);

    // Day-of-week: "Friday", "Wednesday", etc. → next occurrence on or after referenceDate.
    const dowNum = DOW_NAMES[word];
    if (dowNum !== undefined) {
      const dow = referenceDate.getUTCDay();
      const daysToTarget = (dowNum - dow + 7) % 7;
      const d = new Date(Date.UTC(
        referenceDate.getUTCFullYear(),
        referenceDate.getUTCMonth(),
        referenceDate.getUTCDate() + daysToTarget,
      ));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }

    // Bare month name: "Oct", "October" → 3rd Friday of that month (standard monthly expiry).
    const monthNum = MONTH_ABBREVS[word];
    if (!monthNum) throw new Error(`normalizeExpiry: unrecognized month name "${expiry}"`);
    const refYear = referenceDate.getFullYear();
    let year = refYear;
    let day = nthFriday(year, monthNum, 3);
    if (new Date(Date.UTC(year, monthNum - 1, day)) < referenceDate) {
      year = refYear + 1;
      day = nthFriday(year, monthNum, 3);
    }
    return `${year}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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

  const month = parseInt(slashParts[0], 10);
  const day = parseInt(slashParts[1], 10);
  if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`normalizeExpiry: invalid month/day in "${expiry}"`);
  }

  let year: number;
  if (slashParts.length === 3) {
    const rawYear = parseInt(slashParts[2], 10);
    if (isNaN(rawYear)) throw new Error(`normalizeExpiry: invalid year in "${expiry}"`);
    year = rawYear < 100 ? 2000 + rawYear : rawYear;
  } else {
    // MM/DD: pick the next occurrence of that calendar date on or after referenceDate
    const refYear = referenceDate.getFullYear();
    const candidate = new Date(refYear, month - 1, day);
    year = candidate >= referenceDate ? refYear : refYear + 1;
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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
