/** Parse string/number to finite number, fallback on failure (NaN, Infinity, null, undefined). */
export function safeParseFloat(val: string | number | null | undefined, fallback = 0): number {
  if (val == null) return fallback;
  const n = typeof val === 'number' ? val : parseFloat(val);
  return Number.isFinite(n) ? n : fallback;
}

/** Math.round(val * 100) / 100 */
export function roundCents(val: number): number {
  return Math.round(val * 100) / 100;
}

/** General round to N decimal places. */
export function round(val: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(val * f) / f;
}

/** Named constant replacing magic 999.99 sentinel for infinite profit factor. */
export const PROFIT_FACTOR_INF = 999.99;

/** Format 0-1 ratio as "XX.X%" */
export function pctDisplay(val: number): string {
  return (val * 100).toFixed(1) + '%';
}

