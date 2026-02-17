import type { BrokerService } from '../broker/interface.js';
import type { Quote, OptionsChain, OrderResult, OrderParams, OrderStatus, BrokerPosition, AccountBalance, Bar, GetBarsParams } from '../broker/types.js';
import type { BacktestPriceProvider } from './market-data.js';
import type { QuoteTick } from './databento-tape.js';
import type { SimClock } from './clock.js';
import { db, schema } from '../db/client.js';
import { and, sql } from 'drizzle-orm';
import { isOpen, isClosed, forRun } from '../trades/filters.js';
import { createLogger } from '../lib/logger.js';
import type { FillModel } from './types.js';
import { roundCents, safeParseFloat } from '../lib/numbers.js';
import { formatOccSymbol } from './occ-symbology.js';

const log = createLogger('SimBroker');

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
  isOptionOrder: boolean;
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

export type FillPriceParams = {
  fillModel: FillModel;
  bid: number;
  ask: number;
  isBuy: boolean;
  legCount: number;
};

/** Compute fill price for a given model, bid/ask, direction, and leg count */
export function computeModelFillPrice(params: FillPriceParams): number {
  const { fillModel, bid, ask, isBuy, legCount } = params;
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

  /** Last time advanceTo() was called — used to determine tick range for next call. */
  private lastAdvanceTime: Date | null = null;

  constructor(
    private marketData: BacktestPriceProvider,
    private clock: SimClock,
    private backtestRunId: string,
    private fillModel: FillModel = 'orats',
    private startingEquity: number = 100_000,
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

  /**
   * Get a synthetic quote for an options order by fetching individual OCC leg quotes
   * and computing net spread bid/ask. For single-leg options, returns the option's
   * own bid/ask. For multi-leg spreads, computes net values and normalizes to positive.
   */
  private async getOptionSpreadQuote(params: OrderParams, at: Date): Promise<Quote> {
    const optionLegs = params.legs.filter(l => l.type !== 'STOCK');
    if (optionLegs.length === 0) {
      throw new Error('getOptionSpreadQuote called with no option legs');
    }

    let netBid = 0;
    let netAsk = 0;

    for (const leg of optionLegs) {
      const occSymbol = formatOccSymbol({
        underlying: params.symbol,
        expiration: leg.expiry,
        type: leg.type as 'CALL' | 'PUT',
        strike: leg.strike,
      });

      const quote = await this.marketData.getQuote(occSymbol, at);

      if (leg.action === 'BUY') {
        netBid += quote.bid;
        netAsk += quote.ask;
      } else {
        netBid -= quote.ask;
        netAsk -= quote.bid;
      }
    }

    // For multi-leg spreads, normalize to positive values with bid <= ask
    if (optionLegs.length > 1) {
      const absBid = Math.abs(netBid);
      const absAsk = Math.abs(netAsk);
      netBid = Math.min(absBid, absAsk);
      netAsk = Math.max(absBid, absAsk);
    }

    const mid = (netBid + netAsk) / 2;
    return {
      symbol: params.symbol,
      bid: netBid,
      ask: netAsk,
      last: mid,
      volume: 0,
      timestamp: at.toISOString(),
    };
  }

  private hasOptionLegs(params: OrderParams): boolean {
    return params.legs.some(l => l.type !== 'STOCK');
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const orderId = `SIM-${++this.orderCounter}`;
    const legCount = params.legs.length || 1;

    log.debug(`placeOrder: ${params.orderType} ${params.symbol} legs=${legCount} limit=${params.limitPrice ?? 'MKT'}`);

    const isOptions = this.hasOptionLegs(params);

    if (params.orderType === 'LIMIT') {
      if (params.limitPrice == null) {
        log.debug(`  LIMIT rejected: no limit price`);
        return { orderId, status: 'REJECTED' };
      }

      // Fill immediately if limit is within the current spread
      let quote: Quote;
      try {
        quote = isOptions
          ? await this.getOptionSpreadQuote(params, this.clock.now())
          : await this.getQuote(params.symbol);
      } catch {
        log.debug(`  LIMIT rejected: no market data for ${params.symbol}`);
        return { orderId, status: 'REJECTED', message: `No market data for ${params.symbol}` };
      }

      const isBuy = params.legs[0]?.action === 'BUY';
      const withinSpread = isBuy
        ? params.limitPrice >= quote.bid
        : params.limitPrice <= quote.ask;

      if (withinSpread) {
        const filledPrice = roundCents(params.limitPrice);
        log.debug(`  LIMIT filled immediately @ $${filledPrice} (bid=${quote.bid.toFixed(2)} ask=${quote.ask.toFixed(2)}${isOptions ? ' [options]' : ''})`);
        return { orderId, status: 'FILLED', filledPrice, fillTimestamp: this.clock.now().toISOString() };
      }

      // Queue for tick-based filling
      this.workingOrders.set(orderId, {
        params,
        currentLimitPrice: params.limitPrice,
        status: 'OPEN',
        isOptionOrder: isOptions,
      });
      log.debug(`  LIMIT queued as working ${orderId} @ $${params.limitPrice} (bid=${quote.bid.toFixed(2)} ask=${quote.ask.toFixed(2)}${isOptions ? ' [options]' : ''})`);
      return { orderId, status: 'OPEN' };
    }

    // MARKET orders fill instantly using the fill model
    let quote: Quote;
    try {
      quote = isOptions
        ? await this.getOptionSpreadQuote(params, this.clock.now())
        : await this.getQuote(params.symbol);
    } catch {
      log.debug(`  MARKET rejected: no market data for ${params.symbol}`);
      return { orderId, status: 'REJECTED', message: `No market data for ${params.symbol}` };
    }
    const fillPrice = this.computeFillPrice(params, quote);
    const roundedFill = roundCents(fillPrice);

    log.debug(`  MARKET filled @ $${roundedFill} (bid=${quote.bid.toFixed(2)} ask=${quote.ask.toFixed(2)} model=${this.fillModel}${isOptions ? ' [options]' : ''})`);

    return {
      orderId,
      status: 'FILLED',
      filledPrice: roundedFill,
      fillTimestamp: this.clock.now().toISOString(),
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
    const openTrades = await db
      .select()
      .from(schema.trades)
      .where(and(isOpen, forRun(this.backtestRunId)));

    const positions: BrokerPosition[] = [];
    for (const row of openTrades) {
      const entryPrice = safeParseFloat(row.entryPrice);
      const quantity = row.quantity ?? 1;
      const direction = row.direction as 'LONG' | 'SHORT';
      const strategy = row.strategy;

      let currentPrice = entryPrice;
      try {
        const quote = await this.marketData.getQuote(row.symbol, this.clock.now());
        currentPrice = (quote.bid + quote.ask) / 2;
      } catch {
        // No market data — fall back to entry price (unrealized = 0)
      }

      const diff = currentPrice - entryPrice;
      const multiplier = direction === 'LONG' ? 1 : -1;
      const contractMultiplier = strategy === 'STOCK' ? 1 : 100;
      const unrealizedPnl = roundCents(diff * multiplier * quantity * contractMultiplier);
      const marketValue = roundCents(currentPrice * quantity * contractMultiplier);

      positions.push({
        symbol: row.symbol,
        quantity,
        averageCost: entryPrice,
        marketValue,
        unrealizedPnl,
        assetType: strategy === 'STOCK' ? 'EQ' : 'OP',
      });
    }
    return positions;
  }

  async getAccountBalance(): Promise<AccountBalance> {
    // Realized PnL: sum of pnl from all closed trades in this run
    const [realizedRow] = await db
      .select({ total: sql<number>`COALESCE(SUM(CAST(${schema.trades.pnl} AS REAL)), 0)` })
      .from(schema.trades)
      .where(and(isClosed, forRun(this.backtestRunId)));
    const realizedPnl = roundCents(realizedRow?.total ?? 0);

    // Unrealized PnL: compute from open positions + current market prices
    const openTrades = await db
      .select()
      .from(schema.trades)
      .where(and(isOpen, forRun(this.backtestRunId)));

    let unrealizedPnl = 0;
    for (const row of openTrades) {
      try {
        const entryPrice = safeParseFloat(row.entryPrice);
        const quantity = row.quantity ?? 1;
        const direction = row.direction as 'LONG' | 'SHORT';
        const strategy = row.strategy;

        const quote = await this.marketData.getQuote(row.symbol, this.clock.now());
        const currentPrice = (quote.bid + quote.ask) / 2;
        const diff = currentPrice - entryPrice;
        const multiplier = direction === 'LONG' ? 1 : -1;
        const contractMultiplier = strategy === 'STOCK' ? 1 : 100;
        unrealizedPnl += diff * multiplier * quantity * contractMultiplier;
      } catch {
        // No market data for this position — skip (conservative: unrealized = 0)
      }
    }
    unrealizedPnl = roundCents(unrealizedPnl);

    const equity = this.startingEquity + realizedPnl + unrealizedPnl;
    return {
      accountId: 'SIM',
      cashBalance: this.startingEquity + realizedPnl,
      buyingPower: equity,
      equity,
      marketValue: roundCents(unrealizedPnl),
      unrealizedPnl,
      realizedPnl,
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
      const roundedFill = roundCents(entry.currentLimitPrice);
      entry.status = 'FILLED';
      entry.filledPrice = roundedFill;
      this.workingOrders.delete(orderId);

      const side = isBuy ? 'BUY' : 'SELL';
      log.debug(`Tick fill: ${orderId} ${side} ${tick.symbol} @ $${roundedFill} (bid=${tick.bid} ask=${tick.ask})`);

      fills.push({
        orderId,
        symbol: tick.symbol,
        side,
        price: roundedFill,
        quantity: entry.params.legs[0]?.quantity ?? 1,
        timestamp: tick.timestamp,
      });
    }

    return fills;
  }

  /** Return symbols that have at least one OPEN working order. */
  getWorkingSymbols(): string[] {
    const symbols = new Set<string>();
    for (const entry of this.workingOrders.values()) {
      if (entry.status === 'OPEN') symbols.add(entry.params.symbol);
    }
    return [...symbols];
  }

  /**
   * Replay ticks between the last advance time and `time` for all symbols
   * with working orders. No working orders = no I/O.
   *
   * Equity orders: replay underlying ticks via processQuoteTick().
   * Option orders: re-quote net spread at target time via getOptionSpreadQuote().
   */
  async advanceTo(time: Date): Promise<SimFillEvent[]> {
    if (this.workingOrders.size === 0) {
      this.lastAdvanceTime = time;
      return [];
    }

    // Separate equity and option working orders
    const equitySymbols = new Set<string>();
    const optionOrderIds: string[] = [];

    for (const [orderId, entry] of this.workingOrders) {
      if (entry.status !== 'OPEN') continue;
      if (entry.isOptionOrder) {
        optionOrderIds.push(orderId);
      } else {
        equitySymbols.add(entry.params.symbol);
      }
    }

    const from = this.lastAdvanceTime ?? time;
    const allFills: SimFillEvent[] = [];

    // Process equity working orders via tick replay (existing logic)
    for (const symbol of equitySymbols) {
      const ticks = await this.marketData.getTicksInRange(symbol, from, time);
      for (const tick of ticks) {
        const fills = this.processQuoteTick(tick);
        allFills.push(...fills);
      }
    }

    // Process option working orders via re-quote at target time
    for (const orderId of optionOrderIds) {
      const entry = this.workingOrders.get(orderId);
      if (!entry || entry.status !== 'OPEN') continue;

      try {
        const quote = await this.getOptionSpreadQuote(entry.params, time);
        const isBuy = entry.params.legs[0]?.action === 'BUY';
        const shouldFill = isBuy
          ? entry.currentLimitPrice >= quote.bid
          : entry.currentLimitPrice <= quote.ask;

        if (shouldFill) {
          const roundedFill = roundCents(entry.currentLimitPrice);
          entry.status = 'FILLED';
          entry.filledPrice = roundedFill;
          this.workingOrders.delete(orderId);

          const side = isBuy ? 'BUY' : 'SELL';
          log.debug(`Option fill: ${orderId} ${side} ${entry.params.symbol} @ $${roundedFill} (bid=${quote.bid.toFixed(2)} ask=${quote.ask.toFixed(2)})`);

          allFills.push({
            orderId,
            symbol: entry.params.symbol,
            side,
            price: roundedFill,
            quantity: entry.params.legs[0]?.quantity ?? 1,
            timestamp: time,
          });
        }
      } catch {
        // No option market data at this time — leave order working
      }
    }

    this.lastAdvanceTime = time;
    return allFills;
  }

  private computeFillPrice(params: OrderParams, quote: Quote): number {
    const isBuy = params.legs[0]?.action === 'BUY';
    const legCount = params.legs.length || 1;
    const price = computeModelFillPrice({ fillModel: this.fillModel, bid: quote.bid, ask: quote.ask, isBuy, legCount });

    // For spreads, use absolute value
    if (params.legs.length > 1) {
      return Math.abs(price);
    }
    return price;
  }
}
