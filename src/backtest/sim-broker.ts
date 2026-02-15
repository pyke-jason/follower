import type { BrokerService } from '../broker/interface.js';
import type { Quote, OptionsChain, OrderResult, OrderParams, OrderStatus, BrokerPosition, AccountBalance, Bar, GetBarsParams } from '../broker/types.js';
import type { MarketDataProvider } from './market-data.js';
import type { SimClock } from './clock.js';
import { PositionTracker } from './position-tracker.js';
import type { FillModel } from './types.js';

export type QuoteTick = {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: Date;
};

export type SimFillEvent = {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  timestamp: Date;
};

type WorkingEntry = {
  params: OrderParams;
  currentLimitPrice: number;
  status: OrderStatus;
  filledPrice?: number;
};

/** ORATS fill percentages by leg count */
const ORATS_FILL_PCT: Record<number, number> = {
  1: 0.75,
  2: 0.66,
  3: 0.56,
  4: 0.53,
};

function getOratsFillPct(legCount: number): number {
  return ORATS_FILL_PCT[Math.min(Math.max(legCount, 1), 4)] ?? 0.75;
}

/** Compute fill price for a given model, bid/ask, direction, and leg count */
export function computeModelFillPrice(
  fillModel: FillModel,
  bid: number,
  ask: number,
  isBuy: boolean,
  legCount: number,
): number {
  switch (fillModel) {
    case 'midpoint':
      return (bid + ask) / 2;
    case 'natural':
      return isBuy ? ask : bid;
    case 'orats':
    default: {
      const fillPct = getOratsFillPct(legCount);
      return isBuy
        ? bid + (ask - bid) * fillPct
        : ask - (ask - bid) * fillPct;
    }
  }
}

/**
 * SimBroker: Simulated broker for backtesting.
 * Implements BrokerService interface. Uses MarketDataProvider for prices
 * and SimClock for timestamps. Fills using a configurable fill model
 * (ORATS spread-width, midpoint, or natural price).
 */
export class SimBroker implements BrokerService {
  private orderCounter = 0;
  private workingOrders = new Map<string, WorkingEntry>();

  constructor(
    private marketData: MarketDataProvider,
    private clock: SimClock,
    private tracker: PositionTracker,
    private fillModel: FillModel = 'orats',
  ) {}

  async getQuote(symbol: string): Promise<Quote> {
    return this.marketData.getQuote(symbol, this.clock.now());
  }

  async getOptionsChain(
    symbol: string,
    expiry: string,
    optionType: 'CALL' | 'PUT',
  ): Promise<OptionsChain> {
    return this.marketData.getOptionsChain(symbol, expiry, optionType, this.clock.now());
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const orderId = `SIM-${++this.orderCounter}`;

    if (params.orderType === 'LIMIT') {
      // Fill immediately if limit is within the current spread
      const quote = await this.getQuote(params.symbol);
      const isBuy = params.legs[0]?.action === 'BUY';
      const withinSpread = isBuy
        ? params.limitPrice! >= quote.bid
        : params.limitPrice! <= quote.ask;

      if (withinSpread) {
        return {
          orderId,
          status: 'FILLED',
          filledPrice: Math.round(params.limitPrice! * 100) / 100,
        };
      }

      // Queue for tick-based filling
      this.workingOrders.set(orderId, {
        params,
        currentLimitPrice: params.limitPrice!,
        status: 'OPEN',
      });
      return { orderId, status: 'OPEN' };
    }

    // MARKET orders fill instantly using the fill model
    const quote = await this.getQuote(params.symbol);
    const fillPrice = this.computeFillPrice(params, quote);

    return {
      orderId,
      status: 'FILLED',
      filledPrice: Math.round(fillPrice * 100) / 100,
    };
  }

  async modifyOrder(orderId: string, newLimitPrice: number): Promise<OrderResult> {
    const entry = this.workingOrders.get(orderId);
    if (!entry) {
      return { orderId, status: 'REJECTED' };
    }
    if (entry.status !== 'OPEN') {
      return { orderId, status: entry.status };
    }
    entry.currentLimitPrice = newLimitPrice;
    return { orderId, status: 'OPEN' };
  }

  async cancelOrder(orderId: string): Promise<OrderResult> {
    const entry = this.workingOrders.get(orderId);
    if (!entry) {
      return { orderId, status: 'REJECTED' };
    }
    entry.status = 'CANCELLED';
    this.workingOrders.delete(orderId);
    return { orderId, status: 'CANCELLED' };
  }

  async getOrderStatus(orderId: string): Promise<OrderResult> {
    const entry = this.workingOrders.get(orderId);
    if (!entry) {
      return { orderId, status: 'REJECTED' };
    }
    return {
      orderId,
      status: entry.status,
      filledPrice: entry.filledPrice,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return this.tracker.getOpen().map((pos) => ({
      symbol: pos.symbol,
      quantity: pos.quantity,
      averageCost: pos.entryPrice,
      marketValue: 0,
      unrealizedPnl: 0,
      assetType: pos.strategy === 'STOCK' ? 'EQ' : 'OP',
    }));
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const totalPnl = this.tracker.getTotalPnl();
    const startingEquity = 100_000; // simulated starting balance
    const equity = startingEquity + totalPnl;
    return {
      accountId: 'SIM',
      cashBalance: equity,
      buyingPower: equity,
      equity,
      marketValue: 0,
      unrealizedPnl: 0,
      realizedPnl: totalPnl,
      timestamp: this.clock.now().toISOString(),
    };
  }

  async getBars(params: GetBarsParams): Promise<Bar[]> {
    return this.marketData.getBars(params.symbol, params.barsBack, this.clock.now());
  }

  /**
   * Process a quote tick against all working orders for the given symbol.
   * Fills BUY limit orders when limitPrice >= ask, SELL when limitPrice <= bid.
   * Fills at the limit price (standard LIMIT order behavior).
   */
  processQuoteTick(tick: QuoteTick): SimFillEvent[] {
    const fills: SimFillEvent[] = [];

    for (const [orderId, entry] of this.workingOrders) {
      if (entry.status !== 'OPEN') continue;
      if (entry.params.symbol !== tick.symbol) continue;

      const isBuy = entry.params.legs[0]?.action === 'BUY';

      // BUY fills when limit >= ask; SELL fills when limit <= bid
      const shouldFill = isBuy
        ? entry.currentLimitPrice >= tick.ask
        : entry.currentLimitPrice <= tick.bid;

      if (!shouldFill) continue;

      // Fill at limit price (standard LIMIT order behavior)
      const roundedFill = Math.round(entry.currentLimitPrice * 100) / 100;
      entry.status = 'FILLED';
      entry.filledPrice = roundedFill;
      this.workingOrders.delete(orderId);

      fills.push({
        orderId,
        symbol: tick.symbol,
        side: isBuy ? 'BUY' : 'SELL',
        price: roundedFill,
        quantity: entry.params.legs[0]?.quantity ?? 1,
        timestamp: tick.timestamp,
      });
    }

    return fills;
  }

  private computeFillPrice(params: OrderParams, quote: Quote): number {
    const isBuy = params.legs[0]?.action === 'BUY';
    const legCount = params.legs.length || 1;
    const price = computeModelFillPrice(this.fillModel, quote.bid, quote.ask, isBuy, legCount);

    // For spreads, use absolute value
    if (params.legs.length > 1) {
      return Math.abs(price);
    }
    return price;
  }
}
