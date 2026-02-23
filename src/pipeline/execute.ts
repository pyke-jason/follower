/**
 * Deterministic execution pipeline.
 *
 * Takes validated signals from the classification agent and executes them
 * through a fixed sequence: size → risk check → place order → record trade.
 * The LLM has no control over this flow.
 */
import type { BrokerService } from '../broker/interface.js';
import type { OrderParams, OrderResult, WorkingOrderParams, AdjustmentRule, OrderLeg, Quote } from '../broker/types.js';
import type { OrderManager } from '../orders/order-manager.js';
import type { Trade } from '../db/schema.js';
import type { PositionSize } from '../position-sizing/index.js';
import type { RiskCheckResult } from '../orders/risk-check.js';
import type { RecordTradeInput, RecordTradeResult } from '../trades/record-trade.js';
import type { PositionFilters } from '../trades/filters.js';
export type { RecordTradeResult };
export type { OrderLeg };
import type { Signal } from '../agent/schemas.js';
import { OrderResultSchema } from '../broker/order-schemas.js';
import { createLogger } from '../lib/logger.js';
import { DrizzleQueryError } from 'drizzle-orm';
import { tradeQty } from '../lib/trade.js';
import { formatOccSymbol, normalizeExpiry, inferATMSpread, inferATMStrike } from '../backtest/occ-symbology.js';
import { nextFriday } from '../lib/et-date.js';
import { getSpreadMidpoint } from './spread-midpoint.js';

const log = createLogger('Pipeline');

// ─── Types ──────────────────────────────────────────

export type PendingOrderContext = {
  action: 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF';
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  quantity: number;
  legs: OrderLeg[];
  messageId?: string;
  /** Record the trade when the working order fills. Captures all pipeline metadata
   *  (backtestRunId, agentModel, etc.) so callers don't reconstruct recording payloads. */
  recordFill: (filledPrice: number, filledAt?: Date) => Promise<RecordTradeResult | null>;
};

export type PipelineDeps = {
  broker: BrokerService;
  orderManager?: OrderManager;
  getOpenPositions: (filters: PositionFilters) => Promise<Trade[]>;
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
  /** Called when an order is placed but not immediately filled (working order). */
  onPending?: (orderId: string, context: PendingOrderContext) => void;
};

export type PipelineOpts = {
  messageId?: string;
  messageTimestamp?: string; // ISO 8601 — used as reference for expiry year inference
  taskId?: string;
  backtestRunId?: string;
  isBacktest?: boolean;
  /** Trader's allowed strategies. Signals with strategies outside this list are skipped (OPEN/ADD only). */
  allowedStrategies?: string[];
};

export type PipelineResult = {
  signal: Signal;
  executed: boolean;
  reason?: string;
  tradeId?: string;
  orderId?: string;
};

// ─── Per-strategy order defaults ────────────────────

const ORDER_DEFAULTS: Record<string, { stepAmount: number; intervalSec: number; cancelAfterSec: number }> = {
  STOCK: { stepAmount: 0.03, intervalSec: 5, cancelAfterSec: 60 },
  CALL:  { stepAmount: 0.10, intervalSec: 5, cancelAfterSec: 60 },
  PUT:   { stepAmount: 0.10, intervalSec: 5, cancelAfterSec: 60 },
  CDS:   { stepAmount: 0.05, intervalSec: 5, cancelAfterSec: 60 },
  PDS:   { stepAmount: 0.05, intervalSec: 5, cancelAfterSec: 60 },
};

// ─── Public helper ─────────────────────────────────

/**
 * Pure function: convert a Signal + quantity into OrderParams.
 * Used by RuleBasedTradeAgent and internal pipeline executors.
 */
export function buildOrderFromSignal(signal: Signal, quantity: number, referenceDate: Date = new Date()): OrderParams {
  // CLOSE/TRIM don't carry legs on the signal — the pipeline rebuilds
  // them from the existing position.  Pass an empty legs array; the
  // pipeline's executeClose / executeTrim will replace it.
  const needsLegs = signal.action === 'OPEN' || signal.action === 'ADD';
  const isStock = signal.strategy === 'STOCK';
  const legs: OrderLeg[] = !needsLegs
    ? []
    : isStock
      ? buildStockLegs(signal.symbol, signal.direction, quantity)
      : buildOptionLegs(signal, quantity, referenceDate);
  return {
    symbol: signal.symbol,
    strategy: signal.strategy,
    direction: signal.direction,
    legs,
    orderType: 'MARKET',
    limitPrice: undefined,
  };
}

// ─── Helpers ────────────────────────────────────────

function buildStockLegs(underlying: string, direction: 'LONG' | 'SHORT', quantity: number): OrderLeg[] {
  return [{
    symbol: underlying,
    strike: 0,
    expiry: '',
    type: 'STOCK' as const,
    action: direction === 'LONG' ? 'BUY' as const : 'SELL' as const,
    quantity,
  }];
}

function buildOptionLegs(signal: Signal, quantity: number, referenceDate: Date): OrderLeg[] {
  if (!signal.legs || signal.legs.length === 0) {
    throw new Error(`Options signal for ${signal.symbol} (${signal.action} ${signal.strategy}) missing legs`);
  }

  // Deduplicate legs by identity (LLM v4 sometimes emits duplicates)
  const seen = new Set<string>();
  const uniqueSignalLegs = signal.legs.filter(l => {
    const key = `${l.strike}|${l.expiry}|${l.optionType}|${l.action}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueSignalLegs.length < signal.legs.length) {
    log.info(`${signal.symbol} ${signal.action}: deduped ${signal.legs.length} legs → ${uniqueSignalLegs.length}`);
  }

  return uniqueSignalLegs.map(l => {
    const expiry = normalizeExpiry(l.expiry, referenceDate);
    return {
      symbol: formatOccSymbol({
        underlying: signal.symbol,
        expiration: expiry,
        type: l.optionType,
        strike: l.strike,
      }),
      strike: l.strike,
      expiry,
      type: l.optionType as 'CALL' | 'PUT',
      action: l.action as 'BUY' | 'SELL',
      quantity,
    };
  });
}

/**
 * Resolve signal legs: if the LLM omitted legs (trader didn't state strikes),
 * infer them deterministically from the stock price.
 */
async function resolveSignalLegs(
  signal: Signal,
  broker: BrokerService,
  opts: PipelineOpts,
): Promise<{ signal: Signal; stockQuote: Quote | null }> {
  if (signal.strategy === 'STOCK') return { signal, stockQuote: null };
  if (signal.legs && signal.legs.length > 0) return { signal, stockQuote: null };

  const quote = await broker.getQuote(signal.symbol);
  const stockPrice = (quote.bid + quote.ask) / 2;
  const refDate = opts.messageTimestamp ? new Date(opts.messageTimestamp) : new Date();
  const expiry = nextFriday(refDate);

  if (signal.strategy === 'CDS' || signal.strategy === 'PDS') {
    const spread = inferATMSpread(stockPrice, signal.strategy);
    const optionType = signal.strategy === 'CDS' ? 'CALL' as const : 'PUT' as const;
    return {
      signal: {
        ...signal,
        legs: [
          { strike: spread.longStrike, expiry, optionType, action: 'BUY' as const },
          { strike: spread.shortStrike, expiry, optionType, action: 'SELL' as const },
        ],
      },
      stockQuote: quote,
    };
  }

  // Naked CALL or PUT
  const strike = inferATMStrike(stockPrice);
  const action = signal.direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
  return {
    signal: {
      ...signal,
      legs: [{ strike, expiry, optionType: signal.strategy as 'CALL' | 'PUT', action }],
    },
    stockQuote: quote,
  };
}

/** Fetch stock mid-price for position sizing entry price. */
async function getEntryPriceEstimate(symbol: string, broker: BrokerService, prefetchedPrice?: number): Promise<number> {
  if (prefetchedPrice != null) return prefetchedPrice;
  try {
    const quote = await broker.getQuote(symbol);
    return (quote.bid + quote.ask) / 2;
  } catch {
    return 0; // ATR sizer handles this via bar data
  }
}

/** Find an open position, with fuzzy fallback for CLOSE/TRIM/LEG_OFF when strategy doesn't match. */
async function findPosition(
  signal: Signal,
  trader: string,
  deps: PipelineDeps,
): Promise<{ position: Trade | undefined; fuzzyMatch: boolean }> {
  const positions = await deps.getOpenPositions({ symbol: signal.symbol, trader, strategy: signal.strategy });
  if (positions[0]) return { position: positions[0], fuzzyMatch: false };

  // Fuzzy fallback: drop strategy filter for mutation actions
  if (signal.action === 'CLOSE' || signal.action === 'TRIM' || signal.action === 'LEG_OFF') {
    const bySymbol = await deps.getOpenPositions({ symbol: signal.symbol, trader });
    if (bySymbol.length === 1) {
      log.warn(`${signal.action} ${signal.symbol}: fuzzy match — signal strategy ${signal.strategy} ≠ position strategy ${bySymbol[0].strategy}`);
      return { position: bySymbol[0], fuzzyMatch: true };
    }
  }

  return { position: undefined, fuzzyMatch: false };
}

/** Build order params with strategy-appropriate defaults. */
function buildOrderParams(
  signal: Signal,
  legs: OrderLeg[],
  limitPrice?: number,
): WorkingOrderParams {
  const defaults = ORDER_DEFAULTS[signal.strategy] ?? ORDER_DEFAULTS.STOCK;
  const adjustmentRules: AdjustmentRule[] = limitPrice
    ? [{ type: 'PRICE_CHASE', stepAmount: defaults.stepAmount, intervalSec: defaults.intervalSec }]
    : [];

  return {
    symbol: signal.symbol,
    strategy: signal.strategy,
    direction: signal.direction,
    legs,
    orderType: limitPrice ? 'LIMIT' : 'MARKET',
    limitPrice,
    adjustmentRules: adjustmentRules.length > 0 ? adjustmentRules : undefined,
    cancelAfterSec: limitPrice ? defaults.cancelAfterSec : undefined,
  };
}

/** Place order through broker or order manager and handle fill/pending.
 *  Single code path: both immediate and deferred fills use pendingContext.recordFill. */
async function placeOrder(
  deps: PipelineDeps,
  params: WorkingOrderParams,
  pendingContext: PendingOrderContext,
): Promise<OrderResult> {
  let raw: OrderResult;
  if (deps.orderManager) {
    raw = await deps.orderManager.submitOrder(params);
  } else {
    const { adjustmentRules, cancelAfterSec, ...orderParams } = params;
    raw = await deps.broker.placeOrder(orderParams);
  }
  // Validate at boundary — Zod refines guarantee filledPrice + fillTimestamp for FILLED
  const result = OrderResultSchema.parse(raw);

  if (result.status === 'FILLED') {
    await pendingContext.recordFill(
      result.filledPrice!,
      new Date(result.fillTimestamp!),
    );
  } else if (result.status === 'OPEN' && result.orderId && deps.onPending) {
    deps.onPending(result.orderId, pendingContext);
  }

  return result;
}

// ─── Signal executors ───────────────────────────────

async function executeOpen(
  signal: Signal,
  trader: string,
  deps: PipelineDeps,
  opts: PipelineOpts,
): Promise<PipelineResult> {
  // 0. Resolve legs if missing (trader omitted strikes)
  const { signal: resolved, stockQuote } = await resolveSignalLegs(signal, deps.broker, opts);

  // 1. Size — use broker quote for entry price, not LLM (reuse quote from resolveSignalLegs if available)
  const prefetchedMid = stockQuote ? (stockQuote.bid + stockQuote.ask) / 2 : undefined;
  const entryPrice = await getEntryPriceEstimate(resolved.symbol, deps.broker, prefetchedMid);
  const size = await deps.calculatePositionSize({
    trader,
    symbol: resolved.symbol,
    entryPrice,
    strategy: resolved.strategy,
  });
  if (size.quantity <= 0) {
    return { signal, executed: false, reason: `Position sizer returned qty=${size.quantity}` };
  }

  // 2. Risk check
  const risk = await deps.checkRiskLimits({
    symbol: resolved.symbol,
    strategy: resolved.strategy,
    trader,
    action: 'OPEN',
  });
  if (!risk.allowed) {
    return { signal, executed: false, reason: `Risk blocked: ${risk.reason}` };
  }

  // 3. Build order
  const refDate = opts.messageTimestamp ? new Date(opts.messageTimestamp) : new Date();
  const legs = resolved.strategy === 'STOCK'
    ? buildStockLegs(resolved.symbol, resolved.direction, size.quantity)
    : buildOptionLegs(resolved, size.quantity, refDate);
  const mid = await getSpreadMidpoint(deps.broker, legs);
  const params = buildOrderParams(resolved, legs, mid);

  // 4. Place and record
  const buildRecordInput = (filledPrice: number, filledAt?: Date): RecordTradeInput => ({
    action: 'OPEN',
    symbol: signal.symbol,
    trader,
    direction: signal.direction,
    strategy: signal.strategy,
    entryPrice: filledPrice,
    quantity: size.quantity,
    legs,
    openedAt: filledAt?.toISOString(),
    sourceMessageId: opts.messageId,
    taskId: opts.taskId,
    backtestRunId: opts.backtestRunId,
    isBacktest: opts.isBacktest ?? false,
  });

  let tradeId: string | undefined;
  const result = await placeOrder(deps, params, {
    action: 'OPEN', symbol: signal.symbol, direction: signal.direction,
    strategy: signal.strategy, quantity: size.quantity, legs, messageId: opts.messageId,
    recordFill: async (fp, fa) => {
      const recorded = await deps.recordTrade(buildRecordInput(fp, fa));
      if (recorded) tradeId = recorded.tradeId;
      return recorded;
    },
  });

  if (result.status === 'REJECTED') {
    return { signal, executed: false, reason: result.message ?? 'Order rejected' };
  }
  return { signal, executed: result.status === 'FILLED', tradeId, orderId: result.orderId };
}

async function executeClose(
  signal: Signal,
  trader: string,
  deps: PipelineDeps,
  opts: PipelineOpts,
): Promise<PipelineResult> {
  // 1. Find existing position (with fuzzy fallback if strategy doesn't match)
  const { position: existing } = await findPosition(signal, trader, deps);
  if (!existing) {
    return { signal, executed: false, reason: `No open position for ${signal.symbol}/${trader} (${signal.strategy})` };
  }

  // 2. Use current remaining quantity (accounts for prior TRIMs)
  const quantity = tradeQty(existing.quantity);

  // 3. Build order — reverse direction from existing position
  const existingLegs = Array.isArray(existing.legs) ? existing.legs as OrderLeg[] : [];
  const legs = existing.strategy === 'STOCK'
    ? buildStockLegs(existing.symbol, existing.direction, quantity)
    : existingLegs.map(l => ({ ...l, quantity, action: l.action === 'BUY' ? 'SELL' as const : 'BUY' as const }));

  // Reverse direction for close order
  const closeDirection: 'LONG' | 'SHORT' = existing.direction === 'LONG' ? 'SHORT' : 'LONG';
  const mid = await getSpreadMidpoint(deps.broker, legs);
  const params = buildOrderParams(
    { ...signal, direction: closeDirection, strategy: existing.strategy },
    legs,
    mid,
  );
  params.isClosing = true;

  // 4. Place and record
  const buildRecordInput = (filledPrice: number, filledAt?: Date): RecordTradeInput => ({
    action: 'CLOSE',
    tradeId: existing.id,
    symbol: signal.symbol,
    trader,
    direction: existing.direction,
    strategy: existing.strategy,
    exitPrice: filledPrice,
    quantity,
    legs: existingLegs,
    closedAt: filledAt?.toISOString(),
    sourceMessageId: existing.sourceMessageId ?? undefined,
    closeMessageId: opts.messageId,
    taskId: opts.taskId,
    backtestRunId: opts.backtestRunId,
    isBacktest: opts.isBacktest ?? false,
  });

  let tradeId: string | undefined;
  const result = await placeOrder(deps, params, {
    action: 'CLOSE', symbol: signal.symbol, direction: existing.direction,
    strategy: existing.strategy, quantity, legs, messageId: opts.messageId,
    recordFill: async (fp, fa) => {
      const recorded = await deps.recordTrade(buildRecordInput(fp, fa));
      if (recorded) tradeId = recorded.tradeId;
      return recorded;
    },
  });

  if (result.status === 'REJECTED') {
    return { signal, executed: false, reason: result.message ?? 'Order rejected' };
  }
  return { signal, executed: result.status === 'FILLED', tradeId, orderId: result.orderId };
}

async function executeAdd(
  signal: Signal,
  trader: string,
  deps: PipelineDeps,
  opts: PipelineOpts,
): Promise<PipelineResult> {
  // 0. Resolve legs if missing
  const { signal: resolved, stockQuote } = await resolveSignalLegs(signal, deps.broker, opts);

  // 1. Verify position exists; if not, fall through to OPEN
  const positions = await deps.getOpenPositions({ symbol: resolved.symbol, trader, strategy: resolved.strategy });
  if (positions.length === 0) {
    log.debug(`ADD: no existing position for ${resolved.symbol}/${trader}, falling through to OPEN`);
    return executeOpen(resolved, trader, deps, opts);
  }

  // 2. Size the add — use broker quote for entry price (reuse quote from resolveSignalLegs if available)
  const prefetchedMid = stockQuote ? (stockQuote.bid + stockQuote.ask) / 2 : undefined;
  const entryPrice = await getEntryPriceEstimate(resolved.symbol, deps.broker, prefetchedMid);
  const size = await deps.calculatePositionSize({
    trader,
    symbol: resolved.symbol,
    entryPrice,
    strategy: resolved.strategy,
  });
  if (size.quantity <= 0) {
    return { signal, executed: false, reason: `Position sizer returned qty=${size.quantity}` };
  }

  // 3. Risk check — ADD increases exposure, so use OPEN-level checks
  const risk = await deps.checkRiskLimits({
    symbol: resolved.symbol,
    strategy: resolved.strategy,
    trader,
    action: 'OPEN',
  });
  if (!risk.allowed) {
    return { signal, executed: false, reason: `Risk blocked: ${risk.reason}` };
  }

  // 4. Build order
  const refDate = opts.messageTimestamp ? new Date(opts.messageTimestamp) : new Date();
  const legs = resolved.strategy === 'STOCK'
    ? buildStockLegs(resolved.symbol, resolved.direction, size.quantity)
    : buildOptionLegs(resolved, size.quantity, refDate);
  const mid = await getSpreadMidpoint(deps.broker, legs);
  const params = buildOrderParams(resolved, legs, mid);

  // 5. Place and record
  const existing = positions[0];
  const buildRecordInput = (filledPrice: number, filledAt?: Date): RecordTradeInput => ({
    action: 'ADD',
    tradeId: existing.id,
    symbol: signal.symbol,
    trader,
    direction: signal.direction,
    strategy: signal.strategy,
    entryPrice: filledPrice,
    quantity: size.quantity,
    legs,
    openedAt: filledAt?.toISOString(),
    sourceMessageId: opts.messageId,
    taskId: opts.taskId,
    backtestRunId: opts.backtestRunId,
    isBacktest: opts.isBacktest ?? false,
  });

  let tradeId: string | undefined;
  const result = await placeOrder(deps, params, {
    action: 'ADD', symbol: signal.symbol, direction: signal.direction,
    strategy: signal.strategy, quantity: size.quantity, legs, messageId: opts.messageId,
    recordFill: async (fp, fa) => {
      const recorded = await deps.recordTrade(buildRecordInput(fp, fa));
      if (recorded) tradeId = recorded.tradeId;
      return recorded;
    },
  });

  if (result.status === 'REJECTED') {
    return { signal, executed: false, reason: result.message ?? 'Order rejected' };
  }
  return { signal, executed: result.status === 'FILLED', tradeId, orderId: result.orderId };
}

async function executeTrim(
  signal: Signal,
  trader: string,
  deps: PipelineDeps,
  opts: PipelineOpts,
): Promise<PipelineResult> {
  // 1. Find existing position (with fuzzy fallback if strategy doesn't match)
  const { position: existing } = await findPosition(signal, trader, deps);
  if (!existing) {
    return { signal, executed: false, reason: `No open position for ${signal.symbol}/${trader} (${signal.strategy})` };
  }

  // 2. Compute trim quantity from current remaining qty
  const currentQty = tradeQty(existing.quantity);
  const exitPct = signal.exitPercent ?? 0.5;
  const trimQty = Math.max(1, Math.min(currentQty, Math.floor(currentQty * exitPct)));

  // 3. Build order — reverse direction for the trim
  const existingLegs = Array.isArray(existing.legs) ? existing.legs as OrderLeg[] : [];
  const legs = existing.strategy === 'STOCK'
    ? buildStockLegs(existing.symbol, existing.direction, trimQty)
    : existingLegs.map(l => ({ ...l, quantity: trimQty, action: l.action === 'BUY' ? 'SELL' as const : 'BUY' as const }));

  const closeDirection: 'LONG' | 'SHORT' = existing.direction === 'LONG' ? 'SHORT' : 'LONG';
  const mid = await getSpreadMidpoint(deps.broker, legs);
  const params = buildOrderParams(
    { ...signal, direction: closeDirection, strategy: existing.strategy },
    legs,
    mid,
  );
  params.isClosing = true;

  // 5. Place and record
  const buildRecordInput = (filledPrice: number, filledAt?: Date): RecordTradeInput => ({
    action: 'TRIM',
    tradeId: existing.id,
    symbol: signal.symbol,
    trader,
    direction: existing.direction,
    strategy: existing.strategy,
    exitPrice: filledPrice,
    closeQuantity: trimQty,
    exitPercent: exitPct,
    legs: existingLegs,
    closedAt: filledAt?.toISOString(),
    sourceMessageId: existing.sourceMessageId ?? undefined,
    closeMessageId: opts.messageId,
    taskId: opts.taskId,
    backtestRunId: opts.backtestRunId,
    isBacktest: opts.isBacktest ?? false,
  });

  let tradeId: string | undefined;
  const result = await placeOrder(deps, params, {
    action: 'TRIM', symbol: signal.symbol, direction: existing.direction,
    strategy: existing.strategy, quantity: trimQty, legs, messageId: opts.messageId,
    recordFill: async (fp, fa) => {
      const recorded = await deps.recordTrade(buildRecordInput(fp, fa));
      if (recorded) tradeId = recorded.tradeId;
      return recorded;
    },
  });

  if (result.status === 'REJECTED') {
    return { signal, executed: false, reason: result.message ?? 'Order rejected' };
  }
  return { signal, executed: result.status === 'FILLED', tradeId, orderId: result.orderId };
}

async function executeLegOff(
  signal: Signal,
  trader: string,
  deps: PipelineDeps,
  opts: PipelineOpts,
): Promise<PipelineResult> {
  // 1. Find existing position (with fuzzy fallback if strategy doesn't match)
  const { position: existing } = await findPosition(signal, trader, deps);
  if (!existing) {
    return { signal, executed: false, reason: `No open position for ${signal.symbol}/${trader} (${signal.strategy})` };
  }

  // 2. Identify the leg to close (the SELL leg in CDS→CALL or PDS→PUT)
  const existingLegs = Array.isArray(existing.legs) ? existing.legs as OrderLeg[] : [];
  const targetStrategy = signal.targetStrategy!;

  const legToClose = existingLegs.find(l => l.action === 'SELL');
  if (!legToClose) {
    return { signal, executed: false, reason: `No SELL leg found to close on ${existing.strategy}` };
  }
  const legToKeep = existingLegs.find(l => l.action === 'BUY');

  // 3. Build order — buy back the sold leg (reverse it)
  const quantity = tradeQty(existing.quantity);
  const closingLegs: OrderLeg[] = [{
    ...legToClose,
    quantity,
    action: 'BUY' as const,
  }];

  const mid = await getSpreadMidpoint(deps.broker, closingLegs);
  const params = buildOrderParams(
    { ...signal, direction: 'LONG' as const, strategy: existing.strategy },
    closingLegs,
    mid,
  );
  params.isClosing = true;

  // 4. Place order and record
  const buildRecordInput = (filledPrice: number, filledAt?: Date): RecordTradeInput => ({
    action: 'LEG_OFF',
    tradeId: existing.id,
    symbol: signal.symbol,
    trader,
    direction: existing.direction,
    strategy: existing.strategy,
    exitPrice: filledPrice,
    quantity,
    legs: existingLegs,
    closedAt: filledAt?.toISOString(),
    sourceMessageId: existing.sourceMessageId ?? undefined,
    closeMessageId: opts.messageId,
    taskId: opts.taskId,
    backtestRunId: opts.backtestRunId,
    isBacktest: opts.isBacktest ?? false,
    metadata: {
      targetStrategy,
      closedLeg: legToClose,
      keptLeg: legToKeep,
    },
  });

  let tradeId: string | undefined;
  const result = await placeOrder(deps, params, {
    action: 'LEG_OFF', symbol: signal.symbol, direction: existing.direction,
    strategy: existing.strategy, quantity, legs: closingLegs, messageId: opts.messageId,
    recordFill: async (fp, fa) => {
      const recorded = await deps.recordTrade(buildRecordInput(fp, fa));
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

/** Execute a single signal through the deterministic pipeline. */
export async function executeSignal(
  signal: Signal,
  trader: string,
  deps: PipelineDeps,
  opts: PipelineOpts,
): Promise<PipelineResult> {
  switch (signal.action) {
    case 'OPEN': {
      const existing = await deps.getOpenPositions({ symbol: signal.symbol, trader, strategy: signal.strategy });
      if (existing.length > 0) return executeAdd(signal, trader, deps, opts);
      return executeOpen(signal, trader, deps, opts);
    }
    case 'CLOSE':   return executeClose(signal, trader, deps, opts);
    case 'ADD':     return executeAdd(signal, trader, deps, opts);
    case 'TRIM':    return executeTrim(signal, trader, deps, opts);
    case 'LEG_OFF': return executeLegOff(signal, trader, deps, opts);
    default:
      return { signal, executed: false, reason: `Unknown action: ${(signal as any).action}` };
  }
}

/**
 * Deduplicate signals by symbol|action|strategy.
 * When the LLM emits two signals for the same trade (e.g. "Short ABNB using $127 Puts"
 * → one STOCK signal + one PUT signal), keep the best one:
 *   1. Prefer the signal with statedPremium (more complete).
 *   2. Tiebreak: fewer legs (simpler = less likely to be the duplicate).
 *   3. Final tiebreak: later position in the array (LLMs tend to self-correct).
 */
function deduplicateSignals(signals: Signal[]): Signal[] {
  const groups = new Map<string, Signal[]>();
  for (const signal of signals) {
    const key = `${signal.symbol}|${signal.action}|${signal.strategy}`;
    const group = groups.get(key);
    if (group) group.push(signal);
    else groups.set(key, [signal]);
  }

  const deduped: Signal[] = [];
  for (const [key, group] of groups) {
    if (group.length > 1) {
      log.info(`Deduped ${group.length} signals for ${key} → keeping best`);
      group.sort((a, b) => {
        // Prefer signal with statedPremium
        const aPrem = a.statedPremium != null ? 1 : 0;
        const bPrem = b.statedPremium != null ? 1 : 0;
        if (aPrem !== bPrem) return bPrem - aPrem;
        // Tiebreak: fewer legs
        const aLegs = a.legs?.length ?? 0;
        const bLegs = b.legs?.length ?? 0;
        return aLegs - bLegs;
      });
    }
    deduped.push(group[0]);
  }
  return deduped;
}

/**
 * Execute an array of signals sequentially.
 * Each signal is independent — a failure on signal N does not prevent signal N+1.
 */
export async function executeSignals(
  signals: Signal[],
  trader: string,
  deps: PipelineDeps,
  opts: PipelineOpts,
): Promise<PipelineResult[]> {
  const deduped = deduplicateSignals(signals);
  const results: PipelineResult[] = [];
  for (const signal of deduped) {
    try {
      const result = await executeSignal(signal, trader, deps, opts);
      results.push(result);
    } catch (err) {
      // Infrastructure errors (DB down, missing table) are not recoverable
      // per-signal — re-throw so the caller (runner) sees the real problem
      // instead of silently producing zero trades.
      if (err instanceof DrizzleQueryError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`Signal ${signal.action} ${signal.symbol} failed: ${reason.slice(0, 200)}`);
      results.push({ signal, executed: false, reason });
    }
  }
  return results;
}
