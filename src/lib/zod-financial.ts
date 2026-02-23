import { z } from 'zod';

/** Entry prices, option strikes — must be positive. */
export const zPrice = z.number().positive();

/** Exit prices — 0 is valid (worthless expiry). */
export const zNonNegPrice = z.number().nonnegative();

/** String→number coercion for API responses. */
export const zCoercePrice = z.coerce.number().nonnegative();

/** Percentages expressed as 0-1. */
export const zPct01 = z.number().min(0).max(1);

/** PnL, greeks, or any value that can be negative. Finite by default in Zod v4. */
export const zFiniteNum = z.number();
