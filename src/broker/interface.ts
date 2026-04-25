import type { Quote, OrderResult, OrderParams, StopOrderParams, BrokerPosition, AccountBalance } from './types.js';

export interface BrokerService {
  getQuote(symbol: string): Promise<Quote>;
  placeOrder(params: OrderParams): Promise<OrderResult>;
  modifyOrder(orderId: string, newLimitPrice: number): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<OrderResult>;
  getOrderStatus(orderId: string): Promise<OrderResult>;
  getPositions(): Promise<BrokerPosition[]>;
  getAccountBalance(): Promise<AccountBalance>;
  /** Lightweight health probe. Returns false if broker is unreachable or in maintenance. */
  isHealthy(): Promise<boolean>;
  /**
   * Place a GTC stop order that lives at the broker independently of the bot process.
   * Supported strategies: STOCK, CALL, PUT. Throws for spreads.
   */
  placeStopOrder(params: StopOrderParams): Promise<OrderResult>;
}
