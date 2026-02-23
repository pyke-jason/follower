import type { Quote, OrderResult, OrderParams, OrderStatus, BrokerPosition, AccountBalance, LegFill, Bar, GetBarsParams } from './types.js';
import type { BrokerService } from './interface.js';
import { getAccessToken } from './auth.js';
import { safeParseFloat } from '../lib/numbers.js';
import { formatOccSymbol } from '../backtest/occ-symbology.js';
import { withRetry, READ_DEFAULTS, WRITE_DEFAULTS, tsClassify } from '../lib/resilient.js';
import {
  TsQuotesResponseSchema,
  TsOrdersResponseSchema,
  TsPositionsResponseSchema,
  TsBalancesResponseSchema,
  TsBarsResponseSchema,
  parseApiResponse,
} from './schemas.js';

const BASE = process.env.TS_BASE_URL || 'https://api.tradestation.com/v3';

async function ts(path: string, options?: RequestInit & { signal?: AbortSignal }) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    signal: options?.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TradeStation ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getQuote(symbol: string): Promise<Quote> {
  return withRetry(async (signal) => {
    const data = await ts(`/marketdata/quotes/${encodeURIComponent(symbol)}`, { signal });
    const validated = parseApiResponse(TsQuotesResponseSchema, data, `GET /marketdata/quotes/${symbol}`);
    const q = validated.Quotes[0];
    return {
      symbol,
      bid: q.Bid,
      ask: q.Ask,
      last: q.Last,
      volume: q.Volume,
      timestamp: q.TradeTime,
    };
  }, { ...READ_DEFAULTS, classify: tsClassify }, `getQuote(${symbol})`);
}

export async function placeOrder(params: OrderParams): Promise<OrderResult> {
  const accountId = process.env.TS_ACCOUNT_ID;
  if (!accountId) throw new Error('Missing TS_ACCOUNT_ID');

  const tsLegs = params.legs.map((leg) => ({
    Symbol: leg.type === 'STOCK'
      ? params.symbol
      : formatOccSymbol({ underlying: params.symbol, expiration: leg.expiry, type: leg.type as 'CALL' | 'PUT', strike: leg.strike }),
    Quantity: String(leg.quantity),
    TradeAction: resolveTradeAction(leg.action, leg.type),
  }));

  const body: Record<string, unknown> = {
    AccountID: accountId,
    Symbol: params.symbol,
    OrderType: params.orderType === 'LIMIT' ? 'Limit' : 'Market',
    Legs: tsLegs,
    Duration: 'DAY',
  };

  if (params.orderType === 'LIMIT' && params.limitPrice != null) {
    body.LimitPrice = String(params.limitPrice);
  }

  // NO RETRY on placeOrder — network error = unknown broker state.
  // Timeout only (maxRetries: 0 gives us the AbortSignal timeout without retry).
  return withRetry(async (signal) => {
    const data = await ts('/orderexecution/orders', {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });

    const validated = parseApiResponse(TsOrdersResponseSchema, data, 'POST /orderexecution/orders');
    const order = validated.Orders[0];
    return {
      orderId: order.OrderID,
      status: mapTsStatus(order.StatusDescription),
      filledPrice: order.FilledPrice ? safeParseFloat(order.FilledPrice) : undefined,
    };
  }, { maxRetries: 0, timeoutMs: 15_000, classify: tsClassify }, 'placeOrder');
}

export async function modifyOrder(orderId: string, newLimitPrice: number): Promise<OrderResult> {
  const accountId = process.env.TS_ACCOUNT_ID;
  if (!accountId) throw new Error('Missing TS_ACCOUNT_ID');

  return withRetry(async (signal) => {
    const data = await ts(`/orderexecution/orders/${encodeURIComponent(orderId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        AccountID: accountId,
        LimitPrice: String(newLimitPrice),
      }),
      signal,
    });

    const validated = parseApiResponse(TsOrdersResponseSchema, data, `PUT /orderexecution/orders/${orderId}`);
    const order = validated.Orders[0];
    return {
      orderId: order.OrderID,
      status: mapTsStatus(order.StatusDescription),
      filledPrice: order.FilledPrice ? safeParseFloat(order.FilledPrice) : undefined,
    };
  }, { ...WRITE_DEFAULTS, classify: tsClassify }, `modifyOrder(${orderId})`);
}

export async function cancelOrder(orderId: string): Promise<OrderResult> {
  return withRetry(async (signal) => {
    const data = await ts(`/orderexecution/orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
      signal,
    });

    const validated = parseApiResponse(TsOrdersResponseSchema, data, `DELETE /orderexecution/orders/${orderId}`);
    const order = validated.Orders[0];
    return {
      orderId: order.OrderID,
      status: mapTsStatus(order.StatusDescription),
    };
  }, { ...WRITE_DEFAULTS, classify: tsClassify }, `cancelOrder(${orderId})`);
}

export async function getOrderStatus(orderId: string): Promise<OrderResult> {
  return withRetry(async (signal) => {
    const data = await ts(`/orderexecution/orders/${encodeURIComponent(orderId)}`, { signal });

    const validated = parseApiResponse(TsOrdersResponseSchema, data, `GET /orderexecution/orders/${orderId}`);
    const order = validated.Orders[0];

    // Extract per-leg fill details if available (these fields are genuinely optional)
    let legFills: LegFill[] | undefined;
    if (order.Legs) {
      legFills = order.Legs
        .filter((leg) => leg.ExecPrice != null)
        .map((leg) => ({
          symbol: leg.Symbol ?? '',
          filledPrice: safeParseFloat(leg.ExecPrice),
          filledQuantity: parseInt(leg.ExecQuantity ?? leg.QuantityOrdered ?? '0', 10),
          commission: leg.CommissionFee ? safeParseFloat(leg.CommissionFee) : undefined,
        }));
      if (legFills.length === 0) legFills = undefined;
    }

    return {
      orderId: order.OrderID,
      status: mapTsStatus(order.StatusDescription ?? order.Status),
      filledPrice: order.FilledPrice ? safeParseFloat(order.FilledPrice) : undefined,
      filledQuantity: order.FilledQuantity ? parseInt(order.FilledQuantity, 10) : undefined,
      commission: order.CommissionFee ? safeParseFloat(order.CommissionFee) : undefined,
      fillTimestamp: order.ClosedDateTime ?? undefined,
      legFills,
    };
  }, { ...READ_DEFAULTS, classify: tsClassify }, `getOrderStatus(${orderId})`);
}

export async function getPositions(): Promise<BrokerPosition[]> {
  const accountId = process.env.TS_ACCOUNT_ID;
  if (!accountId) throw new Error('Missing TS_ACCOUNT_ID');

  return withRetry(async (signal) => {
    const data = await ts(`/brokerage/accounts/${encodeURIComponent(accountId)}/positions`, { signal });
    const validated = parseApiResponse(TsPositionsResponseSchema, data, `GET /brokerage/accounts/.../positions`);

    return validated.Positions.map((p) => {
      const pos: BrokerPosition = {
        symbol: p.Symbol,
        quantity: safeParseFloat(p.Quantity),
        averageCost: safeParseFloat(p.AveragePrice),
        marketValue: safeParseFloat(p.MarketValue),
        unrealizedPnl: safeParseFloat(p.UnrealizedProfitLoss),
        assetType: p.AssetType,
      };
      if (p.AssetType === 'OP') {
        pos.strikePrice = p.StrikePrice ? safeParseFloat(p.StrikePrice) : undefined;
        pos.expiry = p.ExpirationDate ?? undefined;
        pos.optionType = p.OptionType === 'C' ? 'CALL' : p.OptionType === 'P' ? 'PUT' : undefined;
      }
      return pos;
    });
  }, { ...READ_DEFAULTS, classify: tsClassify }, 'getPositions');
}

export async function getBars(params: GetBarsParams): Promise<Bar[]> {
  return withRetry(async (signal) => {
    const data = await ts(
      `/marketdata/barcharts/${encodeURIComponent(params.symbol)}?interval=${params.interval}&barsback=${params.barsBack}`,
      { signal },
    );
    const validated = parseApiResponse(
      TsBarsResponseSchema,
      data,
      `GET /marketdata/barcharts/${params.symbol}`,
    );
    return validated.Bars.map((b) => ({
      timestamp: b.TimeStamp,
      open: b.Open,
      high: b.High,
      low: b.Low,
      close: b.Close,
      volume: b.TotalVolume,
    }));
  }, { ...READ_DEFAULTS, classify: tsClassify }, `getBars(${params.symbol})`);
}

export async function getAccountBalance(): Promise<AccountBalance> {
  const accountId = process.env.TS_ACCOUNT_ID;
  if (!accountId) throw new Error('Missing TS_ACCOUNT_ID');

  return withRetry(async (signal) => {
    const data = await ts(`/brokerage/accounts/${encodeURIComponent(accountId)}/balances`, { signal });
    const validated = parseApiResponse(TsBalancesResponseSchema, data, `GET /brokerage/accounts/.../balances`);
    const bal = validated.Balances[0];

    return {
      accountId,
      cashBalance: safeParseFloat(bal.CashBalance),
      buyingPower: safeParseFloat(bal.BuyingPower),
      equity: safeParseFloat(bal.Equity),
      marketValue: safeParseFloat(bal.MarketValue),
      dayTradingBuyingPower: bal.DayTradingBuyingPower ? safeParseFloat(bal.DayTradingBuyingPower) : undefined,
      unrealizedPnl: safeParseFloat(bal.UnrealizedProfitLoss),
      realizedPnl: safeParseFloat(bal.RealizedProfitLoss),
      timestamp: new Date().toISOString(),
    };
  }, { ...READ_DEFAULTS, classify: tsClassify }, 'getAccountBalance');
}

function mapTsStatus(tsStatus: string | undefined): OrderStatus {
  if (!tsStatus) return 'PENDING';
  const s = tsStatus.toUpperCase();
  if (s.includes('FLL') || s.includes('FILLED')) return 'FILLED';
  if (s.includes('CAN') || s.includes('CANCELLED') || s.includes('CANCELED')) return 'CANCELLED';
  if (s.includes('REJ') || s.includes('REJECTED')) return 'REJECTED';
  if (s.includes('OPN') || s.includes('OPEN') || s.includes('ACK') || s.includes('QUEUED')) return 'OPEN';
  return 'PENDING';
}

export const liveService: BrokerService = {
  getQuote, placeOrder, modifyOrder, cancelOrder, getOrderStatus,
  getPositions, getAccountBalance, getBars,
};

function resolveTradeAction(action: 'BUY' | 'SELL', type: string): string {
  if (type === 'STOCK') {
    return action === 'BUY' ? 'BUY' : 'SELL';
  }
  // Options: use BUY_TO_OPEN / SELL_TO_OPEN for now.
  // The agent can specify SELL_TO_CLOSE via the action field when closing.
  return action === 'BUY' ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN';
}
