import type { Quote, OptionsChain, OrderResult, OrderParams, BrokerPosition, AccountBalance, Bar, GetBarsParams } from './types.js';

export interface BrokerService {
  getQuote(symbol: string): Promise<Quote>;
  getOptionsChain(symbol: string, expiry: string, optionType: 'CALL' | 'PUT'): Promise<OptionsChain>;
  placeOrder(params: OrderParams): Promise<OrderResult>;
  modifyOrder(orderId: string, newLimitPrice: number): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<OrderResult>;
  getOrderStatus(orderId: string): Promise<OrderResult>;
  getPositions(): Promise<BrokerPosition[]>;
  getAccountBalance(): Promise<AccountBalance>;
  getBars(params: GetBarsParams): Promise<Bar[]>;
}
