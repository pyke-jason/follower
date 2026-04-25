/**
 * IBKR contract symbology: OCC symbol → conId resolution via sidecar.
 *
 * IBKR uses OCC format natively. We parse OCC fields and resolve to a
 * numeric conId via the sidecar's /api/contracts/resolve endpoint.
 */

import { parseOccSymbol, isOccOptionSymbol } from '@/lib/occ-symbology.js';
import { ContractResolveResponseSchema, parseSidecarResponse } from './schemas.js';
import type { CallPutAbbrev } from '@/lib/enums.js';

/** Parsed OCC fields in the shape the sidecar's resolve endpoint expects. */
type IbkrContractParams = {
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

type ResolvedContract = { conId: number; minTick: number };

type CachedEntry = ResolvedContract & { cachedAt: number };

/** In-memory cache: OCC symbol or "STK:<symbol>" → resolved contract. */
const contractCache = new Map<string, CachedEntry>();

/** Stock conId cache TTL. Options don't need TTL — their OCC keys include expiry. */
const STOCK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Evict all cache entries. Used in tests; also clears after corporate actions. */
export function clearContractCache(): void {
  contractCache.clear();
}

/**
 * Normalize a ticker symbol for IBKR: replace dots with spaces.
 * Multi-class shares use dot notation publicly (BRK.B, BF.B) but IBKR's
 * TWS API requires a space separator (BRK B, BF B).
 */
export function normalizeIbkrTicker(symbol: string): string {
  return symbol.replace(/\./g, ' ');
}

/**
 * Resolve an OCC option symbol to an IBKR conId + minTick via the sidecar.
 * Results are cached indefinitely (conIds don't change for a specific contract).
 * Throws if the contract multiplier is not 100 — non-standard multipliers
 * would silently produce wrong-sized orders.
 */
export async function resolveContract(occSymbol: string, sidecarUrl: string): Promise<ResolvedContract> {
  const cached = contractCache.get(occSymbol);
  if (cached !== undefined) return { conId: cached.conId, minTick: cached.minTick };

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

  // Non-100 multiplier means mini-option or non-standard contract.
  // Proceeding would silently size orders by 10x, so fail hard here.
  if (contract.multiplier !== '100') {
    throw new Error(
      `resolveContract: unexpected multiplier "${contract.multiplier}" for ${occSymbol} — expected 100. ` +
      `Non-standard multipliers cannot be traded safely.`,
    );
  }

  const resolved = { conId: contract.conId, minTick: contract.minTick };
  contractCache.set(occSymbol, { ...resolved, cachedAt: Date.now() });
  return resolved;
}

/**
 * Resolve a stock symbol to an IBKR conId + minTick via the sidecar.
 * Results are cached for 24h. Stock conIds are stable but ticker reuse after
 * delisting (rare) would serve a stale entry without a TTL.
 * Dots in the symbol are normalized to spaces (BRK.B → BRK B) per IBKR convention.
 */
export async function resolveStockContract(symbol: string, sidecarUrl: string): Promise<ResolvedContract> {
  const ibkrSymbol = normalizeIbkrTicker(symbol);
  const cacheKey = `STK:${ibkrSymbol}`;
  const cached = contractCache.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.cachedAt < STOCK_CACHE_TTL_MS) {
    return { conId: cached.conId, minTick: cached.minTick };
  }

  const res = await fetch(`${sidecarUrl}/contracts/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: ibkrSymbol,
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
  contractCache.set(cacheKey, { ...resolved, cachedAt: Date.now() });
  return resolved;
}

/** Check if a symbol is an OCC option (re-export for convenience). */
export { isOccOptionSymbol } from '@/lib/occ-symbology.js';
