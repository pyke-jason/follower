import type { HistoricalMessage, SimPosition, SimLeg, FillModel, SizingService, RiskService, ExecutionResult } from './types.js';
import type { BacktestPriceProvider } from './market-data.js';
import { SimBroker, computeModelFillPrice } from './sim-broker.js';
import { PositionTracker } from './position-tracker.js';
import type { SimClock } from './clock.js';
import type { DetectedStrategy } from '../db/schema.js';
import { extractPriceFromText, seedOptionPrices } from './helpers.js';
import { roundCents } from '../lib/numbers.js';

const CONFIDENCE_THRESHOLD = 0.7;

/**
 * DeterministicExecutor: Fast path for high-confidence messages.
 * No LLM calls — purely regex-based analysis + simulated broker.
 */
export class DeterministicExecutor {
  constructor(
    private broker: SimBroker,
    private tracker: PositionTracker,
    private clock: SimClock,
    private priceProvider: BacktestPriceProvider,
    private fillModel: FillModel = 'orats',
    private sizingService: SizingService,
    private riskService: RiskService,
  ) {}

  canHandle(msg: HistoricalMessage): boolean {
    return msg.confidence >= CONFIDENCE_THRESHOLD;
  }

  async execute(msg: HistoricalMessage): Promise<ExecutionResult> {
    // Filter: must have badges
    if (msg.badges.length === 0) {
      return { action: 'SKIP', reason: 'no badges', usedAgent: false };
    }

    // Filter: skip paper trades
    if (msg.isPaperTrade) {
      return { action: 'SKIP', reason: 'paper trade', usedAgent: false };
    }

    // EXIT logic
    if (msg.actionHint === 'CLOSE') {
      return this.handleExit(msg);
    }

    // OPEN logic
    if (msg.actionHint === 'OPEN' && msg.detectedStrategies.length > 0) {
      return this.handleOpen(msg);
    }

    return { action: 'SKIP', reason: 'unrecognized action', usedAgent: false };
  }

  private async handleOpen(msg: HistoricalMessage): Promise<ExecutionResult> {
    const strategy = msg.detectedStrategies[0];
    if (!strategy) {
      return { action: 'SKIP', reason: 'no detected strategy', usedAgent: false };
    }
    const symbol = msg.symbols[0];
    if (!symbol) {
      return { action: 'SKIP', reason: 'no symbol detected', usedAgent: false };
    }

    const direction = msg.directionHint ?? 'LONG';

    // Extract price from strategy or text
    const price = strategy.price ?? extractPriceFromText(msg.cleanText);
    if (price === undefined) {
      return { action: 'SKIP', reason: 'no price detected', usedAgent: false };
    }
    if (!Number.isFinite(price)) {
      return { action: 'SKIP', reason: `invalid price: ${price}`, usedAgent: false };
    }

    // Always size from our portfolio — never use the trader's quantity
    const isSpread = ['CDS', 'PDS'].includes(strategy.strategy);
    const sizing = await this.sizingService.calculateSize({
      trader: msg.author,
      symbol,
      entryPrice: price,
      strategy: strategy.strategy,
      spreadMaxRisk: isSpread ? price : undefined,
    });
    const quantity = sizing.quantity;
    if (quantity <= 0) {
      return { action: 'SKIP', reason: `sizing returned 0: ${sizing.reasoning}`, usedAgent: false };
    }

    // Risk gate
    const risk = await this.riskService.check({ symbol, strategy: strategy.strategy, trader: msg.author });
    if (!risk.allowed) {
      return { action: 'SKIP', reason: `risk blocked: ${risk.reason}`, usedAgent: false };
    }

    // Build legs with our computed quantity
    const legs = this.buildLegs(strategy, symbol, direction, quantity);
    const isOption = strategy.strategy !== 'STOCK';
    const legCount = legs.length || 1;

    // Use real Databento quote when available; only self-seed as fallback
    const hasRealQuote = this.priceProvider.hasQuote(symbol, msg.timestamp);
    if (!hasRealQuote) {
      // Widen spreads for more realistic fills:
      // Options: 15% (real option spreads are wide), Stocks: 0.5% (small/mid cap)
      const spreadPct = isOption ? 0.15 : 0.005;
      this.priceProvider.setPrice(symbol, price, msg.timestamp, spreadPct);
    }

    // Seed option prices for spreads (Databento DBEQ.BASIC has no options data)
    seedOptionPrices(this.priceProvider, [strategy], [symbol], msg.timestamp);

    // Compute ORATS-estimated fill price and place LIMIT order
    const quote = await this.broker.getQuote(symbol);
    const isBuy = legs[0]?.action === 'BUY';
    let limitPrice = computeModelFillPrice({ fillModel: this.fillModel, bid: quote.bid, ask: quote.ask, isBuy, legCount });
    if (legCount > 1) limitPrice = Math.abs(limitPrice);
    limitPrice = roundCents(limitPrice);

    const result = await this.broker.placeOrder({
      symbol,
      strategy: strategy.strategy,
      direction,
      legs: legs.map((l) => ({
        strike: l.strike,
        expiry: l.expiry,
        type: l.type,
        action: l.action,
        quantity: l.quantity,
      })),
      orderType: 'LIMIT',
      limitPrice,
    });

    // If the limit order didn't fill, don't fake a fill
    if (result.status !== 'FILLED') {
      return { action: 'SKIP', reason: `limit order not filled (status: ${result.status})`, usedAgent: false };
    }

    // Track position
    const fillPrice = result.filledPrice ?? limitPrice;
    const position = this.tracker.open({
      symbol,
      direction,
      strategy: strategy.strategy,
      trader: msg.author,
      entryPrice: fillPrice,
      quantity,
      legs: legs.map((l) => ({ ...l, fillPrice })),
      openedAt: msg.timestamp,
      sourceMessageId: msg.id,
    });

    return {
      action: 'OPEN',
      position,
      reason: `Opened ${direction} ${strategy.strategy} on ${symbol} at ${fillPrice}`,
      usedAgent: false,
    };
  }

  private async handleExit(msg: HistoricalMessage): Promise<ExecutionResult> {
    const symbol = msg.symbols[0];
    if (!symbol) {
      return { action: 'SKIP', reason: 'exit with no symbol', usedAgent: false };
    }

    // Try to find a matching open position
    const openPositions = this.tracker.getOpenBySymbol(symbol)
      .filter((p) => p.trader === msg.author);

    if (openPositions.length === 0) {
      return { action: 'SKIP', reason: `no open position for ${symbol}`, usedAgent: false };
    }

    // Extract exit price
    const exitPrice = extractPriceFromText(msg.cleanText);
    if (exitPrice) {
      this.priceProvider.setPrice(symbol, exitPrice, msg.timestamp);
    }

    const quote = await this.broker.getQuote(symbol);
    const fillPrice = exitPrice ?? quote.last;

    const pos = this.tracker.closeMatching({ symbol, trader: msg.author, exitPrice: fillPrice, closedAt: msg.timestamp });
    if (!pos) {
      return { action: 'SKIP', reason: 'failed to close position', usedAgent: false };
    }

    return {
      action: 'CLOSE',
      position: pos,
      reason: `Closed ${symbol} at ${fillPrice}, P&L: ${pos.pnl?.toFixed(2)}`,
      usedAgent: false,
    };
  }

  private buildLegs(
    strategy: DetectedStrategy,
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
  ): SimLeg[] {
    const expiry = strategy.expiry ?? this.getNextFriday();

    switch (strategy.strategy) {
      case 'CDS': {
        if (!strategy.strikes || strategy.strikes.length < 2) {
          throw new Error(`[Backtest] CDS strategy for ${symbol} missing strikes (got ${JSON.stringify(strategy.strikes)})`);
        }
        const [lower, upper] = strategy.strikes;
        return [
          { symbol, strike: lower, expiry, type: 'CALL', action: 'BUY', quantity, fillPrice: 0 },
          { symbol, strike: upper, expiry, type: 'CALL', action: 'SELL', quantity, fillPrice: 0 },
        ];
      }
      case 'PDS': {
        if (!strategy.strikes || strategy.strikes.length < 2) {
          throw new Error(`[Backtest] PDS strategy for ${symbol} missing strikes (got ${JSON.stringify(strategy.strikes)})`);
        }
        const [higher, lower] = strategy.strikes;
        return [
          { symbol, strike: higher, expiry, type: 'PUT', action: 'BUY', quantity, fillPrice: 0 },
          { symbol, strike: lower, expiry, type: 'PUT', action: 'SELL', quantity, fillPrice: 0 },
        ];
      }
      case 'CALL': {
        const strike = strategy.strikes?.[0];
        if (strike == null) {
          throw new Error(`[Backtest] CALL strategy for ${symbol} missing strike (got ${JSON.stringify(strategy.strikes)})`);
        }
        return [
          { symbol, strike, expiry, type: 'CALL', action: 'BUY', quantity, fillPrice: 0 },
        ];
      }
      case 'PUT': {
        const strike = strategy.strikes?.[0];
        if (strike == null) {
          throw new Error(`[Backtest] PUT strategy for ${symbol} missing strike (got ${JSON.stringify(strategy.strikes)})`);
        }
        return [
          { symbol, strike, expiry, type: 'PUT', action: 'BUY', quantity, fillPrice: 0 },
        ];
      }
      case 'STOCK':
      default: {
        return [
          { symbol, strike: 0, expiry: '', type: 'STOCK', action: direction === 'LONG' ? 'BUY' : 'SELL', quantity, fillPrice: 0 },
        ];
      }
    }
  }

  private getNextFriday(): string {
    const now = this.clock.now();
    const day = now.getDay();
    const daysUntilFriday = (5 - day + 7) % 7 || 7;
    const friday = new Date(now);
    friday.setDate(friday.getDate() + daysUntilFriday);
    return friday.toISOString().split('T')[0];
  }
}
