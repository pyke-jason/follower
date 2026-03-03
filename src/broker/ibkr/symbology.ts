/**
 * IBKR contract symbology: OCC symbol → conId resolution via sidecar.
 *
 * IBKR uses OCC format natively, so no format conversion is needed (unlike
 * TradeStation). We just parse OCC fields and resolve to a numeric conId
 * via the sidecar's /api/contracts/resolve endpoint.
 */

import { parseOccSymbol, isOccOptionSymbol } from '../../lib/occ-symbology.js';
import { ContractResolveResponseSchema, parseSidecarResponse } from './schemas.js';

/** Parsed OCC fields in the shape the sidecar's resolve endpoint expects. */
export type IbkrContractParams = {
  symbol: string;
  secType: 'OPT';
  expiry: string;
  strike: number;
  right: 'C' | 'P';
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

/** In-memory cache: OCC symbol → conId. ConIds are stable and never change. */
const conIdCache = new Map<string, number>();

/**
 * Resolve an OCC option symbol to an IBKR conId via the sidecar.
 * Results are cached indefinitely (conIds don't change).
 */
export async function resolveConId(occSymbol: string, sidecarUrl: string): Promise<number> {
  const cached = conIdCache.get(occSymbol);
  if (cached !== undefined) return cached;

  const params = occToIBKR(occSymbol);
  if (!params) {
    throw new Error(`resolveConId: not an OCC option symbol: "${occSymbol}"`);
  }

  const res = await fetch(`${sidecarUrl}/contracts/resolve`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
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

  conIdCache.set(occSymbol, contract.conId);
  return contract.conId;
}

/** Check if a symbol is an OCC option (re-export for convenience). */
export { isOccOptionSymbol } from '../../lib/occ-symbology.js';
