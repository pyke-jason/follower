import type { BrokerService } from '../broker/interface.js';
import type { Quote, OptionsChain, OrderResult, OrderParams, OrderStatus } from '../broker/types.js';
import type { MarketDataProvider } from './market-data.js';
import type { SimClock } from './clock.js';
import { PositionTracker } from './position-tracker.js';

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

/**
 * SimBroker: Simulated broker for backtesting.
 * Implements BrokerService interface. Uses MarketDataProvider for prices
 * and SimClock for timestamps. Fills at current ask (buy) or bid (sell)
 * with configurable slippage.
 */
export class SimBroker implements BrokerService {
  private orderCounter = 0;
  private workingOrders = new Map<string, WorkingEntry>();

  constructor(
    private marketData: MarketDataProvider,
    private clock: SimClock,
    private tracker: PositionTracker,
    private slippagePct: number = 0.01,
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

    // LIMIT orders go into working queue (don't fill instantly)
    if (params.orderType === 'LIMIT') {
      this.workingOrders.set(orderId, {
        params,
        currentLimitPrice: params.limitPrice!,
        status: 'OPEN',
      });
      return { orderId, status: 'OPEN' };
    }

    // MARKET orders fill instantly
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

  /**
   * Process a quote tick against all working orders for the given symbol.
   * Fills BUY limit orders when limitPrice >= ask, SELL when limitPrice <= bid.
   * Returns array of fills.
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

      // Fill with slippage
      const basePrice = isBuy ? tick.ask : tick.bid;
      const slippage = basePrice * this.slippagePct;
      const fillPrice = isBuy
        ? basePrice + slippage
        : basePrice - slippage;

      const roundedFill = Math.round(fillPrice * 100) / 100;
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
    const basePrice = isBuy ? quote.ask : quote.bid;
    const slippage = basePrice * this.slippagePct;
    const fillPrice = isBuy
      ? basePrice + slippage
      : basePrice - slippage;

    // For spreads, use absolute value
    if (params.legs.length > 1) {
      return Math.abs(fillPrice);
    }
    return fillPrice;
  }
}
