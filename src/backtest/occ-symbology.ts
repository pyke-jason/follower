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

/**
 * Normalize a trader-supplied expiry string to YYYY-MM-DD.
 * Accepts: YYYY-MM-DD (pass-through), MM/DD (year inferred), MM/DD/YY, MM/DD/YYYY.
 * For MM/DD without year: uses the next occurrence of that date on or after referenceDate.
 */
export function normalizeExpiry(expiry: string, referenceDate: Date): string {
  // Already canonical
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return expiry;

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
 *  Uses $1 increments for stocks up to $200 because exchanges list
 *  $1 strikes near ATM (not just $2.50). */
function strikeInterval(price: number): number {
  if (price < 25) return 0.5;
  if (price < 200) return 0.5;
  return 5;
}

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
