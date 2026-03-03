/**
 * IBKR BrokerService implementation.
 *
 * Talks to the Java sidecar (localhost:8090) which bridges to IB Gateway
 * via the TWS API. Implements the same BrokerService interface as TradeStation.
 */

import type { Quote, OrderResult, OrderParams, OrderStatus, BrokerPosition, AccountBalance } from '../types.js';
import type { BrokerService } from '../interface.js';
import type { ErrorCategory } from '../../lib/resilient.js';
import { withRetry, READ_DEFAULTS, WRITE_DEFAULTS, classifyError } from '../../lib/resilient.js';
import { resolveConId, isOccOptionSymbol, occToIBKR } from './symbology.js';
import { formatOccSymbol } from '../../lib/occ-symbology.js';
import {
  QuoteResponseSchema,
  OrderResponseSchema,
  AccountSummaryResponseSchema,
  PositionResponseSchema,
  StatusResponseSchema,
  parseSidecarResponse,
} from './schemas.js';

const SIDECAR_URL = process.env.IBKR_SIDECAR_URL ?? 'http://localhost:8090/api';

// ── Penny Pilot symbols (always use $0.01 tick increments) ──────────

const PENNY_PILOT = new Set([
  'AAPL', 'AMD', 'AMZN', 'BAC', 'C', 'COIN', 'CSCO', 'DIA', 'EEM', 'EWZ',
  'F', 'GE', 'GLD', 'GOOG', 'GOOGL', 'HOOD', 'HYG', 'INTC', 'IWM', 'JPM',
  'META', 'MSFT', 'MU', 'NFLX', 'NVDA', 'PFE', 'PLTR', 'QQQ', 'ROKU',
  'SLV', 'SNAP', 'SOFI', 'SPY', 'SQ', 'T', 'TLT', 'TSLA', 'UBER',
  'USO', 'VXX', 'XLE', 'XLF', 'XLK',
]);

/**
 * Round a limit price to a valid IBKR option tick size.
 * - Below $3.00: $0.01 increments
 * - At/above $3.00: $0.05 increments
 * - Penny Pilot symbols: always $0.01
 */
export function roundToOptionTick(underlying: string, price: number): number {
  if (PENNY_PILOT.has(underlying)) {
    return Math.round(price * 100) / 100;
  }
  if (price < 3) {
    return Math.round(price * 100) / 100;
  }
  return Math.round(price * 20) / 20; // $0.05 increments
}

// ── IBKR Error Classification ───────────────────────────────────────

/**
 * IBKR-specific error classifier, composing with shared classifyError as fallback.
 *
 * Sidecar HTTP errors:
 *   503 (maintenance) → transient
 *   504 (sidecar timeout / not connected) → transient
 *
 * TWS error codes (embedded in error messages as "IBKR error NNN"):
 *   504, 1100 → transient (connectivity)
 *   110 (tick size), 201 (rejected), 460 (margin), 422 (invalid contract) → permanent
 */
function ibkrClassify(err: unknown): ErrorCategory {
  const msg = err instanceof Error ? err.message : String(err);

  // Sidecar HTTP status codes
  const httpMatch = msg.match(/IBKR sidecar (\d{3}):/);
  if (httpMatch) {
    const status = parseInt(httpMatch[1], 10);
    if (status === 503) return 'transient';
    if (status === 504) return 'transient';
  }

  // Sidecar unreachable (fetch failed, ECONNREFUSED, etc.)
  if (/ECONNREFUSED|sidecar.*unreachable/i.test(msg)) return 'transient';

  // TWS error codes in sidecar error responses
  const twsMatch = msg.match(/IBKR error (\d+)/i) ?? msg.match(/\berror[:\s]+(\d{3,4})\b/i);
  if (twsMatch) {
    const code = parseInt(twsMatch[1], 10);
    if (code === 504 || code === 1100) return 'transient';
    if (code === 110 || code === 201 || code === 460 || code === 422) return 'permanent';
  }

  return classifyError(err);
}

// ── HTTP helper ─────────────────────────────────────────────────────

async function sidecar(
  path: string,
  options?: RequestInit & { signal?: AbortSignal },
): Promise<unknown> {
  const res = await fetch(`${SIDECAR_URL}${path}`, {
    ...options,
    signal: options?.signal,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IBKR sidecar ${res.status}: ${text}`);
  }
  return res.json();
}

// ── IBKR Status Mapping ─────────────────────────────────────────────

function mapIbkrStatus(ibkrStatus: string): OrderStatus {
  switch (ibkrStatus) {
    case 'PreSubmitted':
    case 'Submitted':
      return 'PENDING';
    case 'Filled':
      return 'FILLED';
    case 'Cancelled':
    case 'PendingCancel':
      return 'CANCELLED';
    case 'ApiCancelled':
      return 'REJECTED';
    case 'Inactive':
      return 'PENDING';  // Can recover to Submitted (short-locate, exchange reopen)
    default:
      return 'PENDING';
  }
}

// ── BrokerService Implementation ────────────────────────────────────

async function getQuote(symbol: string): Promise<Quote> {
  return withRetry(async (signal) => {
    let body: Record<string, unknown>;

    if (isOccOptionSymbol(symbol)) {
      const conId = await resolveConId(symbol, SIDECAR_URL);
      body = { conId };
    } else {
      body = { symbol, secType: 'STK' };
    }

    const data = await sidecar('/market-data/snapshot', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });

    const quote = parseSidecarResponse(
      QuoteResponseSchema,
      data,
      `POST /api/market-data/snapshot (${symbol})`,
    );

    return {
      symbol,
      bid: quote.bid ?? 0,
      ask: quote.ask ?? 0,
      last: quote.last ?? quote.close ?? 0,
      volume: quote.volume ?? 0,
      timestamp: new Date().toISOString(),
    };
  }, { ...READ_DEFAULTS, classify: ibkrClassify }, `getQuote(${symbol})`);
}

async function placeOrder(params: OrderParams): Promise<OrderResult> {
  // Resolve conIds for all option legs
  const resolvedLegs = await Promise.all(
    params.legs.map(async (leg) => {
      if (leg.type === 'STOCK') {
        return { leg, conId: undefined as number | undefined };
      }
      // Build OCC symbol for the leg to resolve conId
      const occSymbol = formatOccSymbol({
        underlying: params.symbol,
        expiration: leg.expiry,
        type: leg.type as 'CALL' | 'PUT',
        strike: leg.strike,
      });
      const conId = await resolveConId(occSymbol, SIDECAR_URL);
      return { leg, conId };
    }),
  );

  const underlying = params.symbol;
  const limitPrice = params.limitPrice != null
    ? roundToOptionTick(underlying, params.limitPrice)
    : undefined;

  // NO RETRY on placeOrder — network error = unknown broker state.
  return withRetry(async (signal) => {
    let data: unknown;

    if (resolvedLegs.length === 1) {
      // Single leg order
      const { leg, conId } = resolvedLegs[0];
      const singleBody: Record<string, unknown> = {
        conId,
        action: leg.action,
        orderType: params.orderType === 'LIMIT' ? 'LMT' : 'MKT',
        quantity: leg.quantity,
        tif: 'GTC',
      };
      if (limitPrice != null) {
        singleBody.limitPrice = limitPrice;
      }
      data = await sidecar('/orders/single', {
        method: 'POST',
        body: JSON.stringify(singleBody),
        signal,
      });
    } else {
      // Multi-leg combo (spread) order — BAG contract
      const comboLegs = resolvedLegs.map(({ leg, conId }) => ({
        conId,
        ratio: 1,
        action: leg.action,
        exchange: 'SMART',
      }));

      // Combo action: the direction of the spread order as a whole.
      // BUY for opening longs / closing shorts, SELL for the opposite.
      const comboAction = params.direction === 'LONG'
        ? (params.isClosing ? 'SELL' : 'BUY')
        : (params.isClosing ? 'BUY' : 'SELL');

      const comboBody: Record<string, unknown> = {
        symbol: underlying,
        legs: comboLegs,
        action: comboAction,
        orderType: params.orderType === 'LIMIT' ? 'LMT' : 'MKT',
        quantity: params.legs[0].quantity,
        tif: 'GTC',
        nonGuaranteed: true,
      };
      if (limitPrice != null) {
        comboBody.limitPrice = limitPrice;
      }
      data = await sidecar('/orders/combo', {
        method: 'POST',
        body: JSON.stringify(comboBody),
        signal,
      });
    }

    const order = parseSidecarResponse(
      OrderResponseSchema,
      data,
      'POST /api/orders',
    );

    return {
      orderId: String(order.orderId),
      status: mapIbkrStatus(order.status),
      filledPrice: order.avgFillPrice,
      filledQuantity: order.filledQuantity,
      commission: order.commission,
    };
  }, { maxRetries: 0, timeoutMs: 15_000, classify: ibkrClassify }, 'placeOrder');
}

async function modifyOrder(orderId: string, newLimitPrice: number): Promise<OrderResult> {
  return withRetry(async (signal) => {
    // Round to penny — sidecar applies proper tick rounding based on the
    // stored order's underlying symbol (including Penny Pilot awareness).
    const rounded = Math.round(newLimitPrice * 100) / 100;

    const data = await sidecar(`/orders/${encodeURIComponent(orderId)}`, {
      method: 'PUT',
      body: JSON.stringify({ limitPrice: rounded }),
      signal,
    });

    const order = parseSidecarResponse(
      OrderResponseSchema,
      data,
      `PUT /api/orders/${orderId}`,
    );

    return {
      orderId: String(order.orderId),
      status: mapIbkrStatus(order.status),
    };
  }, { ...WRITE_DEFAULTS, classify: ibkrClassify }, `modifyOrder(${orderId})`);
}

async function cancelOrder(orderId: string): Promise<OrderResult> {
  return withRetry(async (signal) => {
    const data = await sidecar(`/orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
      signal,
    });

    const order = parseSidecarResponse(
      OrderResponseSchema,
      data,
      `DELETE /api/orders/${orderId}`,
    );

    return {
      orderId: String(order.orderId),
      status: mapIbkrStatus(order.status),
    };
  }, { ...WRITE_DEFAULTS, classify: ibkrClassify }, `cancelOrder(${orderId})`);
}

async function getOrderStatus(orderId: string): Promise<OrderResult> {
  return withRetry(async (signal) => {
    const data = await sidecar(`/orders/${encodeURIComponent(orderId)}`, { signal });

    const order = parseSidecarResponse(
      OrderResponseSchema,
      data,
      `GET /api/orders/${orderId}`,
    );

    const status = mapIbkrStatus(order.status);
    const result: OrderResult = {
      orderId: String(order.orderId),
      status,
    };

    if (status === 'FILLED') {
      result.filledPrice = order.avgFillPrice;
      result.filledQuantity = order.filledQuantity;
      result.commission = order.commission;
      result.fillTimestamp = order.fillTime ?? new Date().toISOString();
    }

    return result;
  }, { ...READ_DEFAULTS, classify: ibkrClassify }, `getOrderStatus(${orderId})`);
}

async function getPositions(): Promise<BrokerPosition[]> {
  return withRetry(async (signal) => {
    const data = await sidecar('/positions', { signal });

    // Sidecar returns an array directly
    const positions = parseSidecarResponse(
      PositionResponseSchema.array(),
      data,
      'GET /api/positions',
    );

    return positions.map((p) => {
      const isOption = p.secType === 'OPT';
      // OCC localSymbol from IBKR has internal whitespace padding — normalize
      const normalizedLocal = p.localSymbol.replace(/\s+/g, ' ').trim();
      const parsed = isOption ? occToIBKR(normalizedLocal) : null;

      const pos: BrokerPosition = {
        symbol: isOption ? normalizedLocal : p.symbol,
        quantity: p.position,
        averageCost: p.avgCost,
        marketValue: p.marketValue,
        unrealizedPnl: p.unrealizedPnl,
        assetType: isOption ? 'OP' : 'EQ',
      };

      if (parsed) {
        pos.strikePrice = parsed.strike;
        pos.expiry = `${parsed.expiry.slice(0, 4)}-${parsed.expiry.slice(4, 6)}-${parsed.expiry.slice(6, 8)}`;
        pos.optionType = parsed.right === 'C' ? 'CALL' : 'PUT';
      }

      return pos;
    });
  }, { ...READ_DEFAULTS, classify: ibkrClassify }, 'getPositions');
}

async function getAccountBalance(): Promise<AccountBalance> {
  const accountId = process.env.IBKR_ACCOUNT_ID ?? '';

  return withRetry(async (signal) => {
    const data = await sidecar('/account/summary', { signal });

    const summary = parseSidecarResponse(
      AccountSummaryResponseSchema,
      data,
      'GET /api/account/summary',
    );

    return {
      accountId,
      cashBalance: summary.availableFunds,
      buyingPower: summary.availableFunds,
      equity: summary.netLiquidation,
      marketValue: summary.netLiquidation - summary.availableFunds,
      unrealizedPnl: summary.unrealizedPnl,
      realizedPnl: 0, // IBKR account summary doesn't provide daily realized P&L
      maintenanceMargin: summary.maintenanceMargin,
      cushion: summary.cushion,
      sma: summary.sma,
      dayTradesRemaining: summary.dayTradesRemaining,
      timestamp: new Date().toISOString(),
    };
  }, { ...READ_DEFAULTS, classify: ibkrClassify }, 'getAccountBalance');
}

// ── Health Check ─────────────────────────────────────────────────────

async function isHealthy(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const raw = await sidecar('/status', { signal: controller.signal });
    clearTimeout(timeout);
    const status = StatusResponseSchema.parse(raw);
    return status.connected && !status.maintenance;
  } catch {
    return false;
  }
}

// ── Export ───────────────────────────────────────────────────────────

export const ibkrService: BrokerService = {
  getQuote,
  placeOrder,
  modifyOrder,
  cancelOrder,
  getOrderStatus,
  getPositions,
  getAccountBalance,
  isHealthy,
};
