/**
 * TradeStation option symbol formatting.
 *
 * TS format: {ROOT} {YYMMDD}{C/P}{Strike}
 * Example:   MSFT 110122C27.5
 *            SPY 260306C685
 *
 * Differs from OCC standard (6-char padded root, 8-digit zero-padded strike×1000).
 * OCC is used by Databento; TS format is used by TradeStation API.
 */

import type { OptionType } from '../../lib/enums.js';

export function formatTsOptionSymbol(option: {
  underlying: string;
  expiration: string; // YYYY-MM-DD
  type: OptionType;
  strike: number;
}): string {
  const [yearStr, monthStr, dayStr] = option.expiration.split('-');
  const year = parseInt(yearStr, 10) % 100;
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) {
    throw new Error(`formatTsOptionSymbol: invalid expiration "${option.expiration}" — expected YYYY-MM-DD`);
  }

  const dateStr = `${year.toString().padStart(2, '0')}${month.toString().padStart(2, '0')}${day.toString().padStart(2, '0')}`;
  const optionType = option.type === 'CALL' ? 'C' : 'P';

  // TS uses plain decimal strike — strip trailing zeros but keep at least one decimal if fractional
  const strike = option.strike % 1 === 0
    ? option.strike.toString()
    : option.strike.toString();

  return `${option.underlying} ${dateStr}${optionType}${strike}`;
}
