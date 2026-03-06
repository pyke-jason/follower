/**
 * Trade-level helpers for strategy-derived constants.
 *
 * Single source of truth for contract multiplier, asset type, quantity
 * fallback, and spread geometry — avoids scattering strategy checks everywhere.
 */

import type { Strategy, SpreadStrategy, AssetType } from './enums.js';
import type { TradeLeg } from '../db/schema.js';
import type { Leg, OptionLeg } from '../intents/orchestrator/types.js';

export type { SpreadStrategy };

/** Filter orchestrator Leg[] to only OptionLeg[]. */
export function getOptionLegs(legs: Leg[]): OptionLeg[] {
  return legs.filter((l): l is OptionLeg => l.type === 'option');
}

const SPREAD_STRATEGIES: ReadonlySet<Strategy> = new Set<Strategy>(['CDS', 'PDS', 'PCS', 'CCS']);

/** True if the strategy is a vertical spread (CDS, PDS, PCS, CCS). */
export function isSpread(s: Strategy): s is SpreadStrategy { return SPREAD_STRATEGIES.has(s); }

/** Options contracts represent 100 shares; stock is 1:1. */
export function contractMultiplier(strategy: string): number {
  return strategy === 'STOCK' ? 1 : 100;
}

/** Broker asset type: equity or option. */
export function assetType(strategy: string): AssetType {
  return strategy === 'STOCK' ? 'EQ' : 'OP';
}

/** Trade quantity with null→1 coercion for defensive reads. Write-time validation lives in recordTrade(). */
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

/**
 * Format an ISO expiry date as compact "M/D" (e.g. "10/17").
 * Returns empty string for sentinel/missing expiries.
 */
function fmtExpiry(expiry: string): string {
  if (!expiry || expiry === '2099-01-01') return '';
  const [, m, d] = expiry.split('-');
  if (!m || !d) return '';
  return `${parseInt(m)}/${parseInt(d)}`;
}

/**
 * Unified friendly summary for a trade's option legs.
 *
 * Format: "{strike}{strategy} {expiry}"
 * Examples:
 *   CALL  → "200C 10/17"
 *   PUT   → "150P 10/17"
 *   CDS   → "190/195CDS 10/24"
 *   PDS   → "347.5/342.5PDS 9/12"
 *   PCS   → "150/145PCS 10/24"
 *   STOCK → null (no summary needed)
 */
export function formatLegsSummary(legs: TradeLeg[], strategy: string): string | null {
  if (strategy === 'STOCK' || !legs.length) return null;

  const optionLegs = legs.filter(l => l.type !== 'STOCK');
  if (!optionLegs.length) return null;

  const expiry = fmtExpiry(optionLegs[0].expiry);

  if (optionLegs.length === 1) {
    // Single leg: "200C 10/17" or "150P 10/17"
    const typeSuffix = optionLegs[0].type === 'CALL' ? 'C' : optionLegs[0].type === 'PUT' ? 'P' : '';
    const desc = `${optionLegs[0].strike}${typeSuffix}`;
    return expiry ? `${desc} ${expiry}` : desc;
  }

  // Spreads: "190/195CDS 10/24" or "347.5/342.5PDS 9/12"
  const buyLeg = optionLegs.find(l => l.action === 'BUY') ?? optionLegs[0];
  const sellLeg = optionLegs.find(l => l.action === 'SELL') ?? optionLegs[1];
  const desc = `${buyLeg.strike}/${sellLeg.strike}${strategy}`;
  return expiry ? `${desc} ${expiry}` : desc;
}
