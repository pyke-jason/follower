/**
 * Trade-level helpers for strategy-derived constants.
 *
 * Single source of truth for contract multiplier, asset type, quantity
 * fallback, and spread geometry — avoids scattering strategy checks everywhere.
 */

import type { TradeLeg } from '../db/schema.js';

/** Options contracts represent 100 shares; stock is 1:1. */
export function contractMultiplier(strategy: string): number {
  return strategy === 'STOCK' ? 1 : 100;
}

/** Broker asset type: equity or option. */
export function assetType(strategy: string): 'EQ' | 'OP' {
  return strategy === 'STOCK' ? 'EQ' : 'OP';
}

/** Trade quantity with null→1 coercion for legacy DB rows. Write-time validation lives in recordTrade(). */
export function tradeQty(quantity: number | null | undefined): number {
  return quantity ?? 1;
}

/** Notional value of a position: |entryPrice| × qty × contractMultiplier. */
export function notionalValue(entryPrice: string | number | null, quantity: number | null | undefined, strategy: string): number {
  const entry = typeof entryPrice === 'number' ? entryPrice : parseFloat(entryPrice ?? '');
  if (!isFinite(entry)) return 0;
  return Math.abs(entry * tradeQty(quantity) * contractMultiplier(strategy));
}

/** Absolute difference between the two strikes of a vertical spread. */
export function getSpreadWidth(legs: TradeLeg[]): number {
  const strikes = legs.filter(l => l.type !== 'STOCK').map(l => l.strike);
  if (strikes.length < 2) return 0;
  return Math.abs(strikes[0] - strikes[1]);
}
