export type Bar = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type GetBarsParams = {
  symbol: string;
  interval: string;
  barsBack: number;
};

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
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  openInterest?: number;
};

export type OptionsChain = {
  symbol: string;
  expiry: string;
  optionType: 'CALL' | 'PUT';
  strikes: OptionsStrike[];
};

export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export type LegFill = {
  symbol: string;
  filledPrice: number;
  filledQuantity: number;
  commission?: number;
};

export type OrderResult = {
  orderId: string;
  status: OrderStatus;
  filledPrice?: number;
  filledQuantity?: number;
  commission?: number;
  fillTimestamp?: string;
  legFills?: LegFill[];
  message?: string;
};

export type BrokerPosition = {
  symbol: string;
  quantity: number;
  averageCost: number;
  marketValue: number;
  unrealizedPnl: number;
  assetType: string;
  strikePrice?: number;
  expiry?: string;
  optionType?: 'CALL' | 'PUT';
};

export type AccountBalance = {
  accountId: string;
  cashBalance: number;
  buyingPower: number;
  equity: number;
  marketValue: number;
  dayTradingBuyingPower?: number;
  unrealizedPnl: number;
  realizedPnl: number;
  timestamp: string;
  /** Total maintenance margin across all open positions (sim only). */
  maintenanceMargin?: number;
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
  filledQuantity?: number;
  commission?: number;
  fillTimestamp?: string;
  legFills?: LegFill[];
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
