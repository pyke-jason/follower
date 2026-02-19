import type { BrokerService } from '../broker/interface.js';
import type { Quote, OptionsChain, OrderResult, OrderParams, OrderStatus, BrokerPosition, AccountBalance, Bar, GetBarsParams } from '../broker/types.js';
import type { BacktestPriceProvider } from './market-data.js';
import type { QuoteTick } from './databento-tape.js';
import type { SimClock } from './clock.js';
import { db, schema } from '../db/client.js';
import { and, eq, sql } from 'drizzle-orm';
import { isOpen, isClosed, forRun } from '../trades/filters.js';
import { createLogger } from '../lib/logger.js';
import type { FillModel } from './types.js';
import type { Trade } from '../db/schema.js';
import { roundCents, safeParseFloat } from '../lib/numbers.js';
import { computeTradePnl } from '../lib/pnl.js';
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

/** Direction of an order from the first leg's action — single derivation point. */
function isBuyOrder(params: OrderParams): boolean {
  return params.legs[0]?.action === 'BUY';
}

/**
 * LIMIT order fill check — single source of truth.
 * BUY fills when limit >= ask (buyer lifts the ask).
 * SELL fills when limit <= bid (seller hits the bid).
 */
function shouldFillLimit(isBuy: boolean, limitPrice: number, bid: number, ask: number): boolean {
  return isBuy ? limitPrice >= ask : limitPrice <= bid;
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

    // Warm the cache: fetch the options chain for each unique expiry+type combination.
    // getOptionsChain uses loadSpecificContracts (batch) which works reliably,
    // and caches individual OCC ticks so getQuote(occSymbol) below can find them.
    const seenChains = new Set<string>();
    for (const leg of optionLegs) {
      const chainKey = `${params.symbol}:${leg.expiry}:${leg.type}`;
      if (seenChains.has(chainKey)) continue;
      seenChains.add(chainKey);
      try {
        await this.marketData.getOptionsChain(
          params.symbol,
          leg.expiry,
          leg.type as 'CALL' | 'PUT',
          at,
        );
      } catch {
        // Chain fetch failed — individual quotes below will also fail
      }
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

    // Normalize to positive values with bid <= ask.
    // SELL legs produce negative net values (representing credit received);
    // normalize so fill computations and limit checks always use positive prices.
    const absBid = Math.abs(netBid);
    const absAsk = Math.abs(netAsk);
    netBid = Math.min(absBid, absAsk);
    netAsk = Math.max(absBid, absAsk);

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

  /**
   * Fill a working order: update status, remove from map, emit event.
   * Shared by processQuoteTick and advanceTo to eliminate duplicated fill logic.
   */
  private fillWorkingOrder(orderId: string, entry: WorkingEntry, symbol: string, timestamp: Date): SimFillEvent {
    const roundedFill = roundCents(entry.currentLimitPrice);
    entry.status = 'FILLED';
    entry.filledPrice = roundedFill;
    this.workingOrders.delete(orderId);

    const side = isBuyOrder(entry.params) ? 'BUY' : 'SELL';
    log.debug(`Fill: ${orderId} ${side} ${symbol} @ $${roundedFill}`);

    return {
      orderId,
      symbol,
      side,
      price: roundedFill,
      quantity: entry.params.legs[0]?.quantity ?? 1,
      timestamp,
    };
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

      if (shouldFillLimit(isBuyOrder(params), params.limitPrice, quote.bid, quote.ask)) {
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
    const fillPrice = computeModelFillPrice({
      fillModel: this.fillModel,
      bid: quote.bid,
      ask: quote.ask,
      isBuy: isBuyOrder(params),
      legCount: params.legs.length || 1,
    });
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

  /**
   * Get the current mid-price quote for a trade position.
   * For STOCK: fetches equity quote directly.
   * For options: re-quotes the spread via getOptionSpreadQuote using stored legs.
   */
  private async getTradeQuote(
    row: { symbol: string; strategy: string; legs: unknown },
    at: Date,
  ): Promise<Quote> {
    if (row.strategy === 'STOCK') {
      return this.marketData.getQuote(row.symbol, at);
    }

    // Parse stored legs and build minimal OrderParams for getOptionSpreadQuote
    const storedLegs = (typeof row.legs === 'string' ? JSON.parse(row.legs) : row.legs) as Array<{
      strike: number; expiry: string; type: string; action: string; quantity?: number;
    }>;
    const params: OrderParams = {
      symbol: row.symbol,
      strategy: row.strategy,
      direction: 'LONG', // direction doesn't affect spread quote computation
      legs: storedLegs.map(l => ({
        strike: l.strike,
        expiry: l.expiry,
        type: l.type as 'CALL' | 'PUT' | 'STOCK',
        action: l.action as 'BUY' | 'SELL',
        quantity: l.quantity ?? 1,
      })),
      orderType: 'MARKET',
    };
    return this.getOptionSpreadQuote(params, at);
  }

  // ─── Shared internals ────────────────────────────────────

  /** Get mark price (mid) for a trade at a given time. Returns null on data failure. */
  private async getMarkPrice(
    row: { symbol: string; strategy: string; legs: unknown },
    at: Date,
  ): Promise<number | null> {
    try {
      const quote = await this.getTradeQuote(row, at);
      return (quote.bid + quote.ask) / 2;
    } catch {
      return null;
    }
  }

  /** Build a map of trade ID -> current mark price for all open positions. */
  async markToMarket(at?: Date): Promise<Map<string, number>> {
    const time = at ?? this.clock.now();
    const markPrices = new Map<string, number>();
    const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(this.backtestRunId)));

    for (const t of openTrades) {
      const mark = await this.getMarkPrice(t, time);
      if (mark != null) markPrices.set(t.id, mark);
    }
    return markPrices;
  }

  /** Close a specific trade at a given price/time and record PnL. */
  async closePositionAtPrice(tradeId: string, exitPrice: number, closedAt: string): Promise<{ pnl: number }> {
    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, tradeId));
    if (!trade) throw new Error(`Trade ${tradeId} not found`);

    const pnl = computeTradePnl({
      entryPrice: safeParseFloat(trade.entryPrice),
      exitPrice,
      direction: trade.direction as 'LONG' | 'SHORT',
      strategy: trade.strategy,
      quantity: trade.quantity ?? 1,
    });

    await db.update(schema.trades)
      .set({
        status: 'CLOSED',
        exitPrice: String(exitPrice),
        pnl: String(pnl),
        closedAt,
      })
      .where(eq(schema.trades.id, tradeId));

    return { pnl };
  }

  /** Sum unrealized PnL across all open positions using current marks. */
  async getUnrealizedPnl(at?: Date): Promise<number> {
    const time = at ?? this.clock.now();
    const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(this.backtestRunId)));

    let total = 0;
    for (const row of openTrades) {
      const mark = await this.getMarkPrice(row, time);
      if (mark == null) continue;
      total += computeTradePnl({
        entryPrice: safeParseFloat(row.entryPrice),
        exitPrice: mark,
        direction: row.direction as 'LONG' | 'SHORT',
        strategy: row.strategy,
        quantity: row.quantity ?? 1,
      });
    }
    return roundCents(total);
  }

  /**
   * Sweep expired options: close all open option positions with expired legs
   * at intrinsic value (ITM) or $0 (OTM).
   */
  async sweepExpired(currentDate: string): Promise<number> {
    let closedCount = 0;
    const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(this.backtestRunId)));

    for (const t of openTrades) {
      if (t.strategy === 'STOCK') continue;
      const legs = Array.isArray(t.legs) ? t.legs as { symbol: string; strike: number; expiry: string; type: string; action: string; quantity: number; fillPrice: number }[] : [];
      if (legs.length === 0) continue;

      const hasExpiredLeg = legs.some((leg) => leg.expiry <= currentDate);
      if (!hasExpiredLeg) continue;

      // Compute intrinsic value at expiry
      let netIntrinsic = 0;
      for (const leg of legs) {
        if (leg.expiry > currentDate) continue;
        if (leg.type === 'STOCK') continue;

        let underlyingPrice: number;
        try {
          const expiryDate = new Date(leg.expiry + 'T20:00:00Z');
          const quote = await this.marketData.getQuote(t.symbol, expiryDate);
          underlyingPrice = (quote.bid + quote.ask) / 2;
        } catch {
          underlyingPrice = leg.type === 'CALL' ? 0 : Infinity;
        }

        const intrinsic = leg.type === 'CALL'
          ? Math.max(0, underlyingPrice - leg.strike)
          : Math.max(0, leg.strike - underlyingPrice);

        netIntrinsic += leg.action === 'BUY' ? intrinsic : -intrinsic;
      }

      // Use abs: netIntrinsic is signed (positive for debit/long positions,
      // negative for credit/short positions). Exit price is always the
      // absolute cost to settle the spread at expiry.
      const exitPrice = Math.abs(netIntrinsic);
      const expiryTimestamp = new Date(currentDate + 'T20:00:00Z');
      await this.closePositionAtPrice(t.id, exitPrice, expiryTimestamp.toISOString());

      log.debug(`EXPIRE: ${t.id} ${t.symbol} ${t.strategy} intrinsic=$${netIntrinsic.toFixed(2)} exit=$${exitPrice.toFixed(2)}`);
      closedCount++;
    }

    return closedCount;
  }

  /** Force-close all open positions at current mark prices. */
  async forceCloseAll(at: Date): Promise<number> {
    const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(this.backtestRunId)));
    let totalPnl = 0;

    for (const t of openTrades) {
      const mark = await this.getMarkPrice(t, at);
      if (mark == null) {
        log.warn(`forceCloseAll: no mark for ${t.id} (${t.symbol} ${t.strategy}), using entry price`);
      }
      const exitPrice = mark ?? safeParseFloat(t.entryPrice);
      const { pnl } = await this.closePositionAtPrice(t.id, exitPrice, at.toISOString());
      totalPnl += pnl;
    }

    return roundCents(totalPnl);
  }

  /** Get count of open positions for this run. */
  async getOpenPositionCount(): Promise<number> {
    const [row] = await db.select({ count: sql<number>`COUNT(*)` })
      .from(schema.trades)
      .where(and(isOpen, forRun(this.backtestRunId)));
    return row?.count ?? 0;
  }

  /** Get all open trade rows for this run, optionally filtered by trader/symbol. */
  async getOpenTrades(filters?: { trader?: string; symbol?: string }): Promise<Trade[]> {
    const conditions = [isOpen, forRun(this.backtestRunId)];
    if (filters?.trader) conditions.push(eq(schema.trades.trader, filters.trader));
    if (filters?.symbol) conditions.push(eq(schema.trades.symbol, filters.symbol));
    return db.select().from(schema.trades).where(and(...conditions));
  }

  // ─── BrokerService interface ────────────────────────────

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

      const currentPrice = await this.getMarkPrice(row, this.clock.now()) ?? entryPrice;
      const unrealizedPnl = computeTradePnl({
        entryPrice, exitPrice: currentPrice, direction, strategy, quantity,
      });
      const contractMultiplier = strategy === 'STOCK' ? 1 : 100;
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
    const [realizedRow] = await db
      .select({ total: sql<number>`COALESCE(SUM(CAST(${schema.trades.pnl} AS REAL)), 0)` })
      .from(schema.trades)
      .where(and(isClosed, forRun(this.backtestRunId)));
    const realizedPnl = roundCents(realizedRow?.total ?? 0);

    const unrealizedPnl = await this.getUnrealizedPnl();

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
   * Uses shouldFillLimit (BUY: limit >= ask, SELL: limit <= bid).
   */
  processQuoteTick(tick: QuoteTick): SimFillEvent[] {
    const fills: SimFillEvent[] = [];

    for (const [orderId, entry] of this.workingOrders) {
      if (entry.status !== 'OPEN') continue;
      if (entry.params.symbol !== tick.symbol) continue;
      if (!shouldFillLimit(isBuyOrder(entry.params), entry.currentLimitPrice, tick.bid, tick.ask)) continue;

      fills.push(this.fillWorkingOrder(orderId, entry, tick.symbol, tick.timestamp));
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
        if (shouldFillLimit(isBuyOrder(entry.params), entry.currentLimitPrice, quote.bid, quote.ask)) {
          allFills.push(this.fillWorkingOrder(orderId, entry, entry.params.symbol, time));
        }
      } catch {
        // No option market data at this time — leave order working
      }
    }

    this.lastAdvanceTime = time;
    return allFills;
  }

}
