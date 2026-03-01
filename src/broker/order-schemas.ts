/**
 * Zod schemas for broker order types.
 *
 * Cross-field constraints (LIMIT → limitPrice, FILLED → fillTimestamp) are
 * validated here at the boundary, not with ad-hoc throws in orchestration code.
 */

import { z } from 'zod';
import { TradeLegSchema } from '../db/schema.js';
import { DirectionSchema } from '../lib/enums.js';
import { zPrice } from '../lib/zod-financial.js';

// ── OrderLeg (TradeLeg minus fillPrice) ──────────────────────────────

const OrderLegSchema = TradeLegSchema.omit({ fillPrice: true });

// ── AdjustmentRule ───────────────────────────────────────────────────

const AdjustmentRuleSchema = z.object({
  type: z.literal('PRICE_CHASE'),
  stepAmount: z.number().positive(),
  intervalSec: z.number().positive(),
  maxSteps: z.number().int().nonnegative().optional(),
});

// ── WorkingOrderParams ───────────────────────────────────────────────

export const WorkingOrderParamsSchema = z.object({
  symbol: z.string().min(1),
  strategy: z.string().min(1),
  direction: DirectionSchema,
  legs: z.array(OrderLegSchema),
  orderType: z.enum(['MARKET', 'LIMIT']),
  limitPrice: zPrice.optional(),
  isClosing: z.boolean(),
  adjustmentRules: z.array(AdjustmentRuleSchema).optional(),
  cancelAfterSec: z.number().nonnegative().optional(),
}).refine(
  o => o.orderType !== 'LIMIT' || o.limitPrice != null,
  { message: 'LIMIT orders require limitPrice' },
);

// ── OrderResult (FILLED variant) ─────────────────────────────────────

const OrderStatusSchema = z.enum(['PENDING', 'OPEN', 'FILLED', 'CANCELLED', 'REJECTED']);

const LegFillSchema = z.object({
  symbol: z.string(),
  filledPrice: z.number(),
  filledQuantity: z.number(),
  commission: z.number().optional(),
});

export const OrderResultSchema = z.object({
  orderId: z.string(),
  status: OrderStatusSchema,
  filledPrice: z.number().optional(),
  filledQuantity: z.number().optional(),
  commission: z.number().optional(),
  fillTimestamp: z.string().optional(),
  legFills: z.array(LegFillSchema).optional(),
  message: z.string().optional(),
}).refine(
  r => r.status !== 'FILLED' || r.filledPrice != null,
  { message: 'FILLED orders require filledPrice' },
).refine(
  r => r.status !== 'FILLED' || r.fillTimestamp != null,
  { message: 'FILLED orders require fillTimestamp' },
);
