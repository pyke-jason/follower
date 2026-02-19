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
  const dateStr = `${year.toString().padStart(2, '0')}${month
    .toString()
    .padStart(2, '0')}${day.toString().padStart(2, '0')}`;

  const optionType = option.type === 'CALL' ? 'C' : 'P';

  const strikeInt = Math.round(option.strike * 1000);
  const strikeStr = strikeInt.toString().padStart(8, '0');

  return `${underlying}${dateStr}${optionType}${strikeStr}`;
}

/** Pick a strike interval based on underlying price. */
function strikeInterval(price: number): number {
  if (price < 25) return 0.5;
  if (price < 50) return 1;
  if (price < 200) return 2.5;
  if (price < 500) return 5;
  return 10;
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
