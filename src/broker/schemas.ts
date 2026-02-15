import { z } from 'zod';
import { sendSystemAlert } from '../lib/alert.js';

// --- TradeStation API response schemas (PascalCase, raw API shape) ---

export const TsQuoteSchema = z.object({
  Bid: z.number(),
  Ask: z.number(),
  Last: z.number(),
  Volume: z.number(),
  TradeTime: z.string(),
});

export const TsQuotesResponseSchema = z.object({
  Quotes: z.array(TsQuoteSchema).min(1),
});

export const TsOptionSchema = z.object({
  StrikePrice: z.number(),
  Bid: z.number(),
  Ask: z.number(),
  Last: z.number(),
  ImpliedVolatility: z.number(),
  Delta: z.number(),
  Gamma: z.number(),
  Theta: z.number(),
  OpenInterest: z.number(),
});

export const TsOptionsResponseSchema = z.object({
  Options: z.array(TsOptionSchema).optional().default([]),
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
  Positions: z.array(TsPositionSchema).optional().default([]),
});

export const TsBalanceSchema = z.object({
  CashBalance: z.string(),
  BuyingPower: z.string(),
  Equity: z.string(),
  MarketValue: z.string(),
  UnrealizedProfitLoss: z.string(),
  RealizedProfitLoss: z.string(),
  DayTradingBuyingPower: z.string().optional(),
});

export const TsBalancesResponseSchema = z.object({
  Balances: z.array(TsBalanceSchema).min(1),
});

export const TsBarSchema = z.object({
  TimeStamp: z.string(),
  Open: z.number(),
  High: z.number(),
  Low: z.number(),
  Close: z.number(),
  TotalVolume: z.number(),
});

export const TsBarsResponseSchema = z.object({
  Bars: z.array(TsBarSchema).default([]),
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
