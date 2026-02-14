export type Quote = {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  timestamp: string;
};

export type OptionsStrike = {
  strike: number;
  bid: number;
  ask: number;
  last: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  openInterest: number;
};

export type OptionsChain = {
  symbol: string;
  expiry: string;
  optionType: 'CALL' | 'PUT';
  strikes: OptionsStrike[];
};

export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export type OrderResult = {
  orderId: string;
  status: OrderStatus;
  filledPrice?: number;
};

export type AdjustmentRule = {
  type: 'PRICE_CHASE';
  stepAmount: number;      // dollar amount to adjust each step (always positive)
  intervalSec: number;     // seconds between adjustments
  maxSteps?: number;       // stop chasing after N adjustments
};

export type WorkingOrderParams = OrderParams & {
  adjustmentRules?: AdjustmentRule[];
  cancelAfterSec?: number;
};

export type WorkingOrder = {
  orderId: string;
  params: WorkingOrderParams;
  status: OrderStatus;
  currentLimitPrice: number;
  placedAt: Date;
  lastAdjustedAt: Date;
  adjustmentCount: number;
  filledPrice?: number;
  filledAt?: Date;
  cancelledAt?: Date;
};

export type OrderParams = {
  symbol: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  legs: Array<{
    strike: number;
    expiry: string;
    type: 'CALL' | 'PUT' | 'STOCK';
    action: 'BUY' | 'SELL';
    quantity: number;
  }>;
  orderType: 'MARKET' | 'LIMIT';
  limitPrice?: number;
};
