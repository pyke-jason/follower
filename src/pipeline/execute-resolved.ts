/**
 * Executor for orchestrator-produced ResolvedSignal[].
 *
 * The orchestrator resolves every ambiguity before signals reach here:
 * concrete legs, signed limit prices, position-matched tradeIds.
 * This module is purely mechanical: derive metadata → size → risk → order → record.
 *
 * Fires env.onDecision per-signal as each resolves (phase: 'pipeline' or 'order').
 */

import type { BrokerService } from '../broker/interface.js';
import type { OrderLeg, OrderResult, WorkingOrderParams, AdjustmentRule } from '../broker/types.js';
import type { OrderManager } from '../orders/order-manager.js';
import type { PositionSize } from '../position-sizing/index.js';
import type { RiskCheckResult } from '../orders/risk-check.js';
import type { RecordTradeInput, RecordTradeResult } from '../trades/record-trade.js';
import type { ResolvedSignal, OrchestratorResult, OptionLeg, Leg, OpenPosition } from '../intents/orchestrator/types.js';
import type { DecisionRow, Message } from '../db/schema.js';
import type { LLMProvider } from '../agent/providers.js';
import type { Direction, Strategy } from '../lib/enums.js';
import { OrderResultSchema } from '../broker/order-schemas.js';
import { formatOccSymbol } from '../backtest/occ-symbology.js';
import { getSpreadMidpoint } from './spread-midpoint.js';
import { QuoteResolutionError } from '../lib/errors.js';
import { resolveOrchestrator } from '../intents/orchestrator/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ExecuteResolved');

// ─── Types ──────────────────────────────────────────

export type ResolvedPendingContext = {
  symbol: string;
  direction: Direction;
  strategy: Strategy;
  quantity: number;
  legs: OrderLeg[];
  messageId?: string;
  tradeId?: string;
  recordFill: (filledPrice: number, filledAt?: Date) => Promise<RecordTradeResult | null>;
};

export type ResolvedPipelineDeps = {
  broker: BrokerService;
  orderManager?: OrderManager;
  calculatePositionSize: (input: {
    trader: string;
    symbol: string;
    entryPrice: number;
    strategy: string;
    spreadMaxRisk?: number;
  }) => Promise<PositionSize>;
  checkRiskLimits: (input: {
    symbol: string;
    strategy: string;
    trader: string;
    action?: string;
  }) => Promise<RiskCheckResult>;
  recordTrade: (input: RecordTradeInput) => Promise<RecordTradeResult | null>;
  onPending?: (orderId: string, context: ResolvedPendingContext) => void;
};

export type ResolvedPipelineResult = {
  signal: ResolvedSignal;
  executed: boolean;
  reason?: string;
  tradeId?: string;
  orderId?: string;
};

/** What executeResolvedSignals needs from the caller's env. */
export type ExecuteEnv = {
  getPositions: (symbol?: string) => Promise<OpenPosition[]>;
  llm: LLMProvider;
  pipeline: ResolvedPipelineDeps;
  onDecision: (row: DecisionRow) => Promise<void>;
};

// ─── Per-strategy order defaults ────────────────────

const ORDER_DEFAULTS: Record<string, { stepAmount: number; intervalSec: number; cancelAfterSec: number }> = {
  STOCK: { stepAmount: 0.03, intervalSec: 5, cancelAfterSec: 60 },
  CALL:  { stepAmount: 0.10, intervalSec: 5, cancelAfterSec: 60 },
  PUT:   { stepAmount: 0.10, intervalSec: 5, cancelAfterSec: 60 },
  CDS:   { stepAmount: 0.05, intervalSec: 5, cancelAfterSec: 60 },
  PDS:   { stepAmount: 0.05, intervalSec: 5, cancelAfterSec: 60 },
};

const CLOSE_ORDER_DEFAULTS: Record<string, { stepAmount: number; intervalSec: number; maxSteps: number }> = {
  STOCK: { stepAmount: 0.05, intervalSec: 5, maxSteps: 24 },
  CALL:  { stepAmount: 0.15, intervalSec: 5, maxSteps: 20 },
  PUT:   { stepAmount: 0.15, intervalSec: 5, maxSteps: 20 },
  CDS:   { stepAmount: 0.10, intervalSec: 5, maxSteps: 20 },
  PDS:   { stepAmount: 0.10, intervalSec: 5, maxSteps: 20 },
};

// ─── Derive metadata from legs ──────────────────────

/** Extract underlying symbol from the first leg. */
function deriveSymbol(legs: Leg[]): string {
  return legs[0].symbol;
}

/**
 * Derive strategy from leg shapes.
 * 2 CALL legs → CDS, 2 PUT legs → PDS, 1 CALL → CALL, 1 PUT → PUT, stock → STOCK.
 */
function deriveStrategy(legs: Leg[]): Strategy {
  if (legs[0].type === 'stock') return 'STOCK';
  const optionLegs = legs.filter((l): l is OptionLeg => l.type === 'option');
  if (optionLegs.length === 2) {
    return optionLegs[0].optionType === 'CALL' ? 'CDS' : 'PDS';
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
  const optionLegs = legs.filter((l): l is OptionLeg => l.type === 'option');
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
): WorkingOrderParams {
  const defaults = isPositionReducing
    ? (CLOSE_ORDER_DEFAULTS[strategy] ?? CLOSE_ORDER_DEFAULTS.STOCK)
    : (ORDER_DEFAULTS[strategy] ?? ORDER_DEFAULTS.STOCK);

  const adjustmentRules: AdjustmentRule[] = limitPrice
    ? [{
      type: 'PRICE_CHASE',
      stepAmount: defaults.stepAmount,
      intervalSec: defaults.intervalSec,
      ...('maxSteps' in defaults ? { maxSteps: defaults.maxSteps } : {}),
    }]
    : [];

  return {
    symbol,
    strategy,
    direction,
    legs,
    orderType: limitPrice ? 'LIMIT' : 'MARKET',
    limitPrice,
    adjustmentRules: adjustmentRules.length > 0 ? adjustmentRules : undefined,
    cancelAfterSec: limitPrice && !isPositionReducing
      ? (ORDER_DEFAULTS[strategy] ?? ORDER_DEFAULTS.STOCK).cancelAfterSec
      : undefined,
    isClosing: isPositionReducing || undefined,
  };
}

// ─── Place order ────────────────────────────────────

async function placeOrder(
  deps: ResolvedPipelineDeps,
  params: WorkingOrderParams,
  pending: ResolvedPendingContext,
): Promise<OrderResult> {
  let raw: OrderResult;
  if (deps.orderManager) {
    raw = await deps.orderManager.submitOrder(params);
  } else {
    const { adjustmentRules, cancelAfterSec, ...orderParams } = params;
    raw = await deps.broker.placeOrder(orderParams);
  }
  const result = OrderResultSchema.parse(raw);

  if (result.status === 'FILLED') {
    await pending.recordFill(
      result.filledPrice!,
      new Date(result.fillTimestamp!),
    );
  } else if (result.status === 'OPEN' && result.orderId && deps.onPending) {
    deps.onPending(result.orderId, pending);
  }

  return result;
}

// ─── Entry price estimate ───────────────────────────

async function getEntryPriceEstimate(symbol: string, broker: BrokerService): Promise<number> {
  const quote = await broker.getQuote(symbol);
  return (quote.bid + quote.ask) / 2;
}

// ─── Single signal executor ─────────────────────────

async function executeResolvedSignal(
  signal: ResolvedSignal,
  trader: string,
  deps: ResolvedPipelineDeps,
  messageId?: string,
): Promise<ResolvedPipelineResult> {
  const symbol = deriveSymbol(signal.legs);
  const strategy = deriveStrategy(signal.legs);
  const direction = deriveDirection(signal.legs);
  const isPositionReducing = !!signal.tradeId;

  // One info line per signal — the authoritative execution log
  const logAction = isPositionReducing
    ? (signal.exitPercent != null && signal.exitPercent < 1 ? 'TRIM' : 'CLOSE')
    : 'OPEN';
  const optLegs = signal.legs.filter((l): l is OptionLeg => l.type === 'option');
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
    const entryPrice = await getEntryPriceEstimate(symbol, deps.broker);
    const size = await deps.calculatePositionSize({
      trader,
      symbol,
      entryPrice,
      strategy,
    });
    if (size.quantity <= 0) {
      return { signal, executed: false, reason: `Position sizer returned qty=${size.quantity}` };
    }

    // 2. Risk check
    const risk = await deps.checkRiskLimits({ symbol, strategy, trader, action: 'OPEN' });
    if (!risk.allowed) {
      return { signal, executed: false, reason: `Risk blocked: ${risk.reason}` };
    }

    // 3. Build order
    const orderLegs = legsToOrderLegs(signal.legs, size.quantity);
    const mid = await getSpreadMidpoint(deps.broker, orderLegs);
    const limitPrice = signal.limitPrice != null ? Math.min(Math.abs(signal.limitPrice), mid) : mid;
    const params = buildOrderParams(strategy, direction, symbol, orderLegs, limitPrice, false);

    // 4. Place and record
    let tradeId: string | undefined;
    const result = await placeOrder(deps, params, {
      symbol,
      direction,
      strategy,
      quantity: size.quantity,
      legs: orderLegs,
      messageId: messageId,
      recordFill: async (fp, fa) => {
        const recorded = await deps.recordTrade({
          action: 'OPEN',
          symbol,
          trader,
          direction,
          strategy,
          entryPrice: fp,
          quantity: size.quantity,
          legs: orderLegs,
          openedAt: fa?.toISOString(),
          sourceMessageId: messageId,
        });
        if (recorded) tradeId = recorded.tradeId;
        return recorded;
      },
    });

    if (result.status === 'REJECTED') {
      return { signal, executed: false, reason: result.message ?? 'Order rejected' };
    }
    return { signal, executed: result.status === 'FILLED', tradeId, orderId: result.orderId };
  }

  // ── Position-reducing path ─────────────────────────

  // Quantity comes from the legs directly — the orchestrator already computed
  // the correct quantities (full position for CLOSE, partial for TRIM, single
  // leg for LEG_OFF).
  const orderLegs = legsToOrderLegs(signal.legs, 1); // quantity is already in the legs
  const mid = await getSpreadMidpoint(deps.broker, orderLegs);
  // Close direction is reversed from the position direction
  const closeDirection: Direction = direction === 'LONG' ? 'SHORT' : 'LONG';
  const params = buildOrderParams(strategy, closeDirection, symbol, orderLegs, mid, true);

  let tradeId: string | undefined;
  const quantity = orderLegs[0]?.quantity ?? 1;
  const result = await placeOrder(deps, params, {
    symbol,
    direction: closeDirection,
    strategy,
    quantity,
    legs: orderLegs,
    messageId: messageId,
    tradeId: signal.tradeId,
    recordFill: async (fp, fa) => {
      const action = signal.exitPercent != null && signal.exitPercent < 1
        ? 'TRIM' as const
        : 'CLOSE' as const;
      const recorded = await deps.recordTrade({
        action,
        tradeId: signal.tradeId,
        symbol,
        trader,
        direction: closeDirection,
        strategy,
        exitPrice: fp,
        quantity,
        ...(signal.exitPercent != null && signal.exitPercent < 1 && {
          closeQuantity: quantity,
          exitPercent: signal.exitPercent,
        }),
        legs: orderLegs,
        closedAt: fa?.toISOString(),
        closeMessageId: messageId,
      });
      if (recorded) tradeId = recorded.tradeId;
      return recorded;
    },
  });

  if (result.status === 'REJECTED') {
    return { signal, executed: false, reason: result.message ?? 'Order rejected' };
  }
  return { signal, executed: result.status === 'FILLED', tradeId, orderId: result.orderId };
}

// ─── Public API ─────────────────────────────────────

/**
 * Execute an array of ResolvedSignals sequentially.
 * Each signal is independent — a failure on signal N does not prevent signal N+1.
 *
 * Fires `ctx.env.onDecision` per-signal after each resolves (EXECUTE or FAIL).
 * On QuoteResolutionError, records the original failure first, then retries
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
  const results: ResolvedPipelineResult[] = [];

  for (let i = 0; i < resolved.signals.length; i++) {
    const signal = resolved.signals[i];
    const startMs = Date.now();

    try {
      const result = await executeResolvedSignal(signal, trader, deps, message.id);
      results.push(result);

      await env.onDecision({
        messageId: message.id,
        signalIndex: i,
        outcome: result.executed ? 'EXECUTE' : 'FAIL',
        phase: result.executed ? 'order' : 'pipeline',
        reasoning: result.reason ?? null,
        tradeId: result.tradeId ?? null,
        snapshot: { signal },
        durationMs: Date.now() - startMs,
        inputTokens: resolved.usage?.inputTokens ?? null,
        outputTokens: resolved.usage?.outputTokens ?? null,
      });
    } catch (err) {
      if (err instanceof QuoteResolutionError) {
        // Always record the original failure first
        const failResult: ResolvedPipelineResult = {
          signal,
          executed: false,
          reason: `Quote resolution failed: ${err.originalMessage}`,
        };
        results.push(failResult);

        await env.onDecision({
          messageId: message.id,
          signalIndex: i,
          outcome: 'FAIL',
          phase: 'pipeline',
          reasoning: failResult.reason!,
          snapshot: { signal, error: err.originalMessage },
          durationMs: Date.now() - startMs,
        });

        // Attempt retry via LLM re-parse
        log.info(`Quote resolution failed — retrying via LLM: ${err.originalMessage.slice(0, 120)}`);
        const retryResolved = await resolveOrchestrator(message, {
          getPositions: env.getPositions,
          llm: env.llm,
          broker: deps.broker,
          onDecision: env.onDecision,
        }, { failureContext: { error: err.originalMessage } });

        if (retryResolved.outcome !== 'EXECUTE') {
          // Retry didn't produce signals — onDecision already fired from orchestrator for the skip
          continue;
        }

        // Execute retry signals (no further retries)
        for (let ri = 0; ri < retryResolved.signals.length; ri++) {
          const retrySignal = retryResolved.signals[ri];
          const retrySignalStartMs = Date.now();

          // Check if the retry produced the same bad symbol
          if (err.occSymbol) {
            const stillBad = retrySignal.legs
              .filter((l): l is OptionLeg => l.type === 'option')
              .some(l => formatOccSymbol({ underlying: l.symbol, expiration: l.expiry, type: l.optionType, strike: l.strike }) === err.occSymbol);
            if (stillBad) {
              const sameSymbolResult: ResolvedPipelineResult = {
                signal: retrySignal,
                executed: false,
                reason: `Quote resolution retry returned same invalid symbol ${err.occSymbol}`,
              };
              results.push(sameSymbolResult);
              await env.onDecision({
                messageId: message.id,
                signalIndex: resolved.signals.length + ri,
                outcome: 'FAIL',
                phase: 'pipeline',
                reasoning: sameSymbolResult.reason!,
                snapshot: { signal: retrySignal, retryContext: { originalError: err.originalMessage } },
                durationMs: Date.now() - retrySignalStartMs,
              });
              continue;
            }
          }

          try {
            const retryResult = await executeResolvedSignal(retrySignal, trader, deps, message.id);
            results.push(retryResult);
            await env.onDecision({
              messageId: message.id,
              signalIndex: resolved.signals.length + ri,
              outcome: retryResult.executed ? 'EXECUTE' : 'FAIL',
              phase: retryResult.executed ? 'order' : 'pipeline',
              reasoning: retryResult.reason ?? null,
              tradeId: retryResult.tradeId ?? null,
              snapshot: { signal: retrySignal, retryContext: { originalError: err.originalMessage } },
              durationMs: Date.now() - retrySignalStartMs,
              inputTokens: retryResolved.usage?.inputTokens ?? null,
              outputTokens: retryResolved.usage?.outputTokens ?? null,
            });
          } catch (retryErr) {
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            const retryFailResult: ResolvedPipelineResult = {
              signal: retrySignal,
              executed: false,
              reason: `Quote resolution retry failed: ${msg}`,
            };
            results.push(retryFailResult);
            await env.onDecision({
              messageId: message.id,
              signalIndex: resolved.signals.length + ri,
              outcome: 'FAIL',
              phase: 'pipeline',
              reasoning: retryFailResult.reason!,
              snapshot: { signal: retrySignal, retryContext: { originalError: err.originalMessage }, error: msg },
              durationMs: Date.now() - retrySignalStartMs,
            });
          }
        }
      } else {
        throw err;
      }
    }
  }
  return results;
}
