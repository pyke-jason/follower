/**
 * Zod schemas for trade recording inputs.
 *
 * LegOffMetadataSchema — validates the metadata field for LEG_OFF trade events.
 * RecordTradeInputSchema — discriminated union on action, with per-variant field
 * defaults that mirror the inline defaults in record-trade.ts.
 */

import { z } from 'zod';
import { DirectionSchema, StrategySchema } from '../lib/enums.js';
import { zPrice, zNonNegPrice } from '../lib/zod-financial.js';
import { TradeLegSchema } from '../db/schema.js';

// ── LEG_OFF metadata ─────────────────────────────────────────────────

export const LegOffMetadataSchema = z.object({
  targetStrategy: StrategySchema,
  closedLeg: TradeLegSchema,
  keptLeg: TradeLegSchema,
});
export type LegOffMetadata = z.infer<typeof LegOffMetadataSchema>;

// ── Common fields shared across all action variants ───────────────────

const commonFields = {
  symbol:        z.string().min(1),
  trader:        z.string().min(1),
  direction:     DirectionSchema.optional(),
  strategy:      StrategySchema.optional(),
  tradeId:       z.string().optional(),
  isBacktest:    z.boolean().optional(),
  backtestRunId: z.string().optional(),
  sourceMessageId: z.string().optional(),
  closeMessageId:  z.string().optional(),
  taskId:          z.string().optional(),
  metadata:        z.record(z.unknown()).optional(),
};

// ── Per-action variants ───────────────────────────────────────────────

const OpenVariant = z.object({
  action:     z.literal('OPEN'),
  entryPrice: zPrice.optional(),
  quantity:   z.number().int().positive().default(1),
  openedAt:   z.string().optional(),
  legs:       z.array(TradeLegSchema).optional(),
  ...commonFields,
});

const CloseVariant = z.object({
  action:     z.literal('CLOSE'),
  exitPrice:  zNonNegPrice.default(0),
  quantity:   z.number().int().positive().optional(),
  closedAt:   z.string().optional(),
  legs:       z.array(TradeLegSchema).optional(),
  ...commonFields,
});

const AddVariant = z.object({
  action:     z.literal('ADD'),
  entryPrice: zPrice.optional(),
  quantity:   z.number().int().positive().default(1),
  openedAt:   z.string().optional(),
  legs:       z.array(TradeLegSchema).optional(),
  ...commonFields,
});

const TrimVariant = z.object({
  action:        z.literal('TRIM'),
  exitPrice:     zNonNegPrice.default(0),
  closeQuantity: z.number().int().positive().optional(),
  exitPercent:   z.number().min(0).max(1).optional(),
  closedAt:      z.string().optional(),
  legs:          z.array(TradeLegSchema).optional(),
  ...commonFields,
});

const LegOffVariant = z.object({
  action:    z.literal('LEG_OFF'),
  exitPrice: zNonNegPrice.default(0),
  quantity:  z.number().int().positive().optional(),
  closedAt:  z.string().optional(),
  legs:      z.array(TradeLegSchema).optional(),
  ...commonFields,
});

// ── Discriminated union ───────────────────────────────────────────────

export const RecordTradeInputSchema = z.discriminatedUnion('action', [
  OpenVariant,
  CloseVariant,
  AddVariant,
  TrimVariant,
  LegOffVariant,
]);
export type RecordTradeInput = z.infer<typeof RecordTradeInputSchema>;
