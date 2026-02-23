/**
 * Deterministic execution pipeline.
 *
 * Takes validated signals from the classification agent and executes them
 * through a fixed sequence: size → risk check → place order → record trade.
 * The LLM has no control over this flow.
 */
import type { BrokerService } from '../broker/interface.js';
import type { OrderParams, OrderResult, WorkingOrderParams, AdjustmentRule, OrderLeg } from '../broker/types.js';
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
import { parseTradeFromDb } from '../db/parse.js';
import { createLogger } from '../lib/logger.js';
import { DrizzleQueryError } from 'drizzle-orm';
import { tradeQty } from '../lib/trade.js';
import { formatOccSymbol, normalizeExpiry } from '../backtest/occ-symbology.js';
import { shouldSkipSignal } from '../agent/deterministic-skips.js';

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
    orderType: signal.limitPrice ? 'LIMIT' : 'MARKET',
    limitPrice: signal.limitPrice,
  };
}

// ─── Helpers ────────────────────────────────────────

function buildStockLegs(underlying: string, direction: 'LONG' | 'SHORT', quantity: number): OrderLeg[] {
  return [{
    symbol: underlying,
    strike: 0,
    expiry: '',
    type: 'STOCK',
    action: direction === 'LONG' ? 'BUY' : 'SELL',
    quantity,
  }];
}

function buildOptionLegs(signal: Signal, quantity: number, referenceDate: Date): OrderLeg[] {
  if (!signal.legs || signal.legs.length === 0) {
    throw new Error(`Options signal for ${signal.symbol} (${signal.action} ${signal.strategy}) missing legs`);
  }
  return signal.legs.map(l => {
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
    if (result.filledPrice == null || result.fillTimestamp == null) {
      throw new Error('OrderResultSchema.parse passed but FILLED result is missing price/timestamp');
    }
    await pendingContext.recordFill(result.filledPrice, new Date(result.fillTimestamp));
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
  // 1. Size
  const size = await deps.calculatePositionSize({
    trader,
    symbol: signal.symbol,
    entryPrice: signal.limitPrice ?? 0,
    strategy: signal.strategy,
  });
  if (size.quantity <= 0) {
    return { signal, executed: false, reason: `Position sizer returned qty=${size.quantity}` };
  }

  // 2. Risk check
  const risk = await deps.checkRiskLimits({
    symbol: signal.symbol,
    strategy: signal.strategy,
    trader,
    action: 'OPEN',
  });
  if (!risk.allowed) {
    return { signal, executed: false, reason: `Risk blocked: ${risk.reason}` };
  }

  // 3. Build order
  const refDate = opts.messageTimestamp ? new Date(opts.messageTimestamp) : new Date();
  const legs = signal.strategy === 'STOCK'
    ? buildStockLegs(signal.symbol, signal.direction, size.quantity)
    : buildOptionLegs(signal, size.quantity, refDate);
  const params = buildOrderParams(signal, legs, signal.limitPrice);

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

  log.debug(`OPEN ${signal.direction} ${signal.strategy} ${signal.symbol} qty=${size.quantity} → ${result.status}`);
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
  // 1. Find existing position (strategy filter prevents matching e.g. STOCK when signal says PDS)
  const positions = await deps.getOpenPositions({ symbol: signal.symbol, trader, strategy: signal.strategy });
  const existingRaw = positions[0];
  if (!existingRaw) {
    return { signal, executed: false, reason: `No open position for ${signal.symbol}/${trader} (${signal.strategy})` };
  }
  const existing = parseTradeFromDb(existingRaw);

  // 2. Use current remaining quantity (accounts for prior TRIMs)
  const quantity = tradeQty(existing.quantity);

  // 3. Risk check (always passes for CLOSE)
  await deps.checkRiskLimits({
    symbol: signal.symbol,
    strategy: existing.strategy,
    trader,
    action: 'CLOSE',
  });

  // 4. Build order — reverse direction from existing position
  const existingLegs = existing.legs;
  const legs = existing.strategy === 'STOCK'
    ? buildStockLegs(existing.symbol, existing.direction, quantity)
    : existingLegs.map(l => ({ ...l, quantity, action: l.action === 'BUY' ? 'SELL' as const : 'BUY' as const }));

  // Reverse direction for close order
  const closeDirection: 'LONG' | 'SHORT' = existing.direction === 'LONG' ? 'SHORT' : 'LONG';
  const params = buildOrderParams(
    { ...signal, direction: closeDirection, strategy: existing.strategy },
    legs,
    signal.limitPrice,
  );
  params.isClosing = true;

  // 5. Place and record
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

  log.debug(`CLOSE ${existing.direction} ${existing.strategy} ${signal.symbol} qty=${quantity} → ${result.status}`);
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
  // 1. Verify position exists; if not, fall through to OPEN
  const positions = await deps.getOpenPositions({ symbol: signal.symbol, trader, strategy: signal.strategy });
  if (positions.length === 0) {
    log.debug(`ADD: no existing position for ${signal.symbol}/${trader}, falling through to OPEN`);
    return executeOpen(signal, trader, deps, opts);
  }

  // 2. Size the add
  const size = await deps.calculatePositionSize({
    trader,
    symbol: signal.symbol,
    entryPrice: signal.limitPrice ?? 0,
    strategy: signal.strategy,
  });
  if (size.quantity <= 0) {
    return { signal, executed: false, reason: `Position sizer returned qty=${size.quantity}` };
  }

  // 3. Risk check — ADD increases exposure, so use OPEN-level checks
  const risk = await deps.checkRiskLimits({
    symbol: signal.symbol,
    strategy: signal.strategy,
    trader,
    action: 'OPEN',
  });
  if (!risk.allowed) {
    return { signal, executed: false, reason: `Risk blocked: ${risk.reason}` };
  }

  // 4. Build order
  const refDate = opts.messageTimestamp ? new Date(opts.messageTimestamp) : new Date();
  const legs = signal.strategy === 'STOCK'
    ? buildStockLegs(signal.symbol, signal.direction, size.quantity)
    : buildOptionLegs(signal, size.quantity, refDate);
  const params = buildOrderParams(signal, legs, signal.limitPrice);

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

  log.debug(`ADD ${signal.direction} ${signal.strategy} ${signal.symbol} qty=${size.quantity} → ${result.status}`);
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
  // 1. Find existing position
  const positions = await deps.getOpenPositions({ symbol: signal.symbol, trader, strategy: signal.strategy });
  const existingRaw = positions[0];
  if (!existingRaw) {
    return { signal, executed: false, reason: `No open position for ${signal.symbol}/${trader} (${signal.strategy})` };
  }
  const existing = parseTradeFromDb(existingRaw);

  // 2. Compute trim quantity from current remaining qty
  const currentQty = tradeQty(existing.quantity);
  const exitPct = signal.exitPercent ?? 0.5;
  const trimQty = Math.max(1, Math.min(currentQty, Math.floor(currentQty * exitPct)));

  // 3. Risk check (always passes for TRIM)
  await deps.checkRiskLimits({
    symbol: signal.symbol,
    strategy: existing.strategy,
    trader,
    action: 'TRIM',
  });

  // 4. Build order — reverse direction for the trim
  const existingLegs = existing.legs;
  const legs = existing.strategy === 'STOCK'
    ? buildStockLegs(existing.symbol, existing.direction, trimQty)
    : existingLegs.map(l => ({ ...l, quantity: trimQty, action: l.action === 'BUY' ? 'SELL' as const : 'BUY' as const }));

  const closeDirection: 'LONG' | 'SHORT' = existing.direction === 'LONG' ? 'SHORT' : 'LONG';
  const params = buildOrderParams(
    { ...signal, direction: closeDirection, strategy: existing.strategy },
    legs,
    signal.limitPrice,
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

  log.debug(`TRIM ${existing.direction} ${existing.strategy} ${signal.symbol} qty=${trimQty}/${currentQty} → ${result.status}`);
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
  // 1. Find existing position (use signal.strategy — the pre-mutation strategy)
  const positions = await deps.getOpenPositions({ symbol: signal.symbol, trader, strategy: signal.strategy });
  const existingRaw = positions[0];
  if (!existingRaw) {
    return { signal, executed: false, reason: `No open position for ${signal.symbol}/${trader} (${signal.strategy})` };
  }
  const existing = parseTradeFromDb(existingRaw);

  // 2. Identify the leg to close (the SELL leg in CDS→CALL or PDS→PUT)
  const existingLegs = existing.legs;
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
    action: 'BUY',
  }];

  const params = buildOrderParams(
    { ...signal, direction: 'LONG', strategy: existing.strategy },
    closingLegs,
    signal.limitPrice,
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

  log.debug(`LEG_OFF ${existing.strategy}→${targetStrategy} ${signal.symbol} qty=${quantity} → ${result.status}`);
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
  const strategySkip = shouldSkipSignal(signal, opts.allowedStrategies);
  if (strategySkip) {
    return { signal, executed: false, reason: strategySkip.reason };
  }

  switch (signal.action) {
    case 'OPEN':    return executeOpen(signal, trader, deps, opts);
    case 'CLOSE':   return executeClose(signal, trader, deps, opts);
    case 'ADD':     return executeAdd(signal, trader, deps, opts);
    case 'TRIM':    return executeTrim(signal, trader, deps, opts);
    case 'LEG_OFF': return executeLegOff(signal, trader, deps, opts);
    default: {
      const _never: never = signal.action;
      return { signal, executed: false, reason: `Unknown action: ${String(_never)}` };
    }
  }
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
  const results: PipelineResult[] = [];
  for (const signal of signals) {
    try {
      const result = await executeSignal(signal, trader, deps, opts);
      results.push(result);
    } catch (err) {
      // Infrastructure errors (DB down, missing table) are not recoverable
      // per-signal — re-throw so the caller (runner) sees the real problem
      // instead of silently producing zero trades.
      if (err instanceof DrizzleQueryError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`Signal ${signal.action} ${signal.symbol} failed: ${reason}`);
      results.push({ signal, executed: false, reason });
    }
  }
  return results;
}
