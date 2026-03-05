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

/** Option types only (no STOCK). */
export type OptionType = Exclude<LegType, 'STOCK'>;

export const LegActionSchema = z.enum(['BUY', 'SELL']);
export type LegAction = z.infer<typeof LegActionSchema>;

/** Strategies supported by the execution pipeline. */
export const StrategySchema = z.enum(['STOCK', 'CALL', 'PUT', 'CDS', 'PDS', 'PCS', 'CCS']);
export type Strategy = z.infer<typeof StrategySchema>;

/** The four vertical spread strategies. */
export type SpreadStrategy = Extract<Strategy, 'CDS' | 'PDS' | 'PCS' | 'CCS'>;

export const TradeActionSchema = z.enum(['OPEN', 'CLOSE', 'ADD', 'TRIM', 'LEG_OFF']);
export type TradeAction = z.infer<typeof TradeActionSchema>;

/** Parser-level action hint before full resolution. */
export const ActionHintSchema = z.enum(['OPEN', 'CLOSE']);
export type ActionHint = z.infer<typeof ActionHintSchema>;

/** Broker order type: market or limit. */
export const OrderTypeSchema = z.enum(['MARKET', 'LIMIT']);
export type OrderType = z.infer<typeof OrderTypeSchema>;

/** Resolved order shape for the execution pipeline. */
export const OrderCategorySchema = z.enum(['SINGLE', 'SPREAD', 'STOCK']);
export type OrderCategory = z.infer<typeof OrderCategorySchema>;

/** Orchestrator/agent decision outcome. */
export const DecisionOutcomeSchema = z.enum(['EXECUTE', 'SKIP', 'MANUAL_REVIEW']);
export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;

/** Broker asset type: equity or option. */
export type AssetType = 'EQ' | 'OP';

/** Abbreviated call/put for OCC and symbology formatting. */
export type CallPutAbbrev = 'C' | 'P';
