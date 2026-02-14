import type { Quote, OptionsChain, OrderResult, OrderParams, OrderStatus } from './types.js';
import type { BrokerService } from './interface.js';
import { getAccessToken } from './auth.js';

const BASE = process.env.TS_BASE_URL || 'https://api.tradestation.com/v3';

async function ts(path: string, options?: RequestInit) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
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
  const data = await ts(`/marketdata/quotes/${encodeURIComponent(symbol)}`);
  const q = (data as any).Quotes[0];
  return {
    symbol,
    bid: q.Bid,
    ask: q.Ask,
    last: q.Last,
    volume: q.Volume,
    timestamp: q.TradeTime,
  };
}

export async function getOptionsChain(
  symbol: string,
  expiry: string,
  optionType: 'CALL' | 'PUT'
): Promise<OptionsChain> {
  const data = await ts(
    `/marketdata/options/chains/${encodeURIComponent(symbol)}?expiration=${expiry}&optionType=${optionType}`
  );
  return {
    symbol,
    expiry,
    optionType,
    strikes: ((data as any).Options || []).map((o: any) => ({
      strike: o.StrikePrice,
      bid: o.Bid,
      ask: o.Ask,
      last: o.Last,
      iv: o.ImpliedVolatility,
      delta: o.Delta,
      gamma: o.Gamma,
      theta: o.Theta,
      openInterest: o.OpenInterest,
    })),
  };
}

export async function placeOrder(params: OrderParams): Promise<OrderResult> {
  const accountId = process.env.TS_ACCOUNT_ID;
  if (!accountId) throw new Error('Missing TS_ACCOUNT_ID');

  const tsLegs = params.legs.map((leg) => ({
    Symbol: leg.type === 'STOCK'
      ? params.symbol
      : buildOccSymbol(params.symbol, leg.expiry, leg.type as 'CALL' | 'PUT', leg.strike),
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

  const data = await ts('/orderexecution/orders', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const order = (data as any).Orders?.[0];
  return {
    orderId: order?.OrderID ?? 'unknown',
    status: mapTsStatus(order?.StatusDescription),
    filledPrice: order?.FilledPrice ? parseFloat(order.FilledPrice) : undefined,
  };
}

export async function modifyOrder(orderId: string, newLimitPrice: number): Promise<OrderResult> {
  const accountId = process.env.TS_ACCOUNT_ID;
  if (!accountId) throw new Error('Missing TS_ACCOUNT_ID');

  const data = await ts(`/orderexecution/orders/${encodeURIComponent(orderId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      AccountID: accountId,
      LimitPrice: String(newLimitPrice),
    }),
  });

  const order = (data as any).Orders?.[0];
  return {
    orderId: order?.OrderID ?? orderId,
    status: mapTsStatus(order?.StatusDescription),
    filledPrice: order?.FilledPrice ? parseFloat(order.FilledPrice) : undefined,
  };
}

export async function cancelOrder(orderId: string): Promise<OrderResult> {
  const data = await ts(`/orderexecution/orders/${encodeURIComponent(orderId)}`, {
    method: 'DELETE',
  });

  const order = (data as any).Orders?.[0];
  return {
    orderId: order?.OrderID ?? orderId,
    status: mapTsStatus(order?.StatusDescription ?? 'Cancelled'),
  };
}

export async function getOrderStatus(orderId: string): Promise<OrderResult> {
  const data = await ts(`/orderexecution/orders/${encodeURIComponent(orderId)}`);

  const order = (data as any).Orders?.[0] ?? data;
  return {
    orderId: order?.OrderID ?? orderId,
    status: mapTsStatus(order?.StatusDescription ?? order?.Status),
    filledPrice: order?.FilledPrice ? parseFloat(order.FilledPrice) : undefined,
  };
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
  getQuote, getOptionsChain, placeOrder, modifyOrder, cancelOrder, getOrderStatus,
};

function resolveTradeAction(action: 'BUY' | 'SELL', type: string): string {
  if (type === 'STOCK') {
    return action === 'BUY' ? 'BUY' : 'SELL';
  }
  // Options: use BUY_TO_OPEN / SELL_TO_OPEN for now.
  // The agent can specify SELL_TO_CLOSE via the action field when closing.
  return action === 'BUY' ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN';
}

function buildOccSymbol(
  underlying: string,
  expiry: string,
  type: 'CALL' | 'PUT',
  strike: number
): string {
  const padded = underlying.toUpperCase().padEnd(6, ' ');
  const d = new Date(expiry);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const t = type === 'CALL' ? 'C' : 'P';
  const s = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${padded}${yy}${mm}${dd}${t}${s}`;
}
