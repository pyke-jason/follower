import { z } from 'zod';
import { sendSystemAlert } from '@/lib/alert.js';
import { zCoercePrice } from '@/lib/zod-financial.js';

// --- TradeStation API response schemas (PascalCase, raw API shape) ---
// NOTE: TradeStation returns ALL numeric fields as strings (e.g. "684.37").
// Use z.coerce.number() throughout — never raw z.number().

const zTsNum = z.coerce.number();
const zTsNonNeg = zCoercePrice; // z.coerce.number().nonnegative()

export const TsQuoteSchema = z.object({
  Bid: zTsNonNeg,
  Ask: zTsNonNeg,
  Last: zTsNonNeg,
  Volume: zTsNum,
  TradeTime: z.string(),
});

export const TsQuotesResponseSchema = z.object({
  Quotes: z.array(TsQuoteSchema).min(1),
});

export const TsOptionSchema = z.object({
  StrikePrice: zTsNonNeg,
  Bid: zTsNonNeg,
  Ask: zTsNonNeg,
  Last: zTsNonNeg,
  ImpliedVolatility: zTsNum,
  Delta: zTsNum,
  Gamma: zTsNum,
  Theta: zTsNum,
  OpenInterest: zTsNum,
});

export const TsOptionsResponseSchema = z.object({
  Options: z.array(TsOptionSchema),
});

const TsOrderLegSchema = z.object({
  Symbol: z.string().optional(),
  ExecPrice: z.string().optional(),
  ExecQuantity: z.string().optional(),
  QuantityOrdered: z.string().optional(),
  CommissionFee: z.string().optional(),
});

export const TsOrderSchema = z.object({
  OrderID: z.string(),
  StatusDescription: z.string().optional(),
  Status: z.string().optional(),
  FilledPrice: z.string().optional(),
  FilledQuantity: z.string().optional(),
  CommissionFee: z.string().optional(),
  ClosedDateTime: z.string().optional(),
  Legs: z.array(TsOrderLegSchema).optional(),
});

export const TsOrdersResponseSchema = z.object({
  Orders: z.array(TsOrderSchema).min(1),
});

export const TsPositionSchema = z.object({
  Symbol: z.string(),
  Quantity: z.string(),
  AveragePrice: z.string(),
  MarketValue: z.string(),
  UnrealizedProfitLoss: z.string(),
  AssetType: z.string(),
  StrikePrice: z.string().optional(),
  ExpirationDate: z.string().optional(),
  OptionType: z.string().optional(),
});

export const TsPositionsResponseSchema = z.object({
  Positions: z.array(TsPositionSchema),
});

const TsBalanceDetailSchema = z.object({
  RealizedProfitLoss: z.string().optional(),
  UnrealizedProfitLoss: z.string().optional(),
  DayTradeExcess: z.string().optional(),
}).passthrough();

export const TsBalanceSchema = z.object({
  CashBalance: z.string(),
  BuyingPower: z.string(),
  Equity: z.string(),
  MarketValue: z.string(),
  BalanceDetail: TsBalanceDetailSchema.optional(),
});

export const TsBalancesResponseSchema = z.object({
  Balances: z.array(TsBalanceSchema).min(1),
});

// --- Validation helper ---

/**
 * Validate an API response against a Zod schema.
 * On failure: fires a Discord critical alert and throws.
 */
export function parseApiResponse<T>(
  schema: z.ZodType<T>,
  data: unknown,
  endpoint: string,
): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const errorMessage = result.error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');

  // Fire-and-forget — don't await, don't let alert failure block the throw
  sendSystemAlert({
    title: 'TradeStation API schema validation failed',
    message: `Endpoint: ${endpoint}\nErrors: ${errorMessage}`,
    severity: 'critical',
    fields: [
      { name: 'Endpoint', value: endpoint, inline: true },
      { name: 'Raw Data (truncated)', value: `\`\`\`json\n${JSON.stringify(data).slice(0, 900)}\n\`\`\``, inline: false },
    ],
  });

  throw new Error(`TradeStation API validation failed for ${endpoint}: ${errorMessage}`);
}
