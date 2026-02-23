/**
 * OCC option symbol construction, parsing, and detection.
 *
 * Format: 6-char space-padded underlying + YYMMDD + C/P + 8-digit zero-padded strike*1000
 * Example: "AAPL  260221C00250000" = AAPL Feb 21 2026 $250 Call
 */

export interface OccOptionParts {
  underlying: string;
  expiration: Date;
  type: 'CALL' | 'PUT';
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
  const optionType = symbol[12] as 'C' | 'P';
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

// Maps 3-char lowercase month abbreviation → month number (1-based).
// Taking the first 3 chars of any name handles both "Jan" and "January".
const MONTH_ABBREVS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
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
 * For formats without a year: uses the next occurrence on or after referenceDate.
 */
export function normalizeExpiry(expiry: string, referenceDate: Date): string {
  expiry = expiry.trim();

  // Already canonical
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return expiry;

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

  // Bare month name: "Oct", "October" → 3rd Friday of that month (standard monthly expiry)
  const bareMonth = expiry.match(/^([A-Za-z]{3,9})$/i);
  if (bareMonth) {
    const monthNum = MONTH_ABBREVS[bareMonth[1].toLowerCase().slice(0, 3)];
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
  type: 'CALL' | 'PUT';
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
export function strikeInterval(price: number): number {
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
  optionType: 'CALL' | 'PUT';
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
