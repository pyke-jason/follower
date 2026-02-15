import { z } from 'zod';

/** Entry prices, option strikes — must be positive finite. */
export const zPrice = z.number().finite().positive();
export const zPriceOpt = zPrice.optional();

/** Exit prices — 0 is valid (worthless expiry). */
export const zNonNegPrice = z.number().finite().nonnegative();

/** String→number coercion for API responses. */
export const zCoercePrice = z.coerce.number().finite().nonnegative();

/** Contracts or shares — positive integer. */
export const zQuantity = z.number().int().positive();

/** Percentages expressed as 0-1. */
export const zPct01 = z.number().min(0).max(1);

/** PnL, greeks, or any value that can be negative but must be finite. */
export const zFiniteNum = z.number().finite();
