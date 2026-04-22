import type { WorkingOrderResponse } from './http-schemas.js';

export type StoredManualOrder = WorkingOrderResponse & {
  tradeId: string;
  channelId: string;
  trader: string;
  tradeRecordedAt?: string;
};

const manualOrders = new Map<string, StoredManualOrder>();

function isTerminal(status: StoredManualOrder['status']): boolean {
  return status === 'FILLED' || status === 'CANCELLED' || status === 'REJECTED';
}

export function getManualOrder(orderId: string): StoredManualOrder | undefined {
  return manualOrders.get(orderId);
}

export function upsertManualOrder(order: StoredManualOrder): StoredManualOrder {
  manualOrders.set(order.orderId, order);
  return order;
}

export function findActiveManualOrderForTrade(tradeId: string): StoredManualOrder | undefined {
  const matches = Array.from(manualOrders.values())
    .filter((order) => order.tradeId === tradeId && !isTerminal(order.status))
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  return matches[0];
}

export function markManualOrderTradeRecorded(orderId: string): StoredManualOrder | undefined {
  const existing = manualOrders.get(orderId);
  if (!existing) return undefined;
  const next = { ...existing, tradeRecordedAt: new Date().toISOString() };
  manualOrders.set(orderId, next);
  return next;
}

export function toWorkingOrderResponse(order: StoredManualOrder): WorkingOrderResponse {
  const { tradeId: _tradeId, channelId: _channelId, trader: _trader, tradeRecordedAt: _tradeRecordedAt, ...publicOrder } = order;
  return publicOrder;
}
