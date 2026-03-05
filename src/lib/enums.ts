/**
 * Canonical trading enum definitions (Zod schemas + inferred types).
 *
 * Every file that needs Direction, LegType, etc. should import from here
 * rather than defining its own z.enum().
 */

import { z } from 'zod';

export const DirectionSchema = z.enum(['LONG', 'SHORT']);
export type Direction = z.infer<typeof DirectionSchema>;

export const LegTypeSchema = z.enum(['CALL', 'PUT', 'STOCK']);
export type LegType = z.infer<typeof LegTypeSchema>;

export const LegActionSchema = z.enum(['BUY', 'SELL']);
export type LegAction = z.infer<typeof LegActionSchema>;

/** Strategies supported by the execution pipeline. */
export const StrategySchema = z.enum(['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS']);
export type Strategy = z.infer<typeof StrategySchema>;

export const TradeActionSchema = z.enum(['OPEN', 'CLOSE', 'ADD', 'TRIM', 'LEG_OFF']);
export type TradeAction = z.infer<typeof TradeActionSchema>;
