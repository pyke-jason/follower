import { z } from 'zod';
import type { ZodError } from 'zod';

/** Format a ZodError into a compact human-readable string with field paths.
 *  e.g. "hd.ts_event: expected string, received null; bid_px_00: expected number, received undefined" */
export function formatZodError(err: ZodError): string {
  return err.issues.map(i => {
    const path = i.path.length > 0 ? i.path.join('.') : '(root)';
    const detail = 'expected' in i
      ? `expected ${(i as any).expected}, received ${(i as any).received}`
      : i.message;
    return `${path}: ${detail}`;
  }).join('; ');
}

/** Entry prices, option strikes — must be positive. */
export const zPrice = z.number().positive();
export const zPriceOpt = zPrice.optional();

/** Exit prices — 0 is valid (worthless expiry). */
export const zNonNegPrice = z.number().nonnegative();

/** String→number coercion for API responses. */
export const zCoercePrice = z.coerce.number().nonnegative();

/** Contracts or shares — positive integer. */
export const zQuantity = z.number().int().positive();

/** Percentages expressed as 0-1. */
export const zPct01 = z.number().min(0).max(1);

/** PnL, greeks, or any value that can be negative. Finite by default in Zod v4. */
export const zFiniteNum = z.number();
