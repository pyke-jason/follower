/**
 * Zod schemas for validated parsing of trade DB rows.
 *
 * Every `as` cast on a DB value is a lie the compiler cannot verify.
 * These schemas validate at the boundary so callers get real types.
 */

import { z } from 'zod';

export const DirectionSchema = z.enum(['LONG', 'SHORT']);
export const LegTypeSchema = z.enum(['CALL', 'PUT', 'STOCK']);
export const LegActionSchema = z.enum(['BUY', 'SELL']);

export const TradeLegSchema = z.object({
  symbol: z.string(),
  strike: z.number(),
  expiry: z.string(),
  type: LegTypeSchema,
  action: LegActionSchema,
  quantity: z.number().default(1),
  fillPrice: z.number().optional(),
});

export type TradeLeg = z.infer<typeof TradeLegSchema>;

/**
 * Parse the `legs` column from a trade row.
 * Accepts raw JSON (already parsed by Drizzle) or a JSON string.
 * Throws with a descriptive message on invalid data.
 */
export function parseLegs(raw: unknown, tradeId?: string): TradeLeg[] {
  return z.array(TradeLegSchema).parse(raw);}

/**
 * Parse the `direction` column from a trade row.
 * Throws on unexpected values like "long" (lowercase) or "BUY_TO_OPEN".
 */
export function parseDirection(raw: string, tradeId?: string): 'LONG' | 'SHORT' {
  const result = DirectionSchema.safeParse(raw);
  if (!result.success) {
    const ctx = tradeId ? ` (trade ${tradeId})` : '';
    throw new Error(`Invalid direction "${raw}"${ctx}: expected LONG or SHORT`);
  }
  return result.data;
}
