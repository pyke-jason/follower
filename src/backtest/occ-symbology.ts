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
  const expiration = new Date(Date.UTC(year, month, day));

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
