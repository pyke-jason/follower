import type { Quote, OrderResult, OrderParams, BrokerPosition, AccountBalance, Bar, GetBarsParams } from './types.js';

export interface BrokerService {
  getQuote(symbol: string): Promise<Quote>;
  placeOrder(params: OrderParams): Promise<OrderResult>;
  modifyOrder(orderId: string, newLimitPrice: number): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<OrderResult>;
  getOrderStatus(orderId: string): Promise<OrderResult>;
  getPositions(): Promise<BrokerPosition[]>;
  getAccountBalance(): Promise<AccountBalance>;
  getBars(params: GetBarsParams): Promise<Bar[]>;
}
