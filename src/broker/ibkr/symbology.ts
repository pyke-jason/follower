/**
 * IBKR contract symbology: OCC symbol → conId resolution via sidecar.
 *
 * IBKR uses OCC format natively, so no format conversion is needed (unlike
 * TradeStation). We just parse OCC fields and resolve to a numeric conId
 * via the sidecar's /api/contracts/resolve endpoint.
 */

import { parseOccSymbol, isOccOptionSymbol } from '../../lib/occ-symbology.js';
import { ContractResolveResponseSchema, parseSidecarResponse } from './schemas.js';
import type { CallPutAbbrev } from '../../lib/enums.js';

/** Parsed OCC fields in the shape the sidecar's resolve endpoint expects. */
export type IbkrContractParams = {
  symbol: string;
  secType: 'OPT';
  expiry: string;
  strike: number;
  right: CallPutAbbrev;
};

/**
 * Parse an OCC symbol into the fields needed for sidecar contract resolution.
 * Returns null for non-option symbols (stocks don't need conId resolution for quotes).
 */
export function occToIBKR(occSymbol: string): IbkrContractParams | null {
  const parts = parseOccSymbol(occSymbol);
  if (!parts) return null;

  // Format expiry as YYYYMMDD (sidecar expects this)
  const y = parts.expiration.getUTCFullYear();
  const m = String(parts.expiration.getUTCMonth() + 1).padStart(2, '0');
  const d = String(parts.expiration.getUTCDate()).padStart(2, '0');

  return {
    symbol: parts.underlying,
    secType: 'OPT',
    expiry: `${y}${m}${d}`,
    strike: parts.strike,
    right: parts.type === 'CALL' ? 'C' : 'P',
  };
}

export type ResolvedContract = { conId: number; minTick: number };

/** In-memory cache: OCC symbol → resolved contract. ConIds and minTick are stable per contract. */
const contractCache = new Map<string, ResolvedContract>();

/**
 * Resolve an OCC option symbol to an IBKR conId + minTick via the sidecar.
 * Results are cached indefinitely (conIds don't change).
 */
export async function resolveContract(occSymbol: string, sidecarUrl: string): Promise<ResolvedContract> {
  const cached = contractCache.get(occSymbol);
  if (cached !== undefined) return cached;

  const params = occToIBKR(occSymbol);
  if (!params) {
    throw new Error(`resolveContract: not an OCC option symbol: "${occSymbol}"`);
  }

  const res = await fetch(`${sidecarUrl}/contracts/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: params.symbol,
      secType: params.secType,
      expiry: params.expiry,
      strike: params.strike,
      right: params.right,
      exchange: 'SMART',
      currency: 'USD',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IBKR sidecar ${res.status}: contract resolve failed for ${occSymbol}: ${text}`);
  }

  const data = await res.json();
  const contract = parseSidecarResponse(
    ContractResolveResponseSchema,
    data,
    `POST /api/contracts/resolve (${occSymbol})`,
  );

  const resolved = { conId: contract.conId, minTick: contract.minTick };
  contractCache.set(occSymbol, resolved);
  return resolved;
}

/**
 * Resolve a stock symbol to an IBKR conId + minTick via the sidecar.
 * Results are cached indefinitely (stock conIds don't change).
 */
export async function resolveStockContract(symbol: string, sidecarUrl: string): Promise<ResolvedContract> {
  const cacheKey = `STK:${symbol}`;
  const cached = contractCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const res = await fetch(`${sidecarUrl}/contracts/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol,
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IBKR sidecar ${res.status}: stock contract resolve failed for ${symbol}: ${text}`);
  }

  const data = await res.json();
  const contract = parseSidecarResponse(
    ContractResolveResponseSchema,
    data,
    `POST /api/contracts/resolve (STK:${symbol})`,
  );

  const resolved = { conId: contract.conId, minTick: contract.minTick };
  contractCache.set(cacheKey, resolved);
  return resolved;
}

/** Check if a symbol is an OCC option (re-export for convenience). */
export { isOccOptionSymbol } from '../../lib/occ-symbology.js';
