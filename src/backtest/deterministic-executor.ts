import type { HistoricalMessage, SimPosition, SimLeg, FillModel } from './types.js';
import type { MessagePriceProvider } from './market-data.js';
import { SimBroker, computeModelFillPrice } from './sim-broker.js';
import { PositionTracker } from './position-tracker.js';
import type { SimClock } from './clock.js';
import type { DetectedStrategy } from '../db/schema.js';
import type { PositionSize } from '../position-sizing/index.js';

const CONFIDENCE_THRESHOLD = 0.7;

export interface SizingService {
  calculateSize(input: { trader: string; symbol: string; entryPrice: number; strategy: string; spreadMaxRisk?: number }): Promise<PositionSize>;
}

export interface RiskService {
  check(input: { symbol: string; strategy: string; trader: string }): Promise<{ allowed: boolean; reason?: string }>;
}

export type ExecutionResult = {
  action: 'OPEN' | 'CLOSE' | 'SKIP';
  position?: SimPosition;
  reason: string;
  usedAgent: boolean;
};

/**
 * DeterministicExecutor: Fast path for high-confidence messages.
 * No LLM calls — purely regex-based analysis + simulated broker.
 */
export class DeterministicExecutor {
  constructor(
    private broker: SimBroker,
    private tracker: PositionTracker,
    private clock: SimClock,
    private priceProvider: MessagePriceProvider,
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
    const price = strategy.price ?? this.extractPriceFromText(msg.cleanText);
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

    // Seed price provider with realistic spread width for options
    const spreadPct = isOption ? (legCount > 1 ? 0.08 : 0.10) : 0.001;
    this.priceProvider.setPrice(symbol, price, msg.timestamp, spreadPct);

    // Seed option prices for spreads
    if (strategy.strikes) {
      for (const strike of strategy.strikes) {
        const optType = strategy.strategy === 'PDS' || strategy.strategy === 'PUT' ? 'PUT' : 'CALL';
        this.priceProvider.setOptionPrice(
          `${symbol}:${optType}:${strike}`,
          price,
          msg.timestamp,
        );
      }
    }

    // Compute ORATS-estimated fill price and place LIMIT order
    const quote = await this.broker.getQuote(symbol);
    const isBuy = legs[0]?.action === 'BUY';
    let limitPrice = computeModelFillPrice(this.fillModel, quote.bid, quote.ask, isBuy, legCount);
    if (legCount > 1) limitPrice = Math.abs(limitPrice);
    limitPrice = Math.round(limitPrice * 100) / 100;

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
    const exitPrice = this.extractPriceFromText(msg.cleanText);
    if (exitPrice) {
      this.priceProvider.setPrice(symbol, exitPrice, msg.timestamp);
    }

    const quote = await this.broker.getQuote(symbol);
    const fillPrice = exitPrice ?? quote.last;

    const pos = this.tracker.closeMatching(symbol, msg.author, fillPrice, msg.timestamp);
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

  private extractPriceFromText(text: string): number | undefined {
    // Try "for $X.XX" or "at $X.XX" patterns first
    const priceMatch = text.match(/(?:for|at|@)\s*\$?([\d,]+\.?\d*)/i);
    if (priceMatch) return parseFloat(priceMatch[1].replace(/,/g, ''));

    // Try trailing number after symbol text (e.g., "Long CSCO 73.41")
    // Negative lookbehind (?<!:) avoids matching timestamps like "10:30"
    const trailingMatch = text.match(/(?<!:)\b(\d+\.?\d+)\s*(?:-|$|\.|!|\s*starter)/i);
    if (trailingMatch) {
      const val = parseFloat(trailingMatch[1]);
      // Skip strike-like numbers and very large numbers
      if (val > 0.01 && val < 10000) return val;
    }

    return undefined;
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
