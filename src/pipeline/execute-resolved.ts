/**
 * Executor for orchestrator-produced ResolvedSignal[].
 *
 * The orchestrator resolves every ambiguity before signals reach here:
 * concrete legs, signed limit prices, position-matched tradeIds.
 * This module is purely mechanical: derive metadata → size → risk → order → record.
 *
 * Emits per-signal events through env.emitter (SETTLED with outcome per signal).
 */

import type { BrokerService } from '../broker/interface.js';
import type { OrderLeg, OrderResult, WorkingOrderParams, AdjustmentRule } from '../broker/types.js';
import type { OrderManager } from '../orders/order-manager.js';
import type { PositionSize } from '../position-sizing/index.js';
import type { RiskCheckResult } from '../orders/risk-check.js';
import type { RecordTradeInput, RecordTradeResult } from '../trades/record-trade.js';
import type { ResolvedSignal, OrchestratorResult, Leg, TradePosition, SignalEventEmitter } from '../intents/orchestrator/types.js';
import type { Message, TradeFlag, TradeMetadata } from '../db/schema.js';
import type { LLMProvider } from '../agent/providers.js';
import type { Direction, Strategy } from '../lib/enums.js';
import type { TraceContext } from '../lib/trace.js';
import { traced } from '../lib/trace.js';
import { isSpread, getOptionLegs } from '../lib/trade.js';
import { OrderResultSchema } from '../broker/order-schemas.js';
import { formatOccSymbol } from '../lib/occ-symbology.js';
import { getMidpoint, getQuoteMark, isCreditOrder, isCreditOrderStructural } from './leg-pricing.js';
import { QuoteResolutionError } from '../lib/errors.js';
import { resolveOrchestrator } from '../intents/orchestrator/index.js';
import { floorCents, round, roundCents } from '../lib/numbers.js';
import { createLogger } from '../lib/logger.js';
import { addTradeFlags } from '../trades/trade-flags.js';

const log = createLogger('ExecuteResolved');

// ─── Types ──────────────────────────────────────────

export type ResolvedPendingContext = {
  symbol: string;
  trader: string;
  direction: Direction;
  strategy: Strategy;
  quantity: number;
  legs: OrderLeg[];
  messageId?: string;
  taskId?: string;
  tradeId?: string;
  signalIndex?: number;
  recordFill: (fill: { filledPrice: number; filledAt: Date; adjustmentCount: number }) => Promise<RecordTradeResult | null>;
};

export type ResolvedPipelineDeps = {
  broker: BrokerService;
  orderManager: OrderManager;
  calculatePositionSize: (input: {
    trader: string;
    symbol: string;
    entryPrice: number;
    strategy: string;
    legs: Leg[];
  }) => Promise<PositionSize>;
  checkRiskLimits: (input: {
    symbol: string;
    strategy: string;
    trader: string;
    action?: string;
    direction?: string;
  }) => Promise<RiskCheckResult>;
  recordTrade: (input: Omit<RecordTradeInput, 'channelId'>) => Promise<RecordTradeResult | null>;
  onPending: (orderId: string, context: ResolvedPendingContext) => void;
};

export type ResolvedPipelineResult = {
  signal: ResolvedSignal;
  executed: boolean;
  reason?: string;
  tradeId?: string;
};

/** What executeResolvedSignals needs from the caller's env. */
export type ExecuteEnv = {
  getPositions: (symbol?: string) => Promise<TradePosition[]>;
  llm: LLMProvider;
  pipeline: ResolvedPipelineDeps;
  emitter: SignalEventEmitter;
  trace?: TraceContext;
};

// ─── Chase profiles ─────────────────────────────────

/** @internal Exported for testing. */
export type ChaseProfile = {
  pctPerStep: number;        // % of signal price per step
  minStep: number;           // absolute minimum step ($)
  maxStep: number;           // absolute maximum step ($)
  maxSlippagePct: number;    // max deviation from signal price (0-1)
  intervalSec: number;
  cancelAfterSec?: number;
};

/** @internal Exported for testing. */
export const CHASE_PROFILES = {
  OPTION_OPEN_SELL:  { pctPerStep: 0.02, minStep: 0.01, maxStep: 0.10, maxSlippagePct: 0.30, intervalSec: 5, cancelAfterSec: 45 },
  OPTION_OPEN_BUY:   { pctPerStep: 0.04, minStep: 0.02, maxStep: 0.25, maxSlippagePct: 0.50, intervalSec: 5, cancelAfterSec: 60 },
  OPTION_CLOSE:      { pctPerStep: 0.005, minStep: 0.01, maxStep: 0.10, maxSlippagePct: 0.80, intervalSec: 5 },
  SPREAD_OPEN_SELL:  { pctPerStep: 0.02, minStep: 0.01, maxStep: 0.10, maxSlippagePct: 0.30, intervalSec: 5, cancelAfterSec: 45 },
  SPREAD_OPEN_BUY:   { pctPerStep: 0.03, minStep: 0.01, maxStep: 0.15, maxSlippagePct: 0.50, intervalSec: 5, cancelAfterSec: 60 },
  SPREAD_CLOSE:      { pctPerStep: 0.04, minStep: 0.01, maxStep: 0.20, maxSlippagePct: 0.85, intervalSec: 5 },
  STOCK_OPEN:        { pctPerStep: 0,    minStep: 0.03, maxStep: 0.03, maxSlippagePct: 0.05, intervalSec: 5, cancelAfterSec: 60 },
  STOCK_CLOSE:       { pctPerStep: 0,    minStep: 0.05, maxStep: 0.05, maxSlippagePct: 0.10, intervalSec: 5 },
} as const satisfies Record<string, ChaseProfile>;

type ResolvedChaseParams = {
  stepAmount: number;
  chaseLimit: number;
  intervalSec: number;
  maxSteps: number;
  cancelAfterSec?: number;
};

/** @internal Exported for testing. */
export function resolveChaseParams(profile: ChaseProfile, signalPrice: number, isBuy: boolean): ResolvedChaseParams {
  const rawStep = signalPrice * profile.pctPerStep;
  const stepAmount = floorCents(Math.min(profile.maxStep, Math.max(profile.minStep, rawStep)));

  // Buy orders chase UP (willing to pay more); sell orders chase DOWN (willing to accept less).
  const chaseLimit = isBuy
    ? roundCents(signalPrice * (1 + profile.maxSlippagePct))
    : roundCents(Math.max(0.01, signalPrice * (1 - profile.maxSlippagePct)));

  const chaseRange = Math.abs(chaseLimit - signalPrice);
  const maxSteps = Math.max(1, Math.floor(chaseRange / stepAmount));
  return { stepAmount, chaseLimit, intervalSec: profile.intervalSec, maxSteps, cancelAfterSec: profile.cancelAfterSec };
}

/** @internal Exported for testing. */
export function selectChaseProfile(strategy: Strategy, isPositionReducing: boolean, isBuy: boolean): ChaseProfile {
  if (strategy === 'STOCK') {
    return isPositionReducing ? CHASE_PROFILES.STOCK_CLOSE : CHASE_PROFILES.STOCK_OPEN;
  }
  const spread = isSpread(strategy);
  if (isPositionReducing) {
    return spread ? CHASE_PROFILES.SPREAD_CLOSE : CHASE_PROFILES.OPTION_CLOSE;
  }
  if (spread) {
    return isBuy ? CHASE_PROFILES.SPREAD_OPEN_BUY : CHASE_PROFILES.SPREAD_OPEN_SELL;
  }
  return isBuy ? CHASE_PROFILES.OPTION_OPEN_BUY : CHASE_PROFILES.OPTION_OPEN_SELL;
}

// ─── Derive metadata from legs ──────────────────────

/** Extract underlying symbol from the first leg. */
function deriveSymbol(legs: Leg[]): string {
  return legs[0].symbol;
}

/**
 * Derive strategy from leg shapes.
 * 2-leg spreads: check optionType + strike relationship to distinguish debit vs credit.
 * PUT: SELL higher strike + BUY lower strike = PCS (credit), else PDS (debit).
 * CALL: SELL lower strike + BUY higher strike = CCS (credit), else CDS (debit).
 * 1 CALL → CALL, 1 PUT → PUT, stock → STOCK.
 */
function deriveStrategy(legs: Leg[]): Strategy {
  if (legs[0].type === 'stock') return 'STOCK';
  const optionLegs = getOptionLegs(legs);
  if (optionLegs.length === 2) {
    const buyLeg = optionLegs.find(l => l.side === 'BUY')!;
    const sellLeg = optionLegs.find(l => l.side === 'SELL')!;
    if (optionLegs[0].optionType === 'PUT') {
      // PCS: sell higher put, buy lower put (credit). PDS: buy higher put (debit).
      return sellLeg.strike > buyLeg.strike ? 'PCS' : 'PDS';
    }
    // CCS: sell lower call, buy higher call (credit). CDS: buy lower call (debit).
    return sellLeg.strike < buyLeg.strike ? 'CCS' : 'CDS';
  }
  return optionLegs[0].optionType;
}

/** Derive direction from net side: net BUY = LONG, net SELL = SHORT. */
function deriveDirection(legs: Leg[]): Direction {
  // For single legs or stock, side maps directly
  if (legs.length === 1) {
    return legs[0].side === 'BUY' ? 'LONG' : 'SHORT';
  }
  // For spreads: the BUY leg determines the long side
  // CDS LONG: BUY lower CALL, SELL upper CALL → net debit → LONG
  // PDS SHORT: SELL higher PUT, BUY lower PUT → net credit → SHORT
  const buys = legs.filter(l => l.side === 'BUY').length;
  const sells = legs.filter(l => l.side === 'SELL').length;
  if (buys > sells) return 'LONG';
  if (sells > buys) return 'SHORT';
  // Equal: debit spread (BUY at higher premium) = LONG convention
  // For 2-leg spreads, check which leg has the higher strike
  const optionLegs = getOptionLegs(legs);
  if (optionLegs.length === 2) {
    const buyLeg = optionLegs.find(l => l.side === 'BUY')!;
    const sellLeg = optionLegs.find(l => l.side === 'SELL')!;
    if (buyLeg.optionType === 'CALL') {
      // CDS: buy lower strike = debit = LONG
      return buyLeg.strike < sellLeg.strike ? 'LONG' : 'SHORT';
    } else {
      // PDS: buy higher strike = debit = LONG
      return buyLeg.strike > sellLeg.strike ? 'LONG' : 'SHORT';
    }
  }
  return 'LONG';
}

// ─── Convert orchestrator Leg → broker OrderLeg ─────

function legToOrderLeg(leg: Leg, lotCount: number): OrderLeg {
  if (leg.type === 'stock') {
    return {
      symbol: leg.symbol,
      strike: 0,
      expiry: '',
      type: 'STOCK' as const,
      action: leg.side,
      quantity: leg.quantity * lotCount,
    };
  }
  return {
    symbol: formatOccSymbol({
      underlying: leg.symbol,
      expiration: leg.expiry,
      type: leg.optionType,
      strike: leg.strike,
    }),
    strike: leg.strike,
    expiry: leg.expiry,
    type: leg.optionType,
    action: leg.side,
    quantity: leg.quantity * lotCount,
  };
}

function legsToOrderLegs(legs: Leg[], lotCount: number): OrderLeg[] {
  return legs.map(l => legToOrderLeg(l, lotCount));
}

// ─── Order building ─────────────────────────────────

function buildOrderParams(
  strategy: Strategy,
  direction: Direction,
  symbol: string,
  legs: OrderLeg[],
  limitPrice: number | undefined,
  isPositionReducing: boolean,
  isCredit: boolean,
): WorkingOrderParams {
  // Safety guard: options have massive bid-ask spreads ($1-3+). A MARKET order
  // would fill at the worst side, costing hundreds in avoidable slippage.
  if (strategy !== 'STOCK' && !limitPrice) {
    throw new Error(
      `MARKET orders on options are forbidden (strategy=${strategy}, symbol=${symbol}). limitPrice is required for all non-stock orders.`
    );
  }

  let adjustmentRules: AdjustmentRule[] | undefined;
  let cancelAfterSec: number | undefined;

  if (limitPrice) {
    // For options, credit/debit determines chase direction (credit=SELL, debit=BUY).
    // For stocks, there's no credit/debit — use direction directly.
    const isBuy = strategy === 'STOCK' ? direction === 'LONG' : !isCredit;
    const profile = selectChaseProfile(strategy, isPositionReducing, isBuy);
    const chase = resolveChaseParams(profile, limitPrice, isBuy);
    adjustmentRules = [{
      type: 'PRICE_CHASE',
      stepAmount: chase.stepAmount,
      intervalSec: chase.intervalSec,
      maxSteps: chase.maxSteps,
      chaseLimit: chase.chaseLimit,
    }];
    cancelAfterSec = chase.cancelAfterSec;
  }

  return {
    symbol,
    strategy,
    direction,
    legs,
    orderType: limitPrice ? 'LIMIT' : 'MARKET',
    limitPrice,
    adjustmentRules,
    cancelAfterSec,
    isClosing: isPositionReducing,
  };
}

// ─── Pricing context for ORDER_PLACED snapshots ─────

type PricingContext = {
  sigPrice: number;
  mid: number;
  isCredit: boolean;
};

// ─── Place order ────────────────────────────────────

async function placeOrder(
  deps: ResolvedPipelineDeps,
  params: WorkingOrderParams,
  pending: ResolvedPendingContext,
  emitter: SignalEventEmitter,
  signalIndex?: number,
  pricingContext?: PricingContext,
): Promise<OrderResult> {
  const raw = await deps.orderManager.submitOrder(params);
  const result = OrderResultSchema.parse(raw);

  if (result.status !== 'REJECTED') {
    await emitter.emit('ORDER_PLACED', { signalIndex }, { ...result, params, ...pricingContext });
  }

  if (result.status === 'FILLED') {
    await emitter.emit('ORDER_FILLED', { signalIndex }, { ...result, immediatelyFilled: true });
    await pending.recordFill({
      filledPrice: result.filledPrice!,
      filledAt: new Date(result.fillTimestamp!),
      adjustmentCount: 0,
    });
  } else if (result.status === 'OPEN' && result.orderId) {
    deps.onPending(result.orderId, pending);
  }

  return result;
}

// ─── Single signal executor ─────────────────────────

async function executeResolvedSignal(
  signal: ResolvedSignal,
  trader: string,
  deps: ResolvedPipelineDeps,
  emitter: SignalEventEmitter,
  messageId?: string,
  signalIndex?: number,
  trace?: TraceContext,
): Promise<ResolvedPipelineResult> {
  const symbol = deriveSymbol(signal.legs);
  const strategy = deriveStrategy(signal.legs);
  const direction = deriveDirection(signal.legs);
  const signalAction = signal.action;
  const isPositionReducing = signalAction === 'CLOSE' || signalAction === 'TRIM' || signalAction === 'LEG_OFF';

  // One info line per signal — the authoritative execution log
  const logAction = signalAction;
  const optLegs = getOptionLegs(signal.legs);
  const execParts = [`${logAction} ${direction} ${strategy} ${symbol}`];
  if (optLegs.length > 0) {
    execParts.push(`${signal.legs.length} leg(s) expiry=${optLegs[0].expiry} strikes=${optLegs.map(l => l.strike).join('/')}`);
  }
  if (signal.limitPrice != null) execParts.push(`limit=$${signal.limitPrice}`);
  if (signal.tradeId) execParts.push(`tradeId=${signal.tradeId}`);
  log.info(execParts.join(' | '));

  // ── OPEN path ──────────────────────────────────────

  if (!isPositionReducing) {
    // 1. Size
    const entryPrice = await traced(trace, 'getMidpoint', 'broker', () => getMidpoint(deps.broker, legsToOrderLegs(signal.legs, 1)));

    const size = await traced(trace, 'sizer', 'sync', () => deps.calculatePositionSize({
      trader,
      symbol,
      entryPrice,
      strategy,
      legs: signal.legs,
    }));
    if (size.quantity <= 0) {
      return { signal, executed: false, reason: `Position sizer returned qty=${size.quantity}` };
    }

    await emitter.emit('SIZED', { signalIndex }, { ...size, symbol, strategy, direction, entryPrice });

    // 2. Risk check
    const risk = await traced(trace, 'riskCheck', 'db', () => deps.checkRiskLimits({ symbol, strategy, trader, action: signalAction, direction }));
    if (!risk.allowed) {
      return { signal, executed: false, reason: `Risk blocked: ${risk.reason}` };
    }

    // 3. Build order
    const orderLegs = legsToOrderLegs(signal.legs, size.quantity);
    const mid = await traced(trace, 'getMidpoint', 'broker', () => getMidpoint(deps.broker, orderLegs));
    const { isCredit } = await traced(trace, 'creditCheck', 'broker', () => isCreditOrder(deps.broker, orderLegs));
    const sigPrice = signal.limitPrice != null ? Math.abs(signal.limitPrice) : mid;
    // Credit: maximize what you receive (vs mid). Debit/stock: minimize what you pay (vs 75% mark).
    const limitPrice = isCredit
      ? Math.max(sigPrice, mid)
      : Math.min(sigPrice, await getQuoteMark(deps.broker, orderLegs, 0.75));
    const params = buildOrderParams(strategy, direction, symbol, orderLegs, limitPrice, false, isCredit);

    // 4. Place and record
    let tradeId: string | undefined;
    const result = await traced(trace, 'placeOrder', 'broker', () => placeOrder(deps, params, {
      symbol,
      trader,
      direction,
      strategy,
      quantity: size.quantity,
      legs: orderLegs,
      messageId,
      signalIndex,
      recordFill: async (fill) => {
        // Build chase metadata from fill (moved from caller)
        const chaseFlags: TradeFlag[] = [];
        if (fill.adjustmentCount >= 10) chaseFlags.push('chaseDanger');
        else if (fill.adjustmentCount >= 5) chaseFlags.push('chaseWarn');
        // Chase slippage: how much worse the fill was vs initial limit.
        // BUY (debit): slippage = paid more. SELL (credit): slippage = received less.
        const isBuy = strategy === 'STOCK' ? direction === 'LONG' : !isCredit;
        const entrySlippage = isBuy
          ? roundCents(fill.filledPrice - limitPrice)
          : roundCents(limitPrice - fill.filledPrice);
        const entrySlippagePct = limitPrice > 0 ? round(entrySlippage / limitPrice, 4) : 0;
        const fillMetadata: TradeMetadata = {
          ...(fill.adjustmentCount > 0 ? { chaseSteps: fill.adjustmentCount } : {}),
          ...(chaseFlags.length > 0 ? { flags: chaseFlags } : {}),
          entrySlippage,
          entrySlippagePct,
        };
        const recorded = await deps.recordTrade({
          action: signalAction,
          symbol,
          trader,
          direction,
          strategy,
          entryPrice: fill.filledPrice,
          quantity: size.quantity,
          legs: orderLegs,
          openedAt: fill.filledAt.toISOString(),
          sourceMessageId: messageId,
          ...(signal.tradeId && { tradeId: signal.tradeId }),
          metadata: fillMetadata,
        });
        if (recorded) tradeId = recorded.tradeId;
        return recorded;
      },
    }, emitter, signalIndex, { sigPrice, mid, isCredit }));

    if (result.status === 'REJECTED') {
      return { signal, executed: false, reason: result.message ?? 'Order rejected' };
    }
    return { signal, executed: result.status === 'FILLED', tradeId };
  }

  // ── Position-reducing path ─────────────────────────

  // Quantity comes from the legs directly — the orchestrator already computed
  // the correct quantities (full position for CLOSE, partial for TRIM, single
  // leg for LEG_OFF).
  const orderLegs = legsToOrderLegs(signal.legs, 1); // quantity is already in the legs
  const closeMid = await traced(trace, 'getMidpoint', 'broker', () => getMidpoint(deps.broker, orderLegs));
  // deriveDirection returns the ORDER direction from the signal legs' sides:
  // SELL legs → SHORT (selling), BUY legs → LONG (buying back).
  // This is already the correct direction for the broker's fill check
  // (isBuyOrder uses params.direction to decide BUY vs SELL fill logic).
  const closeIsCredit = isCreditOrderStructural(orderLegs) ?? false;
  const params = buildOrderParams(strategy, direction, symbol, orderLegs, closeMid, true, closeIsCredit);

  let tradeId: string | undefined;
  const quantity = orderLegs[0]?.quantity ?? 1;
  const result = await traced(trace, 'placeOrder', 'broker', () => placeOrder(deps, params, {
    symbol,
    trader,
    direction,
    strategy,
    quantity,
    legs: orderLegs,
    messageId,
    tradeId: signal.tradeId,
    signalIndex,
    recordFill: async (fill) => {
      const chaseFlags: TradeFlag[] = [];
      if (fill.adjustmentCount >= 10) chaseFlags.push('chaseDanger');
      else if (fill.adjustmentCount >= 5) chaseFlags.push('chaseWarn');
      // Chase slippage on exit: same sign convention as entry (positive = worse).
      const closeBuy = strategy === 'STOCK' ? direction !== 'LONG' : !closeIsCredit;
      const exitSlippage = closeBuy
        ? roundCents(fill.filledPrice - closeMid)
        : roundCents(closeMid - fill.filledPrice);
      const exitSlippagePct = closeMid > 0 ? round(exitSlippage / closeMid, 4) : 0;
      const fillMetadata: TradeMetadata = {
        ...(fill.adjustmentCount > 0 ? { chaseSteps: fill.adjustmentCount } : {}),
        ...(chaseFlags.length > 0 ? { flags: chaseFlags } : {}),
        exitSlippage,
        exitSlippagePct,
      };
      const action = signal.exitPercent != null && signal.exitPercent < 1
        ? 'TRIM' as const
        : 'CLOSE' as const;
      const recorded = await deps.recordTrade({
        action,
        tradeId: signal.tradeId,
        symbol,
        trader,
        direction,
        strategy,
        exitPrice: fill.filledPrice,
        quantity,
        ...(signal.exitPercent != null && signal.exitPercent < 1 && {
          closeQuantity: quantity,
          exitPercent: signal.exitPercent,
        }),
        legs: orderLegs,
        closedAt: fill.filledAt.toISOString(),
        closeMessageId: messageId,
        metadata: fillMetadata,
      });
      if (recorded) tradeId = recorded.tradeId;
      return recorded;
    },
  }, emitter, signalIndex, { sigPrice: closeMid, mid: closeMid, isCredit: closeIsCredit }));

  if (result.status === 'REJECTED') {
    return { signal, executed: false, reason: result.message ?? 'Order rejected' };
  }
  return { signal, executed: result.status === 'FILLED', tradeId };
}

// ─── Public API ─────────────────────────────────────

/**
 * Execute an array of ResolvedSignals sequentially.
 * Each signal is independent — a failure on signal N does not prevent signal N+1.
 *
 * Emits per-signal events (SETTLED with outcome) through env.emitter.
 * On QuoteResolutionError, emits QUOTE_FAILED + RETRY_LLM, then retries
 * via resolveOrchestrator with failureContext (max 1 retry).
 */
export async function executeResolvedSignals(ctx: {
  resolved: OrchestratorResult & { outcome: 'EXECUTE' };
  message: Message;
  env: ExecuteEnv;
}): Promise<ResolvedPipelineResult[]> {
  const { resolved, message, env } = ctx;
  const deps = env.pipeline;
  const trader = message.author;
  const emitter = env.emitter;
  const results: ResolvedPipelineResult[] = [];

  for (let i = 0; i < resolved.signals.length; i++) {
    const signal = resolved.signals[i];

    try {
      const result = await executeResolvedSignal(signal, trader, deps, emitter, message.id, i, env.trace);
      results.push(result);

      // Emit SETTLED for this signal
      const outcome = result.executed ? 'EXECUTE' : (result.reason ? 'FAIL' : 'PENDING');
      await emitter.emit('SETTLED',
        { outcome, signalIndex: i, reasoning: result.reason, tradeId: result.tradeId, inputTokens: resolved.usage?.inputTokens, outputTokens: resolved.usage?.outputTokens },
        { signal, result, resolved },
      );
    } catch (err) {
      if (err instanceof QuoteResolutionError) {
        // Record the original failure
        const failResult: ResolvedPipelineResult = {
          signal,
          executed: false,
          reason: `Quote resolution failed: ${err.originalMessage}`,
        };
        results.push(failResult);

        await emitter.emit('QUOTE_FAILED', { signalIndex: i }, { occSymbol: err.occSymbol, error: err.originalMessage, signal });
        if (signal.tradeId) {
          await addTradeFlags(signal.tradeId, 'marketDataFail');
        }

        // Attempt retry via LLM re-parse
        log.info(`Quote resolution failed — retrying via LLM: ${err.originalMessage.slice(0, 120)}`);
        await emitter.emit('RETRY_LLM', { signalIndex: i }, { reason: 'invalid strike', originalError: err.originalMessage });

        const retryResolved = await resolveOrchestrator(message, {
          getPositions: env.getPositions,
          llm: env.llm,
          broker: deps.broker,
          emitter,
        }, { failureContext: { error: err.originalMessage } });

        if (retryResolved.outcome !== 'EXECUTE') {
          // Retry didn't produce signals — emitter already fired from orchestrator for the skip
          continue;
        }

        // Execute retry signals (no further retries)
        for (let ri = 0; ri < retryResolved.signals.length; ri++) {
          const retrySignal = retryResolved.signals[ri];

          // Check if the retry produced the same bad symbol
          if (err.occSymbol) {
            const stillBad = getOptionLegs(retrySignal.legs)
              .some(l => formatOccSymbol({ underlying: l.symbol, expiration: l.expiry, type: l.optionType, strike: l.strike }) === err.occSymbol);
            if (stillBad) {
              const sameSymbolResult: ResolvedPipelineResult = {
                signal: retrySignal,
                executed: false,
                reason: `Quote resolution retry returned same invalid symbol ${err.occSymbol}`,
              };
              results.push(sameSymbolResult);
              await emitter.emit('SETTLED',
                { outcome: 'FAIL', signalIndex: resolved.signals.length + ri, reasoning: sameSymbolResult.reason! },
                { signal: retrySignal, result: sameSymbolResult, retryContext: { originalError: err.originalMessage } },
              );
              continue;
            }
          }

          try {
            const retryResult = await executeResolvedSignal(retrySignal, trader, deps, emitter, message.id, resolved.signals.length + ri, env.trace);
            results.push(retryResult);
            const outcome = retryResult.executed ? 'EXECUTE' : 'FAIL';
            await emitter.emit('SETTLED',
              { outcome, signalIndex: resolved.signals.length + ri, reasoning: retryResult.reason, tradeId: retryResult.tradeId, inputTokens: retryResolved.usage?.inputTokens, outputTokens: retryResolved.usage?.outputTokens },
              { signal: retrySignal, result: retryResult, retryResolved, retryContext: { originalError: err.originalMessage } },
            );
          } catch (retryErr) {
            const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            const retryFailResult: ResolvedPipelineResult = {
              signal: retrySignal,
              executed: false,
              reason: `Quote resolution retry failed: ${errMsg}`,
            };
            results.push(retryFailResult);
            await emitter.emit('SETTLED',
              { outcome: 'FAIL', signalIndex: resolved.signals.length + ri, reasoning: retryFailResult.reason! },
              { signal: retrySignal, result: retryFailResult, retryContext: { originalError: err.originalMessage }, error: errMsg },
            );
          }
        }
      } else {
        throw err;
      }
    }
  }
  return results;
}
