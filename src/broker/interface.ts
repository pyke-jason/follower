import type { Quote, OptionsChain, OrderResult, OrderParams } from './types.js';

export interface BrokerService {
  getQuote(symbol: string): Promise<Quote>;
  getOptionsChain(symbol: string, expiry: string, optionType: 'CALL' | 'PUT'): Promise<OptionsChain>;
  placeOrder(params: OrderParams): Promise<OrderResult>;
  modifyOrder(orderId: string, newLimitPrice: number): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<OrderResult>;
  getOrderStatus(orderId: string): Promise<OrderResult>;
}
