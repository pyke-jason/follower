import type { Quote, OrderResult, OrderParams, BrokerPosition, AccountBalance } from './types.js';

export interface BrokerService {
  getQuote(symbol: string): Promise<Quote>;
  placeOrder(params: OrderParams): Promise<OrderResult>;
  modifyOrder(orderId: string, newLimitPrice: number): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<OrderResult>;
  /** Cancel all open working orders at the broker (kill switch). */
  cancelAllOrders(): Promise<void>;
  getOrderStatus(orderId: string): Promise<OrderResult>;
  getPositions(): Promise<BrokerPosition[]>;
  getAccountBalance(): Promise<AccountBalance>;
  /** Lightweight health probe. Returns false if broker is unreachable or in maintenance. */
  isHealthy(): Promise<boolean>;
}
