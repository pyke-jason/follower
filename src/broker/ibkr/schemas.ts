/**
 * Zod schemas for IBKR sidecar REST API responses.
 *
 * The sidecar (Java/Javalin) bridges the TWS binary protocol to JSON REST.
 * All responses are validated here at the boundary — call sites never cast.
 */

import { z } from 'zod';
import { sendSystemAlert } from '../../lib/alert.js';

// ── Sidecar Status ──────────────────────────────────────────────────

export const StatusResponseSchema = z.object({
  connected: z.boolean(),
  accountId: z.string(),
  serverVersion: z.number(),
});

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ── Quote / Market Data ─────────────────────────────────────────────

export const QuoteResponseSchema = z.object({
  symbol: z.string(),
  bid: z.number(),
  ask: z.number(),
  last: z.number(),
  volume: z.number(),
});

export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

// ── Contract Resolution ─────────────────────────────────────────────

export const ContractResolveResponseSchema = z.object({
  conId: z.number(),
  localSymbol: z.string(),
  multiplier: z.string(),
  exchange: z.string(),
});

export type ContractResolveResponse = z.infer<typeof ContractResolveResponseSchema>;

// ── Orders ──────────────────────────────────────────────────────────

export const OrderResponseSchema = z.object({
  orderId: z.number(),
  status: z.string(),
  filledQuantity: z.number().optional(),
  avgFillPrice: z.number().optional(),
  commission: z.number().optional(),
});

export type OrderResponse = z.infer<typeof OrderResponseSchema>;

// ── Positions ───────────────────────────────────────────────────────

export const PositionResponseSchema = z.object({
  conId: z.number(),
  symbol: z.string(),
  secType: z.string(),
  localSymbol: z.string(),
  position: z.number(),
  avgCost: z.number(),
  marketValue: z.number(),
  unrealizedPnl: z.number(),
});

export type PositionResponse = z.infer<typeof PositionResponseSchema>;

// ── Account Summary ─────────────────────────────────────────────────

export const AccountSummaryResponseSchema = z.object({
  netLiquidation: z.number(),
  availableFunds: z.number(),
  maintenanceMargin: z.number(),
  unrealizedPnl: z.number(),
});

export type AccountSummaryResponse = z.infer<typeof AccountSummaryResponseSchema>;

// ── WebSocket Events ────────────────────────────────────────────────

const ConnectedEventSchema = z.object({ type: z.literal('connected') });
const DisconnectedEventSchema = z.object({ type: z.literal('disconnected') });
const ReconnectedEventSchema = z.object({ type: z.literal('reconnected') });

const OrderStatusEventSchema = z.object({
  type: z.literal('orderStatus'),
  orderId: z.number(),
  status: z.string(),
  filled: z.number(),
  remaining: z.number(),
  avgFillPrice: z.number(),
});

const ErrorEventSchema = z.object({
  type: z.literal('error'),
  code: z.number(),
  message: z.string(),
  orderId: z.number().optional(),
});

export const SidecarEventSchema = z.discriminatedUnion('type', [
  ConnectedEventSchema,
  DisconnectedEventSchema,
  ReconnectedEventSchema,
  OrderStatusEventSchema,
  ErrorEventSchema,
]);

export type SidecarEvent = z.infer<typeof SidecarEventSchema>;

// ── Validation helper ───────────────────────────────────────────────

/**
 * Validate a sidecar API response against a Zod schema.
 * On failure: fires a Discord critical alert and throws.
 */
export function parseSidecarResponse<T>(
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

  sendSystemAlert({
    title: 'IBKR sidecar API schema validation failed',
    message: `Endpoint: ${endpoint}\nErrors: ${errorMessage}`,
    severity: 'critical',
    fields: [
      { name: 'Endpoint', value: endpoint, inline: true },
      { name: 'Raw Data (truncated)', value: `\`\`\`json\n${JSON.stringify(data).slice(0, 900)}\n\`\`\``, inline: false },
    ],
  });

  throw new Error(`IBKR sidecar validation failed for ${endpoint}: ${errorMessage}`);
}
