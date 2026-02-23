import type { BrokerService } from '../broker/interface.js';
import type { Quote, OrderResult, OrderParams, OrderStatus, BrokerPosition, AccountBalance, Bar, GetBarsParams } from '../broker/types.js';
import type { BacktestPriceProvider } from './market-data.js';
import type { QuoteTick } from './databento-tape.js';
import type { SimClock } from './clock.js';
import { db, schema } from '../db/client.js';
import { and, eq, sql } from 'drizzle-orm';
import { isOpen, isClosed, forRun, forSymbol, forTrader, forStrategy, type PositionFilters } from '../trades/filters.js';
import { createLogger } from '../lib/logger.js';
import type { FillModel } from './types.js';
import type { Trade, TradeLeg } from '../db/schema.js';
import { roundCents, safeParseFloat } from '../lib/numbers.js';
import { computeTradePnl } from '../lib/pnl.js';
import { formatOccSymbol } from './occ-symbology.js';
import { parseLegs, parseDirection } from '../db/parse.js';
import { computeMarginRequirement } from './margin-model.js';
import { contractMultiplier, assetType, tradeQty } from '../lib/trade.js';
import { recordTrade } from '../trades/record-trade.js';

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

/** Direction of an order — uses explicit direction rather than first leg's action,
 *  which is fragile for multi-leg strategies where leg ordering isn't guaranteed. */
function isBuyOrder(params: OrderParams): boolean {
  return params.direction === 'LONG';
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
  /** Tracks filled orders so getOrderStatus() returns FILLED even after removal from workingOrders. */
  private filledOrders = new Map<string, { price: number; timestamp: string }>();

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
   *
   * Price improvement: fills at the better of the limit price or the market
   * price at fill time (BUY: min(limit, ask), SELL: max(limit, bid)).
   */
  private fillWorkingOrder(orderId: string, entry: WorkingEntry, symbol: string, timestamp: Date, marketBid: number, marketAsk: number): SimFillEvent {
    const isBuy = isBuyOrder(entry.params);
    const improved = isBuy
      ? Math.min(entry.currentLimitPrice, marketAsk)
      : Math.max(entry.currentLimitPrice, marketBid);
    const roundedFill = roundCents(improved);
    entry.status = 'FILLED';
    entry.filledPrice = roundedFill;
    this.workingOrders.delete(orderId);
    this.filledOrders.set(orderId, { price: roundedFill, timestamp: timestamp.toISOString() });

    const side = isBuy ? 'BUY' : 'SELL';
    log.debug(`Fill: ${orderId} ${side} ${symbol} @ $${roundedFill}`);

    return {
      orderId,
      symbol,
      side,
      price: roundedFill,
      quantity: tradeQty(entry.params.legs[0]?.quantity),
      timestamp,
    };
  }

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    const orderId = `SIM-${++this.orderCounter}`;
    const legCount = params.legs.length;

    log.debug(`placeOrder: ${params.orderType} ${params.symbol} legs=${legCount} limit=${params.limitPrice ?? 'MKT'}`);

    const isOptions = this.hasOptionLegs(params);

    // ── Broker-level buying power gate (always enforced) ──
    if (!params.isClosing && params.legs.length > 0) {
      let underlyingPrice: number;
      try {
        const quote = await this.marketData.getQuote(params.symbol, this.clock.now());
        underlyingPrice = (quote.bid + quote.ask) / 2;
      } catch {
        underlyingPrice = params.limitPrice ?? 0;
      }

      // For MARKET option orders, use the actual spread mid-price as the debit/credit estimate
      // rather than falling back to the underlying price (which would produce a wildly inflated margin).
      let estimatedPrice: number | null = params.limitPrice ?? null;
      if (estimatedPrice === null) {
        if (isOptions) {
          try {
            const spreadQuote = await this.getOptionSpreadQuote(params, this.clock.now());
            estimatedPrice = (spreadQuote.bid + spreadQuote.ask) / 2;
          } catch {
            // No spread quote available — skip the buying power check now;
            // the MARKET fill path below will reject with "no market data".
            estimatedPrice = null;
          }
        } else {
          estimatedPrice = underlyingPrice;
        }
      }

      if (estimatedPrice !== null) {
        const legs: TradeLeg[] = params.legs;

        const marginReq = computeMarginRequirement({
          strategy: params.strategy,
          direction: params.direction,
          entryPrice: estimatedPrice,
          quantity: tradeQty(params.legs[0]?.quantity),
          legs,
          underlyingPrice,
        });

        if (marginReq.initial > 0) {
          const balance = await this.getAccountBalance();
          if (marginReq.initial > balance.buyingPower) {
            log.debug(`  REJECTED: insufficient buying power (need $${marginReq.initial.toFixed(0)}, have $${balance.buyingPower.toFixed(0)})`);
            return { orderId, status: 'REJECTED', message: `Insufficient buying power (need $${marginReq.initial.toFixed(0)}, have $${balance.buyingPower.toFixed(0)})` };
          }
        }
      }
    }

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
        // Price improvement: fill at the better of limit or market
        const isBuy = isBuyOrder(params);
        const improved = isBuy
          ? Math.min(params.limitPrice, quote.ask)
          : Math.max(params.limitPrice, quote.bid);
        const filledPrice = roundCents(improved);
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
      legCount: params.legs.length,
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
    // Already filled — can't cancel a filled order
    const filled = this.filledOrders.get(orderId);
    if (filled) {
      return { orderId, status: 'FILLED', filledPrice: filled.price, fillTimestamp: filled.timestamp };
    }
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
    if (entry) {
      return { orderId, status: entry.status, filledPrice: entry.filledPrice };
    }
    const filled = this.filledOrders.get(orderId);
    if (filled) {
      return { orderId, status: 'FILLED', filledPrice: filled.price, fillTimestamp: filled.timestamp };
    }
    return { orderId, status: 'REJECTED' };
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

    const legs = parseLegs(row.legs);
    const params: OrderParams = {
      symbol: row.symbol,
      strategy: row.strategy,
      direction: 'LONG', // direction doesn't affect spread quote computation
      legs,
      orderType: 'MARKET',
    };
    return this.getOptionSpreadQuote(params, at);
  }

  // ─── Shared internals ────────────────────────────────────

  /** Build a map of trade ID -> current mark price for all open positions. */
  async markToMarket(at?: Date): Promise<Map<string, number>> {
    const time = at ?? this.clock.now();
    const markPrices = new Map<string, number>();
    const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(this.backtestRunId)));

    for (const t of openTrades) {
      try {
        const quote = await this.getTradeQuote(t, time);
        markPrices.set(t.id, (quote.bid + quote.ask) / 2);
      } catch {
        // markToMarket is advisory (used for MTM snapshots in equity curve).
        // Missing mark for one trade should not crash the entire backtest.
        log.warn(`markToMarket: no quote for ${t.id} (${t.symbol} ${t.strategy})`);
      }
    }
    return markPrices;
  }

  /** Close a specific trade at a given price/time and record PnL. */
  async closePositionAtPrice(tradeId: string, exitPrice: number, closedAt: string): Promise<{ pnl: number }> {
    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, tradeId));
    if (!trade) throw new Error(`Trade ${tradeId} not found`);

    const result = await recordTrade({
      action: 'CLOSE',
      tradeId,
      symbol: trade.symbol,
      trader: trade.trader,
      exitPrice,
      closedAt,
      backtestRunId: this.backtestRunId,
      isBacktest: true,
    });

    if (!result) throw new Error(`recordTrade CLOSE failed for trade ${tradeId}`);

    const pnl = safeParseFloat(result.trade.pnl);
    return { pnl };
  }

  /** Sum unrealized PnL across all open positions using current marks. */
  async getUnrealizedPnl(at?: Date): Promise<number> {
    const time = at ?? this.clock.now();
    const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(this.backtestRunId)));

    let total = 0;
    for (const row of openTrades) {
      let quote: Quote;
      try {
        quote = await this.getTradeQuote(row, time);
      } catch {
        log.warn(`getUnrealizedPnl: no quote for ${row.id} (${row.symbol} ${row.strategy})`);
        continue;
      }
      const mark = (quote.bid + quote.ask) / 2;
      total += computeTradePnl({
        entryPrice: safeParseFloat(row.entryPrice),
        exitPrice: mark,
        direction: parseDirection(row.direction, row.id),
        strategy: row.strategy,
        quantity: tradeQty(row.quantity),
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
      const legs = parseLegs(t.legs, t.id);
      if (legs.length === 0) continue;

      const hasExpiredLeg = legs.some((leg) => leg.expiry <= currentDate);
      if (!hasExpiredLeg) continue;

      // Compute intrinsic value at expiry
      let netIntrinsic = 0;
      for (const leg of legs) {
        if (leg.expiry > currentDate) continue;
        if (leg.type === 'STOCK') continue;

        const expiryDate = new Date(leg.expiry + 'T20:00:00Z');
        const quote = await this.marketData.getQuote(t.symbol, expiryDate);
        const underlyingPrice = (quote.bid + quote.ask) / 2;

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

  /** Force-close all open positions at current mark prices. Throws if any position has no mark. */
  async forceCloseAll(at: Date): Promise<number> {
    const openTrades = await db.select().from(schema.trades).where(and(isOpen, forRun(this.backtestRunId)));
    let totalPnl = 0;

    for (const t of openTrades) {
      const quote = await this.getTradeQuote(t, at);
      const mark = (quote.bid + quote.ask) / 2;
      const { pnl } = await this.closePositionAtPrice(t.id, mark, at.toISOString());
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

  /** Get all open trade rows for this run, optionally filtered by trader/symbol/strategy. */
  async getOpenTrades(filters?: PositionFilters): Promise<Trade[]> {
    const conditions = [isOpen, forRun(this.backtestRunId)];
    if (filters?.trader) conditions.push(forTrader(filters.trader));
    if (filters?.symbol) conditions.push(forSymbol(filters.symbol));
    if (filters?.strategy) conditions.push(forStrategy(filters.strategy));
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
      const quantity = tradeQty(row.quantity);
      const direction = parseDirection(row.direction, row.id);
      const strategy = row.strategy;

      const tradeQuote = await this.getTradeQuote(row, this.clock.now());
      const currentPrice = (tradeQuote.bid + tradeQuote.ask) / 2;
      const unrealizedPnl = computeTradePnl({
        entryPrice, exitPrice: currentPrice, direction, strategy, quantity,
      });
      const marketValue = roundCents(currentPrice * quantity * contractMultiplier(strategy));

      positions.push({
        symbol: row.symbol,
        quantity,
        averageCost: entryPrice,
        marketValue,
        unrealizedPnl,
        assetType: assetType(strategy),
      });
    }
    return positions;
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const now = this.clock.now();
    const [realizedRow] = await db
      .select({ total: sql<number>`COALESCE(SUM(CAST(${schema.trades.pnl} AS REAL)), 0)` })
      .from(schema.trades)
      .where(and(isClosed, forRun(this.backtestRunId)));
    const realizedPnl = roundCents(realizedRow?.total ?? 0);

    // Single pass over open trades: cash effects, margin, unrealized PnL, market value.
    const openTrades = await db.select().from(schema.trades)
      .where(and(isOpen, forRun(this.backtestRunId)));

    let cash = this.startingEquity + realizedPnl;
    let totalMaintenanceMargin = 0;
    let unrealizedPnl = 0;
    let totalMarketValue = 0;

    for (const t of openTrades) {
      const legs = parseLegs(t.legs, t.id)
      const entry = safeParseFloat(t.entryPrice);
      const qty = tradeQty(t.quantity);
      const dir = parseDirection(t.direction, t.id);
      const contractMult = contractMultiplier(t.strategy);

      // Fetch mark — only getTradeQuote can legitimately fail (missing market data)
      let tradeQuote: Quote | null = null;
      try {
        tradeQuote = await this.getTradeQuote(t, now);
      } catch {
        log.warn(`getAccountBalance: no quote for ${t.id} (${t.symbol} ${t.strategy})`);
      }

      // Underlying price for margin calc: for STOCK it's the mark, for options fetch equity quote
      let underlyingPrice = entry; // fallback
      if (tradeQuote != null) {
        if (t.strategy === 'STOCK') {
          underlyingPrice = (tradeQuote.bid + tradeQuote.ask) / 2;
        } else {
          try {
            const eq = await this.marketData.getQuote(t.symbol, now);
            underlyingPrice = (eq.bid + eq.ask) / 2;
          } catch {
            // Options underlying quote failed — use entry as fallback for margin
          }
        }
      }

      const marginReq = computeMarginRequirement({
        strategy: t.strategy, direction: dir, entryPrice: entry,
        quantity: qty, legs, underlyingPrice,
      });

      cash += marginReq.cashEffect;
      totalMaintenanceMargin += marginReq.maintenance;

      if (tradeQuote != null) {
        const mark = (tradeQuote.bid + tradeQuote.ask) / 2;
        unrealizedPnl += computeTradePnl({
          entryPrice: entry, exitPrice: mark, direction: dir,
          strategy: t.strategy, quantity: qty,
        });
        totalMarketValue += (dir === 'LONG' ? 1 : -1) * mark * qty * contractMult;
      }
    }

    // Encumber buying power for unfilled working orders (prevents over-leveraging)
    let workingOrderMargin = 0;
    for (const [, entry] of this.workingOrders) {
      if (entry.status !== 'OPEN') continue;
      if (entry.params.isClosing) continue; // closing orders don't require new margin

      let woUnderlyingPrice = entry.currentLimitPrice;
      if (entry.params.strategy !== 'STOCK') {
        try {
          const uq = await this.marketData.getQuote(entry.params.symbol, now);
          woUnderlyingPrice = (uq.bid + uq.ask) / 2;
        } catch { /* use limit price as fallback */ }
      }

      const woMargin = computeMarginRequirement({
        strategy: entry.params.strategy,
        direction: entry.params.direction,
        entryPrice: entry.currentLimitPrice,
        quantity: tradeQty(entry.params.legs[0]?.quantity),
        legs: entry.params.legs,
        underlyingPrice: woUnderlyingPrice,
      });
      workingOrderMargin += woMargin.initial;
    }

    unrealizedPnl = roundCents(unrealizedPnl);
    const equity = roundCents(cash + totalMarketValue);
    const buyingPower = Math.max(0, roundCents(equity - totalMaintenanceMargin - workingOrderMargin));

    return {
      accountId: 'SIM',
      cashBalance: roundCents(cash),
      buyingPower,
      equity,
      marketValue: roundCents(totalMarketValue),
      unrealizedPnl,
      realizedPnl,
      timestamp: now.toISOString(),
      maintenanceMargin: roundCents(totalMaintenanceMargin),
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

      fills.push(this.fillWorkingOrder(orderId, entry, tick.symbol, tick.timestamp, tick.bid, tick.ask));
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

    // Process option working orders via OCC leg tick replay
    if (optionOrderIds.length > 0) {
      // Collect all unique OCC symbols across all option working orders
      const occSymbols = new Set<string>();
      for (const orderId of optionOrderIds) {
        const entry = this.workingOrders.get(orderId);
        if (!entry || entry.status !== 'OPEN') continue;
        for (const leg of entry.params.legs) {
          if (leg.type !== 'STOCK') occSymbols.add(leg.symbol);
        }
      }

      // Get ticks in range for all OCC leg symbols and collect unique timestamps
      const timestamps = new Set<number>();
      for (const occSym of occSymbols) {
        try {
          const ticks = await this.marketData.getTicksInRange(occSym, from, time);
          for (const tick of ticks) timestamps.add(tick.timestamp.getTime());
        } catch {
          // No tick data for this leg — continue with others
        }
      }

      // At each timestamp, re-quote all open option orders and check fills
      const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
      for (const ts of sortedTimestamps) {
        const tickTime = new Date(ts);
        for (const orderId of optionOrderIds) {
          const entry = this.workingOrders.get(orderId);
          if (!entry || entry.status !== 'OPEN') continue;

          try {
            const quote = await this.getOptionSpreadQuote(entry.params, tickTime);
            if (shouldFillLimit(isBuyOrder(entry.params), entry.currentLimitPrice, quote.bid, quote.ask)) {
              allFills.push(this.fillWorkingOrder(orderId, entry, entry.params.symbol, tickTime, quote.bid, quote.ask));
            }
          } catch {
            // Incomplete spread quote at this timestamp — leave order working
          }
        }
      }

      // Fallback: re-quote any still-open option orders at the target time.
      // This covers cases where no OCC tick data is available (e.g. synthetic pricing).
      for (const orderId of optionOrderIds) {
        const entry = this.workingOrders.get(orderId);
        if (!entry || entry.status !== 'OPEN') continue;

        try {
          const quote = await this.getOptionSpreadQuote(entry.params, time);
          if (shouldFillLimit(isBuyOrder(entry.params), entry.currentLimitPrice, quote.bid, quote.ask)) {
            allFills.push(this.fillWorkingOrder(orderId, entry, entry.params.symbol, time, quote.bid, quote.ask));
          }
        } catch {
          // No spread quote at target time — leave order working
        }
      }
    }

    this.lastAdvanceTime = time;
    return allFills;
  }

}
