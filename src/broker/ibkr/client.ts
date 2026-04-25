/**
 * IBKR BrokerService implementation.
 *
 * Talks to the Java sidecar (localhost:8090) which bridges to IB Gateway
 * via the TWS API.
 */

import type { OptionType } from '@/lib/enums.js';
import type { Quote, OrderResult, OrderParams, OrderStatus, BrokerPosition, AccountBalance, OrderLeg } from '../types.js';
import type { BrokerService } from '../interface.js';
import type { ErrorCategory } from '@/lib/resilient.js';
import { withRetry, READ_DEFAULTS, WRITE_DEFAULTS, classifyError } from '@/lib/resilient.js';
import { randomUUID } from 'node:crypto';
import { QuoteUnavailableError } from '@/lib/errors.js';
import { resolveContract, resolveStockContract, isOccOptionSymbol, occToIBKR } from './symbology.js';
import { formatOccSymbol } from '@/lib/occ-symbology.js';
import { sendSystemAlert } from '@/lib/alert.js';
import { isCreditOrderStructural } from '@/pipeline/leg-pricing.js';
import {
  QuoteResponseSchema,
  OrderResponseSchema,
  AccountSummaryResponseSchema,
  PositionResponseSchema,
  StatusResponseSchema,
  parseSidecarResponse,
} from './schemas.js';

type IbkrServiceOptions = {
  sidecarUrl: string;
  accountId: string;
};

type IbkrRuntime = {
  sidecarUrl: string;
  accountId: string;
};

/** Round a price to the nearest valid tick using the contract's actual minTick from IBKR. */
function roundToTick(price: number, minTick: number): number {
  return Math.round(price / minTick) * minTick;
}

/**
 * Build the JSON body for a /orders/combo (BAG) submission.
 *
 * IBKR convention (matching TWS desktop): parent Order.action is always "BUY" —
 * ComboLeg.action values are absolute (BUY/SELL the specific leg). The sign of
 * limitPrice tells TWS whether the combo is a net debit (positive) or net credit
 * (negative). Using parent action "SELL" with absolute leg actions triggers TWS's
 * riskless-arbitrage validator because it interprets the combo as inverted and
 * the limit-price sign no longer matches the economic intent.
 *
 * @internal Exported for testing.
 */
export function buildComboOrderBody(args: {
  symbol: string;
  resolvedLegs: Array<{ leg: OrderLeg; conId: number }>;
  params: OrderParams;
  limitPrice: number | undefined;
  clientOrderRef: string;
}): Record<string, unknown> {
  const { symbol, resolvedLegs, params, limitPrice, clientOrderRef } = args;

  const comboLegs = resolvedLegs.map(({ leg, conId }) => ({
    conId,
    ratio: 1,
    action: leg.action,
    exchange: 'SMART',
  }));

  const isCredit = isCreditOrderStructural(params.legs) ?? false;
  const signedLimitPrice = limitPrice != null
    ? (isCredit ? -limitPrice : limitPrice)
    : undefined;

  const body: Record<string, unknown> = {
    symbol,
    legs: comboLegs,
    action: 'BUY',
    orderType: params.orderType === 'LIMIT' ? 'LMT' : 'MKT',
    quantity: params.legs[0].quantity,
    tif: 'GTC',
    clientOrderRef,
  };
  if (signedLimitPrice != null) {
    body.limitPrice = signedLimitPrice;
  }
  return body;
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
    if (status === 504) return 'permanent'; // quote/TWS future timed out — retrying won't fix a missing permission
    if (status === 402) return 'permanent'; // subscription missing or competing session (TWS 10197) — retry won't help
    if (status === 400 || status === 422) return 'permanent';
  }

  // Sidecar unreachable (fetch failed, ECONNREFUSED, etc.)
  if (/ECONNREFUSED|sidecar.*unreachable/i.test(msg)) return 'transient';

  // TWS error codes in sidecar error responses
  const twsMatch = msg.match(/IBKR error (\d+)/i) ?? msg.match(/\berror[:\s]+(\d{3,4})\b/i);
  if (twsMatch) {
    const code = parseInt(twsMatch[1], 10);
    if (code === 504 || code === 1100) return 'transient';
    if (code === 110 || code === 200 || code === 201 || code === 322 || code === 460 || code === 422) return 'permanent';
  }

  return classifyError(err);
}

// Tracks whether each placed combo order is a credit (negative limit sign).
// Needed so modifyOrder can preserve the sign convention — the sidecar's
// modify endpoint writes lmtPrice verbatim, and OrderManager passes positive
// chase prices that must be re-signed for credit combos.
// Entries are removed on fill or cancel so the set stays bounded.
const creditComboOrderIds = new Set<string>();

// ── HTTP helper ─────────────────────────────────────────────────────

async function sidecar(
  baseUrl: string,
  path: string,
  options?: RequestInit & { signal?: AbortSignal },
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
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
      return 'OPEN';
    case 'Inactive': // GTC outside RTH — queued, not actively working
      return 'PENDING';
    case 'Filled':
      return 'FILLED';
    case 'Cancelled':
    case 'PendingCancel':
      return 'CANCELLED';
    case 'ApiCancelled':
      return 'REJECTED';
    default:
      return 'PENDING';
  }
}

// ── BrokerService Implementation ────────────────────────────────────

// TTL-bounded: allows re-alerting after 24h if the subscription issue persists.
const alertedSubscriptionAt = new Map<string, number>(); // symbol -> epoch ms
const SUBSCRIPTION_ALERT_TTL_MS = 24 * 60 * 60_000;

async function getQuote(symbol: string, runtime: IbkrRuntime): Promise<Quote> {
  try {
    return await withRetry(async (signal) => {
      let body: Record<string, unknown>;

      if (isOccOptionSymbol(symbol)) {
        const { conId } = await resolveContract(symbol, runtime.sidecarUrl);
        body = { conId };
      } else {
        body = { symbol, secType: 'STK' };
      }

      const data = await sidecar(runtime.sidecarUrl, '/market-data/snapshot', {
        method: 'POST',
        body: JSON.stringify(body),
        signal,
      });

      const quote = parseSidecarResponse(
        QuoteResponseSchema,
        data,
        `POST /api/market-data/snapshot (${symbol})`,
      );

      if (quote.bid == null || quote.ask == null) {
        throw new QuoteUnavailableError(symbol, 'IBKR sidecar returned null bid/ask');
      }

      return {
        symbol,
        bid: quote.bid,
        ask: quote.ask,
        last: quote.last ?? quote.close ?? quote.bid ?? quote.ask,
        volume: quote.volume ?? 0,
        timestamp: new Date().toISOString(),
      };
    }, { ...READ_DEFAULTS, classify: ibkrClassify }, `getQuote(${symbol})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    const lastAlerted = alertedSubscriptionAt.get(symbol) ?? 0;
    if (/IBKR sidecar 402:/.test(msg) && now - lastAlerted > SUBSCRIPTION_ALERT_TTL_MS) {
      alertedSubscriptionAt.set(symbol, now);
      // Evict stale entries to keep the map bounded
      for (const [sym, ts] of alertedSubscriptionAt) {
        if (now - ts > SUBSCRIPTION_ALERT_TTL_MS) alertedSubscriptionAt.delete(sym);
      }
      const isCompetingSession = /"twsCode"\s*:\s*10197/.test(msg);
      void sendSystemAlert({
        title: isCompetingSession
          ? 'IBKR: competing session — market data suspended'
          : 'IBKR: live market data subscription missing',
        message: isCompetingSession
          ? `getQuote(${symbol}) failed — TWS 10197: another TWS/IB Gateway session is connected and has taken market data priority. Close the competing session to restore data.`
          : `getQuote(${symbol}) failed — paper account ${runtime.accountId} has no live market data for this symbol. Verify subscription sharing at IBKR Client Portal (propagation can take 24h).`,
        severity: 'critical',
        fields: [{ name: 'error', value: msg }],
      });
    }
    throw err;
  }
}

async function placeOrder(params: OrderParams, runtime: IbkrRuntime): Promise<OrderResult> {
  // Resolve conIds + minTick for all option legs
  const resolvedLegs = await Promise.all(
    params.legs.map(async (leg) => {
      if (leg.type === 'STOCK') {
        const { conId, minTick } = await resolveStockContract(params.symbol, runtime.sidecarUrl);
        return { leg, conId, minTick };
      }
      const occSymbol = formatOccSymbol({
        underlying: params.symbol,
        expiration: leg.expiry,
        type: leg.type,
        strike: leg.strike,
      });
      const { conId, minTick } = await resolveContract(occSymbol, runtime.sidecarUrl);
      return { leg, conId, minTick };
    }),
  );

  const underlying = params.symbol;

  // Use minTick from first resolved leg for limit price rounding
  const minTick = resolvedLegs[0].minTick;
  const limitPrice = params.limitPrice != null
    ? roundToTick(params.limitPrice, minTick)
    : undefined;

  // Idempotency: sidecar deduplicates by clientOrderRef (60s TTL), so retries
  // after timeout/503 are safe — the sidecar returns the cached result.
  const clientOrderRef = randomUUID();

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
        clientOrderRef,
      };
      if (limitPrice != null) {
        singleBody.limitPrice = limitPrice;
      }
      data = await sidecar(runtime.sidecarUrl, '/orders/single', {
        method: 'POST',
        body: JSON.stringify(singleBody),
        signal,
      });
    } else {
      // Multi-leg combo (spread) order — BAG contract
      const comboBody = buildComboOrderBody({
        symbol: underlying,
        resolvedLegs,
        params,
        limitPrice,
        clientOrderRef,
      });
      data = await sidecar(runtime.sidecarUrl, '/orders/combo', {
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

    const orderId = String(order.orderId);
    if (resolvedLegs.length > 1 && (isCreditOrderStructural(params.legs) ?? false)) {
      creditComboOrderIds.add(orderId);
    }

    return {
      orderId,
      status: mapIbkrStatus(order.status),
      filledPrice: order.avgFillPrice,
      filledQuantity: order.filledQuantity,
      commission: order.commission,
    };
  }, { maxRetries: 2, timeoutMs: 15_000, classify: ibkrClassify }, 'placeOrder');
}

async function modifyOrder(
  orderId: string,
  newLimitPrice: number,
  runtime: IbkrRuntime,
): Promise<OrderResult> {
  return withRetry(async (signal) => {
    // We don't know the underlying here, but modifyOrder only changes limit price
    // on existing orders. Round conservatively (penny increment is always safe).
    const rounded = Math.round(newLimitPrice * 100) / 100;
    // Credit combos were placed with a negative lmtPrice (BAG convention) —
    // chase updates pass positive magnitudes, so re-apply the sign here.
    const signed = creditComboOrderIds.has(orderId) ? -Math.abs(rounded) : rounded;

    const data = await sidecar(runtime.sidecarUrl, `/orders/${encodeURIComponent(orderId)}`, {
      method: 'PUT',
      body: JSON.stringify({ limitPrice: signed }),
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

async function cancelOrder(orderId: string, runtime: IbkrRuntime): Promise<OrderResult> {
  return withRetry(async (signal) => {
    const data = await sidecar(runtime.sidecarUrl, `/orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
      signal,
    });

    const order = parseSidecarResponse(
      OrderResponseSchema,
      data,
      `DELETE /api/orders/${orderId}`,
    );

    creditComboOrderIds.delete(orderId);

    return {
      orderId: String(order.orderId),
      status: mapIbkrStatus(order.status),
    };
  }, { ...WRITE_DEFAULTS, classify: ibkrClassify }, `cancelOrder(${orderId})`);
}

async function getOrderStatus(orderId: string, runtime: IbkrRuntime): Promise<OrderResult> {
  return withRetry(async (signal) => {
    const data = await sidecar(runtime.sidecarUrl, `/orders/${encodeURIComponent(orderId)}`, { signal });

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
      result.fillTimestamp = new Date().toISOString();
      creditComboOrderIds.delete(orderId);
    }

    return result;
  }, { ...READ_DEFAULTS, classify: ibkrClassify }, `getOrderStatus(${orderId})`);
}

async function getPositions(runtime: IbkrRuntime): Promise<BrokerPosition[]> {
  return withRetry(async (signal) => {
    const data = await sidecar(runtime.sidecarUrl, '/positions', { signal });

    // Sidecar returns an array directly
    const positions = parseSidecarResponse(
      PositionResponseSchema.array(),
      data,
      'GET /api/positions',
    );

    return positions.map((p) => {
      const isOption = p.secType === 'OPT';
      // OCC parsing needs the original 6-char padded underlying. Normalize only
      // the display symbol after parsing so option positions still match DB legs.
      const normalizedLocal = p.localSymbol.replace(/\s+/g, ' ').trim();
      const parsed = isOption ? occToIBKR(p.localSymbol) : null;

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

async function getAccountBalance(runtime: IbkrRuntime): Promise<AccountBalance> {
  return withRetry(async (signal) => {
    const data = await sidecar(runtime.sidecarUrl, '/account/summary', { signal });

    const summary = parseSidecarResponse(
      AccountSummaryResponseSchema,
      data,
      'GET /api/account/summary',
    );

    return {
      accountId: runtime.accountId,
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

async function isHealthy(runtime: IbkrRuntime): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const raw = await sidecar(runtime.sidecarUrl, '/status', { signal: controller.signal });
    clearTimeout(timeout);
    const status = StatusResponseSchema.parse(raw);
    return status.connected && !status.maintenance;
  } catch {
    return false;
  }
}

// ── Export ───────────────────────────────────────────────────────────

export function createIbkrService(options: IbkrServiceOptions): BrokerService {
  const runtime: IbkrRuntime = {
    sidecarUrl: options.sidecarUrl,
    accountId: options.accountId,
  };
  return {
    getQuote: (symbol) => getQuote(symbol, runtime),
    placeOrder: (params) => placeOrder(params, runtime),
    modifyOrder: (orderId, newLimitPrice) => modifyOrder(orderId, newLimitPrice, runtime),
    cancelOrder: (orderId) => cancelOrder(orderId, runtime),
    getOrderStatus: (orderId) => getOrderStatus(orderId, runtime),
    getPositions: () => getPositions(runtime),
    getAccountBalance: () => getAccountBalance(runtime),
    isHealthy: () => isHealthy(runtime),
  };
}
