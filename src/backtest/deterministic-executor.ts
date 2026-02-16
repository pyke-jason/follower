import type { HistoricalMessage, SimLeg, FillModel, SizingService, RiskService, ExecutionResult, ExecutionStep } from './types.js';
import { SimBroker, computeModelFillPrice } from './sim-broker.js';
import { PositionTracker } from './position-tracker.js';
import type { SimClock } from './clock.js';
import type { DetectedStrategy } from '../db/schema.js';
import { roundCents } from '../lib/numbers.js';
import { formatOccSymbol, isOccOptionSymbol } from './occ-symbology.js';

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
    const steps: ExecutionStep[] = [];
    const strategy = msg.detectedStrategies[0];
    if (!strategy) {
      return { action: 'SKIP', reason: 'no detected strategy', usedAgent: false };
    }
    const symbol = msg.symbols[0];
    if (!symbol) {
      return { action: 'SKIP', reason: 'no symbol detected', usedAgent: false };
    }

    const direction = msg.directionHint ?? 'LONG';
    const isOption = strategy.strategy !== 'STOCK';

    if (isOption) {
      return this.handleOptionOpen(msg, strategy, symbol, direction, steps);
    }

    // ── Stock path (unchanged) ──────────────────────────────────────────

    // Get real market quote — if no Databento data exists, this throws (correctly)
    const quoteStart = Date.now();
    const quote = await this.broker.getQuote(symbol);
    const price = quote.last;

    // Step 1: Classify
    steps.push({
      name: 'classify',
      input: { badges: msg.badges, actionHint: msg.actionHint, directionHint: msg.directionHint, confidence: msg.confidence },
      output: { strategy: strategy.strategy, symbol, direction, price, strikes: strategy.strikes, expiry: strategy.expiry },
      reasoning: `Classified as ${msg.actionHint} ${strategy.strategy} on ${symbol} @ $${price} (confidence: ${(msg.confidence * 100).toFixed(0)}%)`,
    });

    // Always size from our portfolio — never use the trader's quantity
    const isSpread = ['CDS', 'PDS'].includes(strategy.strategy);
    const sizingStart = Date.now();
    const sizing = await this.sizingService.calculateSize({
      trader: msg.author,
      symbol,
      entryPrice: price,
      strategy: strategy.strategy,
      spreadMaxRisk: isSpread ? price : undefined,
    });
    const quantity = sizing.quantity;

    // Step 2: Size position
    steps.push({
      name: 'size_position',
      input: { trader: msg.author, symbol, entryPrice: price, strategy: strategy.strategy, spreadMaxRisk: isSpread ? price : undefined },
      output: { quantity: sizing.quantity, reasoning: sizing.reasoning, riskPerTrade: sizing.riskPerTrade, atr: sizing.atr, effectiveRisk: sizing.effectiveRisk },
      reasoning: sizing.reasoning,
      durationMs: Date.now() - sizingStart,
    });

    if (quantity <= 0) {
      return { action: 'SKIP', reason: `sizing returned 0: ${sizing.reasoning}`, usedAgent: false, steps };
    }

    // Risk gate
    const riskStart = Date.now();
    const risk = await this.riskService.check({ symbol, strategy: strategy.strategy, trader: msg.author });

    // Step 3: Check risk
    steps.push({
      name: 'check_risk',
      input: { symbol, strategy: strategy.strategy, trader: msg.author },
      output: risk,
      reasoning: risk.allowed ? 'Risk check passed' : `Risk blocked: ${risk.reason}`,
      durationMs: Date.now() - riskStart,
    });

    if (!risk.allowed) {
      return { action: 'SKIP', reason: `risk blocked: ${risk.reason}`, usedAgent: false, steps };
    }

    // Build legs with our computed quantity
    const legs = this.buildLegs(strategy, symbol, direction, quantity);
    const legCount = legs.length || 1;

    // Compute fill price and place LIMIT order
    const isBuy = legs[0]?.action === 'BUY';
    let limitPrice = computeModelFillPrice({ fillModel: this.fillModel, bid: quote.bid, ask: quote.ask, isBuy, legCount });
    if (legCount > 1) limitPrice = Math.abs(limitPrice);
    limitPrice = roundCents(limitPrice);

    // Step 4: Get quote
    steps.push({
      name: 'get_quote',
      input: { symbol, fillModel: this.fillModel },
      output: { bid: quote.bid, ask: quote.ask, last: quote.last, limitPrice },
      reasoning: `Quote ${symbol}: bid=${quote.bid} ask=${quote.ask} last=${quote.last} → limit=${limitPrice} (${this.fillModel} model, Databento)`,
      durationMs: Date.now() - quoteStart,
    });

    const orderStart = Date.now();
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

    // Step 5: Place order
    steps.push({
      name: 'place_order',
      input: { symbol, strategy: strategy.strategy, direction, legs: legs.length, orderType: 'LIMIT', limitPrice, quantity },
      output: { status: result.status, filledPrice: result.filledPrice, filledQuantity: result.filledQuantity },
      reasoning: result.status === 'FILLED'
        ? `Order filled at $${result.filledPrice ?? limitPrice} (${quantity} contracts)`
        : `Order ${result.status} — limit $${limitPrice} not filled`,
      durationMs: Date.now() - orderStart,
    });

    // If the limit order didn't fill, don't fake a fill
    if (result.status !== 'FILLED') {
      return { action: 'SKIP', reason: `limit order not filled (status: ${result.status})`, usedAgent: false, steps };
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
      steps,
    };
  }

  // ── Option open path ────────────────────────────────────────────────

  private async handleOptionOpen(
    msg: HistoricalMessage,
    strategy: DetectedStrategy,
    symbol: string,
    direction: 'LONG' | 'SHORT',
    steps: ExecutionStep[],
  ): Promise<ExecutionResult> {
    const quoteStart = Date.now();

    // Build legs (already handles CDS/PDS/CALL/PUT)
    // Use quantity=1 temporarily — we'll size after getting per-leg quotes
    const legs = this.buildLegs(strategy, symbol, direction, 1);

    // For each leg, construct OCC symbol and get OPRA quote
    const legQuotes: { leg: SimLeg; occSymbol: string; bid: number; ask: number; fillPrice: number }[] = [];
    for (const leg of legs) {
      const occSymbol = formatOccSymbol({
        underlying: symbol,
        expiration: leg.expiry,
        type: leg.type as 'CALL' | 'PUT',
        strike: leg.strike,
      });

      // getQuote throws if no OPRA data → caught by caller → SKIP
      const quote = await this.broker.getQuote(occSymbol);
      const isBuy = leg.action === 'BUY';
      const fillPrice = roundCents(computeModelFillPrice({
        fillModel: this.fillModel,
        bid: quote.bid,
        ask: quote.ask,
        isBuy,
        legCount: 1,
      }));

      legQuotes.push({ leg, occSymbol, bid: quote.bid, ask: quote.ask, fillPrice });
    }

    // Compute net premium: BUY legs are debits (negative), SELL legs are credits (positive)
    const netPremium = roundCents(Math.abs(
      legQuotes.reduce((sum, lq) => {
        const sign = lq.leg.action === 'BUY' ? -1 : 1;
        return sum + sign * lq.fillPrice;
      }, 0),
    ));

    if (netPremium <= 0) {
      return { action: 'SKIP', reason: `option net premium is $${netPremium}`, usedAgent: false, steps };
    }

    // Step 1: Classify
    steps.push({
      name: 'classify',
      input: { badges: msg.badges, actionHint: msg.actionHint, directionHint: msg.directionHint, confidence: msg.confidence },
      output: {
        strategy: strategy.strategy, symbol, direction, netPremium,
        strikes: strategy.strikes, expiry: strategy.expiry,
        legs: legQuotes.map(lq => ({ occ: lq.occSymbol, action: lq.leg.action, bid: lq.bid, ask: lq.ask, fill: lq.fillPrice })),
      },
      reasoning: `Classified as ${msg.actionHint} ${strategy.strategy} on ${symbol} — net premium $${netPremium} (confidence: ${(msg.confidence * 100).toFixed(0)}%)`,
    });

    // Size position using net premium as entryPrice
    const isSpread = ['CDS', 'PDS'].includes(strategy.strategy);
    const sizingStart = Date.now();
    const sizing = await this.sizingService.calculateSize({
      trader: msg.author,
      symbol,
      entryPrice: netPremium,
      strategy: strategy.strategy,
      spreadMaxRisk: isSpread ? netPremium : undefined,
    });
    const quantity = sizing.quantity;

    steps.push({
      name: 'size_position',
      input: { trader: msg.author, symbol, entryPrice: netPremium, strategy: strategy.strategy, spreadMaxRisk: isSpread ? netPremium : undefined },
      output: { quantity: sizing.quantity, reasoning: sizing.reasoning, riskPerTrade: sizing.riskPerTrade, atr: sizing.atr, effectiveRisk: sizing.effectiveRisk },
      reasoning: sizing.reasoning,
      durationMs: Date.now() - sizingStart,
    });

    if (quantity <= 0) {
      return { action: 'SKIP', reason: `sizing returned 0: ${sizing.reasoning}`, usedAgent: false, steps };
    }

    // Risk gate
    const riskStart = Date.now();
    const risk = await this.riskService.check({ symbol, strategy: strategy.strategy, trader: msg.author });

    steps.push({
      name: 'check_risk',
      input: { symbol, strategy: strategy.strategy, trader: msg.author },
      output: risk,
      reasoning: risk.allowed ? 'Risk check passed' : `Risk blocked: ${risk.reason}`,
      durationMs: Date.now() - riskStart,
    });

    if (!risk.allowed) {
      return { action: 'SKIP', reason: `risk blocked: ${risk.reason}`, usedAgent: false, steps };
    }

    // Step: Per-leg quotes
    steps.push({
      name: 'get_option_quotes',
      input: { symbol, strategy: strategy.strategy, fillModel: this.fillModel },
      output: {
        legs: legQuotes.map(lq => ({ occ: lq.occSymbol, action: lq.leg.action, bid: lq.bid, ask: lq.ask, fill: lq.fillPrice })),
        netPremium,
      },
      reasoning: legQuotes.map(lq => `${lq.leg.action} ${lq.occSymbol}: bid=${lq.bid} ask=${lq.ask} → fill=${lq.fillPrice}`).join(' | '),
      durationMs: Date.now() - quoteStart,
    });

    // Build final legs with OCC symbols, fill prices, and sized quantity
    const finalLegs: SimLeg[] = legQuotes.map(lq => ({
      symbol: lq.occSymbol,
      strike: lq.leg.strike,
      expiry: lq.leg.expiry,
      type: lq.leg.type,
      action: lq.leg.action,
      quantity,
      fillPrice: lq.fillPrice,
    }));

    // Track position — symbol is the underlying, entryPrice is net premium
    const position = this.tracker.open({
      symbol,
      direction,
      strategy: strategy.strategy,
      trader: msg.author,
      entryPrice: netPremium,
      quantity,
      legs: finalLegs,
      openedAt: msg.timestamp,
      sourceMessageId: msg.id,
    });

    return {
      action: 'OPEN',
      position,
      reason: `Opened ${direction} ${strategy.strategy} on ${symbol} at $${netPremium} (${quantity} contracts, OPRA)`,
      usedAgent: false,
      steps,
    };
  }

  private async handleExit(msg: HistoricalMessage): Promise<ExecutionResult> {
    const steps: ExecutionStep[] = [];
    const symbol = msg.symbols[0];
    if (!symbol) {
      return { action: 'SKIP', reason: 'exit with no symbol', usedAgent: false };
    }

    // Try to find a matching open position
    const openPositions = this.tracker.getOpenBySymbol(symbol)
      .filter((p) => p.trader === msg.author);

    // Step 1: Classify exit
    steps.push({
      name: 'classify',
      input: { badges: msg.badges, actionHint: msg.actionHint, symbol, trader: msg.author },
      output: { matchedPositions: openPositions.length, positions: openPositions.map(p => ({ id: p.id, direction: p.direction, strategy: p.strategy, entryPrice: p.entryPrice, quantity: p.quantity })) },
      reasoning: openPositions.length > 0
        ? `Exit signal for ${symbol} — found ${openPositions.length} open position(s) for ${msg.author}`
        : `Exit signal for ${symbol} — no open position found for ${msg.author}`,
    });

    if (openPositions.length === 0) {
      return { action: 'SKIP', reason: `no open position for ${symbol}`, usedAgent: false, steps };
    }

    const pos = openPositions[0];
    const isOption = pos.strategy !== 'STOCK';

    if (isOption && pos.legs.length > 0) {
      return this.handleOptionExit(msg, pos, symbol, steps);
    }

    // ── Stock exit path (unchanged) ─────────────────────────────────────

    const quoteStart = Date.now();
    const quote = await this.broker.getQuote(symbol);
    const isSell = pos.direction === 'LONG';
    const fillPrice = roundCents(computeModelFillPrice({
      fillModel: this.fillModel, bid: quote.bid, ask: quote.ask,
      isBuy: !isSell, legCount: 1,
    }));

    // Step 2: Get quote
    steps.push({
      name: 'get_quote',
      input: { symbol },
      output: { bid: quote.bid, ask: quote.ask, last: quote.last, fillPrice },
      reasoning: `Quote ${symbol}: bid=${quote.bid} ask=${quote.ask} → fill=${fillPrice} (${this.fillModel} model)`,
      durationMs: Date.now() - quoteStart,
    });

    const closed = this.tracker.closeMatching({ symbol, trader: msg.author, exitPrice: fillPrice, closedAt: msg.timestamp });
    if (!closed) {
      return { action: 'SKIP', reason: 'failed to close position', usedAgent: false, steps };
    }

    // Step 3: Close position
    steps.push({
      name: 'close_position',
      input: { symbol, trader: msg.author, exitPrice: fillPrice },
      output: { positionId: closed.id, entryPrice: closed.entryPrice, exitPrice: closed.exitPrice, pnl: closed.pnl, strategy: closed.strategy, quantity: closed.quantity },
      reasoning: `Closed ${closed.direction} ${closed.strategy} ${symbol}: entry=$${closed.entryPrice} exit=$${fillPrice} P&L=$${closed.pnl?.toFixed(2)}`,
    });

    return {
      action: 'CLOSE',
      position: closed,
      reason: `Closed ${symbol} at ${fillPrice}, P&L: ${closed.pnl?.toFixed(2)}`,
      usedAgent: false,
      steps,
    };
  }

  // ── Option exit path ────────────────────────────────────────────────

  private async handleOptionExit(
    msg: HistoricalMessage,
    pos: import('./types.js').SimPosition,
    symbol: string,
    steps: ExecutionStep[],
  ): Promise<ExecutionResult> {
    const quoteStart = Date.now();

    // For each stored leg, get quote and compute exit fill (reversing action)
    const legExits: { leg: SimLeg; occSymbol: string; bid: number; ask: number; exitFill: number }[] = [];
    for (const leg of pos.legs) {
      // Use stored OCC symbol if available, otherwise reconstruct
      const occSymbol = isOccOptionSymbol(leg.symbol)
        ? leg.symbol
        : formatOccSymbol({
            underlying: symbol,
            expiration: leg.expiry,
            type: leg.type as 'CALL' | 'PUT',
            strike: leg.strike,
          });

      const quote = await this.broker.getQuote(occSymbol);
      // Reverse action: original BUY → exit SELL, original SELL → exit BUY
      const isBuy = leg.action === 'SELL'; // reversing
      const exitFill = roundCents(computeModelFillPrice({
        fillModel: this.fillModel,
        bid: quote.bid,
        ask: quote.ask,
        isBuy,
        legCount: 1,
      }));

      legExits.push({ leg, occSymbol, bid: quote.bid, ask: quote.ask, exitFill });
    }

    // Net exit premium: same sign convention as entry (BUY debit, SELL credit) but reversed
    const netExitPremium = roundCents(Math.abs(
      legExits.reduce((sum, le) => {
        // Exit reverses: original BUY leg → now SELL (credit), original SELL leg → now BUY (debit)
        const sign = le.leg.action === 'BUY' ? 1 : -1; // reversed from open
        return sum + sign * le.exitFill;
      }, 0),
    ));

    steps.push({
      name: 'get_option_quotes',
      input: { symbol, strategy: pos.strategy, fillModel: this.fillModel },
      output: {
        legs: legExits.map(le => ({ occ: le.occSymbol, exitAction: le.leg.action === 'BUY' ? 'SELL' : 'BUY', bid: le.bid, ask: le.ask, fill: le.exitFill })),
        netExitPremium,
      },
      reasoning: legExits.map(le => `${le.leg.action === 'BUY' ? 'SELL' : 'BUY'} ${le.occSymbol}: bid=${le.bid} ask=${le.ask} → fill=${le.exitFill}`).join(' | '),
      durationMs: Date.now() - quoteStart,
    });

    // Close position with net exit premium as exitPrice
    const closed = this.tracker.close(pos.id, netExitPremium, msg.timestamp, msg.id);
    if (!closed) {
      return { action: 'SKIP', reason: 'failed to close option position', usedAgent: false, steps };
    }

    steps.push({
      name: 'close_position',
      input: { symbol, trader: msg.author, exitPrice: netExitPremium },
      output: { positionId: closed.id, entryPrice: closed.entryPrice, exitPrice: closed.exitPrice, pnl: closed.pnl, strategy: closed.strategy, quantity: closed.quantity },
      reasoning: `Closed ${closed.direction} ${closed.strategy} ${symbol}: entry=$${closed.entryPrice} exit=$${netExitPremium} P&L=$${closed.pnl?.toFixed(2)}`,
    });

    return {
      action: 'CLOSE',
      position: closed,
      reason: `Closed ${pos.strategy} ${symbol} at $${netExitPremium}, P&L: ${closed.pnl?.toFixed(2)}`,
      usedAgent: false,
      steps,
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
