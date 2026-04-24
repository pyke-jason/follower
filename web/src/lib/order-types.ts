import { z } from 'zod';
import {
  ModifyOrderBodySchema,
  PlaceOrderBodySchema,
  QuoteDataSchema,
  WorkingOrderResponseSchema,
} from '@src/local-api/http-schemas';
import { OrderTypeSchema } from '@src/lib/enums';
import { computeMidpoint, defaultTickSize } from '@src/lib/quotes';

export type QuoteData = z.infer<typeof QuoteDataSchema>;
type OrderType = z.infer<typeof OrderTypeSchema>;

// ─── Order Entry (frontend -> API) ──────────────────

export const OrderEntryParamsSchema = PlaceOrderBodySchema;
export type OrderEntryParams = z.infer<typeof OrderEntryParamsSchema>;

// ─── Working Order (API -> frontend) ────────────────

export const WorkingOrderSchema = WorkingOrderResponseSchema;
export type WorkingOrder = z.infer<typeof WorkingOrderSchema>;

// ─── Form Values (what RHF manages) ────────────────

export const OrderFormValuesSchema = z.object({
  orderType: OrderTypeSchema,
  limitPrice: z.number().positive().optional(),
  quantity: z.number().int().positive(),
}).refine(
  (d) => d.orderType !== 'LIMIT' || (d.limitPrice != null && d.limitPrice > 0),
  { message: 'LIMIT orders require a price', path: ['limitPrice'] },
);

export type OrderFormValues = z.infer<typeof OrderFormValuesSchema>;

// ─── Modify Order (frontend -> API) ─────────────────

export const ModifyOrderParamsSchema = ModifyOrderBodySchema;
export type ModifyOrderParams = z.infer<typeof ModifyOrderParamsSchema>;

export { defaultTickSize };
