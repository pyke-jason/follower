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
  wsClients: z.number(),
  maintenance: z.boolean(),
});

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ── Quote / Market Data ─────────────────────────────────────────────
// Sidecar returns only ticks that arrived within the 5s window.
// All fields optional — illiquid contracts or outside-hours may return {}.
// NOTE: sidecar does NOT include `symbol` — the caller tracks it.

export const QuoteResponseSchema = z.object({
  bid: z.number().optional(),
  ask: z.number().optional(),
  last: z.number().optional(),
  close: z.number().optional(),
  volume: z.number().optional(),
});

export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

// ── Contract Resolution ─────────────────────────────────────────────

export const ContractResolveResponseSchema = z.object({
  conId: z.number(),
  localSymbol: z.string(),
  multiplier: z.string(),
  exchange: z.string(),
  minTick: z.number(),
});

export type ContractResolveResponse = z.infer<typeof ContractResolveResponseSchema>;

// ── Orders ──────────────────────────────────────────────────────────

export const OrderResponseSchema = z.object({
  orderId: z.number(),
  status: z.string(),
  filledQuantity: z.number().optional(),
  remaining: z.number().optional(),
  avgFillPrice: z.number().optional(),
  commission: z.number().optional(),
});

export type OrderResponse = z.infer<typeof OrderResponseSchema>;

// ── Positions ───────────────────────────────────────────────────────
// Core fields from reqPositions(). marketValue/unrealizedPnl enriched
// from reqAccountUpdates subscription when available.

export const PositionResponseSchema = z.object({
  conId: z.number(),
  symbol: z.string(),
  secType: z.string(),
  localSymbol: z.string(),
  position: z.number(),
  avgCost: z.number(),
  marketValue: z.number().optional(),
  unrealizedPnl: z.number().optional(),
});

export type PositionResponse = z.infer<typeof PositionResponseSchema>;

// ── Account Summary ─────────────────────────────────────────────────

export const AccountSummaryResponseSchema = z.object({
  netLiquidation: z.number(),
  availableFunds: z.number(),
  maintenanceMargin: z.number(),
  unrealizedPnl: z.number(),
  cushion: z.number().optional(),
  sma: z.number().optional(),
  dayTradesRemaining: z.number().optional(),
  excessLiquidity: z.number().optional(),
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

const ExecDetailsEventSchema = z.object({
  type: z.literal('execDetails'),
  execId: z.string(),
  orderId: z.number(),
  symbol: z.string(),
  side: z.string(),
  quantity: z.number(),
  price: z.number(),
  time: z.string(),
  liquidation: z.number(),
});

const CommissionEventSchema = z.object({
  type: z.literal('commission'),
  execId: z.string(),
  commission: z.number(),
  orderId: z.number(),
});

export const SidecarEventSchema = z.discriminatedUnion('type', [
  ConnectedEventSchema,
  DisconnectedEventSchema,
  ReconnectedEventSchema,
  OrderStatusEventSchema,
  ErrorEventSchema,
  ExecDetailsEventSchema,
  CommissionEventSchema,
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
