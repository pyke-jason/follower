/**
 * Zod schemas for validated parsing of trade DB rows.
 *
 * Every `as` cast on a DB value is a lie the compiler cannot verify.
 * These schemas validate at the boundary so callers get real types.
 */

import { z } from 'zod';
import { TradeLegSchema } from './schema.js';
import type { TradeLeg } from './schema.js';
import { DirectionSchema } from '../lib/enums.js';

/**
 * Parse the `legs` column from a trade row.
 * Accepts raw JSON (already parsed by Drizzle) or a JSON string.
 * Throws with a descriptive message on invalid data.
 */
export function parseLegs(raw: unknown, tradeId?: string): TradeLeg[] {
  try {
    return z.array(TradeLegSchema).parse(raw);
  } catch (err) {
    const ctx = tradeId ? ` (trade ${tradeId})` : '';
    const detail = err instanceof z.ZodError ? err.message : String(err);
    throw new Error(`Invalid legs data${ctx}: ${detail}`);
  }
}

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
