/**
 * Trade-level helpers for strategy-derived constants.
 *
 * Single source of truth for contract multiplier, asset type, and quantity
 * fallback — avoids scattering `strategy === 'STOCK' ? 1 : 100` everywhere.
 */

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
