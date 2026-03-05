import type { TradeLeg } from '../db/schema.js';
import type { Direction, OptionType, OrderType } from '../lib/enums.js';

/** A leg before fill — same shape as TradeLeg without fillPrice. */
export type OrderLeg = Omit<TradeLeg, 'fillPrice'>;

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
  optionType: OptionType;
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
  /** Enriched from reqAccountUpdates() subscription when active; undefined during cold start. */
  marketValue?: number;
  /** Enriched from reqAccountUpdates() subscription when active; undefined during cold start. */
  unrealizedPnl?: number;
  assetType: string;
  strikePrice?: number;
  expiry?: string;
  optionType?: OptionType;
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
  /** Margin cushion (percentage). From reqAccountUpdates subscription. */
  cushion?: number;
  /** Special Memorandum Account balance. From reqAccountUpdates subscription. */
  sma?: number;
  /** Remaining pattern day trades. From reqAccountUpdates subscription. */
  dayTradesRemaining?: number;
};

export type AdjustmentRule = {
  type: 'PRICE_CHASE';
  stepAmount: number;      // dollar amount to adjust each step (always positive)
  intervalSec: number;     // seconds between adjustments
  maxSteps?: number;       // stop chasing after N adjustments
  /** Worst acceptable chase price. BUY: ceiling (max willing to pay). SELL: floor (min willing to accept). */
  chaseLimit?: number;
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

/** Narrowed WorkingOrder for onFill callbacks — filled fields are guaranteed present. */
export type FilledWorkingOrder = WorkingOrder & {
  status: 'FILLED';
  filledPrice: number;
  filledAt: Date;
  fillTimestamp: string;
};

export type OrderParams = {
  symbol: string;
  strategy: string;
  direction: Direction;
  legs: OrderLeg[];
  orderType: OrderType;
  limitPrice?: number;
  /** Signals a position-reducing order — broker skips buying power gate. */
  isClosing: boolean;
};
