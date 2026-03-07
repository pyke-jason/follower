/**
 * Shared trade recording for both live and backtest.
 * Handles OPEN, CLOSE, TRIM, ADD, LEG_OFF actions against the trades table.
 * Each action also emits an immutable event to trade_events for audit/history.
 * `channelId` scopes all queries (e.g. 'live:<accountId>', 'bt:<runId>', 'paper:<accountId>').
 *
 * Every action path wraps its writes (trade insert/update + event insert) in a
 * db.transaction() to guarantee trades and trade_events stay in sync.
 */
import { db, schema, runTx } from '../db/client.js';
import { and, eq } from 'drizzle-orm';
import { isOpen, forChannel, forSymbol, forTrader, forStrategy } from './filters.js';
import { safeParseFloat, roundCents } from '../lib/numbers.js';
import { computeTradePnl } from '../lib/pnl.js';
import { createLogger } from '../lib/logger.js';
import { tradeQty } from '../lib/trade.js';
import type { TradeLeg, TradeMetadata, TradeFlag } from '../db/schema.js';
import type { Direction, Strategy, TradeAction } from '../lib/enums.js';
import type { OrderLeg } from '../broker/types.js';
import { buildFlags } from './trade-flags.js';

const log = createLogger('RecordTrade');

/** Sum chase steps across events. Returns undefined when total is 0 (omit from metadata). */
const sumChase = (a?: number, b?: number): number | undefined => {
  const sum = (a ?? 0) + (b ?? 0);
  return sum > 0 ? sum : undefined;
};

/** Transaction handle — same API surface as `db` but scoped to a transaction. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RecordTradeInput = {
  /** Optional hint — recordTrade derives the actual action from legs vs existing position.
   *  If omitted, the function infers OPEN (no tradeId) or derives CLOSE/TRIM/ADD/LEG_OFF
   *  from leg comparison. If provided, used as fallback when derivation returns null. */
  action?: TradeAction;
  symbol: string;
  trader: string;
  direction?: Direction;
  strategy?: Strategy;
  /** When the caller already knows which trade to target (from a prior lookup),
   *  pass the ID here to skip the redundant scope-filter query. */
  tradeId?: string;
  entryPrice?: number;
  exitPrice?: number;
  quantity?: number;
  closeQuantity?: number;
  exitPercent?: number;
  legs?: TradeLeg[];
  openedAt?: string;       // ISO string
  closedAt?: string;       // ISO string
  sourceMessageId?: string;
  closeMessageId?: string;
  taskId?: string;
  channelId: string;
  requireExplicitTimestamps?: boolean;
  metadata?: TradeMetadata;
};

export type RecordTradeResult = {
  tradeId: string;
  action: TradeAction;
  /** The trade row after the operation */
  trade: typeof schema.trades.$inferSelect;
};

// ─── Event helper ────────────────────────────────────

type TradeEventSource = Pick<typeof schema.trades.$inferSelect, 'id' | 'strategy' | 'direction' | 'legs'>;

type TradeEventData = {
  action: string;
  price?: number | null;
  quantity?: number | null;
  messageId?: string | null;
  metadata?: Record<string, unknown>;
  timestamp: string;
  legs?: TradeLeg[]; // overrides source.legs
};

function emitEvent(tx: Tx, source: TradeEventSource, data: TradeEventData) {
  tx.insert(schema.tradeEvents).values({
    id: crypto.randomUUID(),
    tradeId: source.id,
    action: data.action,
    price: data.price != null ? String(data.price) : null,
    quantity: data.quantity ?? null,
    legs: data.legs ?? source.legs ?? [],
    strategy: source.strategy ?? null,
    direction: source.direction ?? null,
    messageId: data.messageId ?? null,
    metadata: data.metadata ?? {},
    timestamp: data.timestamp,
  }).run();
}

// ─── Action derivation ──────────────────────────────

type DerivedAction = 'CLOSE' | 'TRIM' | 'LEG_OFF' | 'ADD';

/**
 * Derive the correct action by comparing incoming legs against the existing
 * position's legs. Returns null if derivation isn't possible (caller's hint
 * is used as fallback).
 *
 * Same-direction legs (BUY->BUY or SELL->SELL) = ADD.
 * Reversal legs covering all existing legs at full qty = CLOSE.
 * Reversal legs covering all existing legs at partial qty = TRIM.
 * Reversal legs covering a subset of existing legs = LEG_OFF.
 */
function deriveActionFromLegs(
  incomingLegs: TradeLeg[],
  existingLegs: TradeLeg[],
  existingQty: number,
): DerivedAction | null {
  if (incomingLegs.length === 0 || existingLegs.length === 0) return null;

  // Classify each incoming leg as same-direction or reversal relative to
  // the matching existing leg (matched by strike + type + expiry).
  let sameDir = 0;
  let reversal = 0;
  let unmatched = 0;

  for (const il of incomingLegs) {
    const match = existingLegs.find(el =>
      el.strike === il.strike && el.type === il.type && el.expiry === il.expiry
    );
    if (!match) {
      unmatched++;
      continue;
    }
    if (il.action === match.action) sameDir++;
    else reversal++;
  }

  // All incoming legs are same-direction as existing -> adding to position
  if (sameDir > 0 && reversal === 0 && unmatched === 0) return 'ADD';

  // All incoming legs are reversals
  if (reversal > 0 && sameDir === 0) {
    // Subset of existing legs reversed -> LEG_OFF (spread shape changes)
    if (reversal < existingLegs.length) return 'LEG_OFF';

    // All existing legs reversed -- check quantity to distinguish CLOSE vs TRIM
    const incomingQty = incomingLegs[0]?.quantity ?? 1;
    if (incomingQty < existingQty) return 'TRIM';
    return 'CLOSE';
  }

  // Mixed or unmatched -- can't derive reliably
  return null;
}

// ─── Main ────────────────────────────────────────────

export async function recordTrade(input: RecordTradeInput): Promise<RecordTradeResult | null> {
  const {
    action, symbol, trader, direction, strategy,
    entryPrice, exitPrice, quantity,
    closeQuantity, exitPercent,
    legs, openedAt, closedAt, sourceMessageId, closeMessageId,
    taskId, channelId, requireExplicitTimestamps, metadata,
  } = input;

  const now = new Date().toISOString();

  // Infer intent: no tradeId -> OPEN, tradeId present -> position-modifying (derived from legs later)
  const isOpen_ = !input.tradeId && (action === 'OPEN' || action == null);

  // Guard: quantity must be positive if provided (validate at boundary, not in readers).
  if (quantity != null && quantity <= 0) {
    throw new Error(`recordTrade: invalid quantity ${quantity} for ${action ?? 'unknown'} ${symbol} (must be positive)`);
  }
  if (closeQuantity != null && closeQuantity <= 0) {
    throw new Error(`recordTrade: invalid closeQuantity ${closeQuantity} for ${action ?? 'unknown'} ${symbol} (must be positive)`);
  }

  // Guard: OPEN trades must have explicit direction and strategy -- defaulting
  // silently would record e.g. a SHORT PUT as LONG STOCK.
  if (isOpen_) {
    if (!direction) {
      throw new Error(`recordTrade: OPEN for ${symbol} missing direction (would have defaulted to LONG)`);
    }
    if (!strategy) {
      throw new Error(`recordTrade: OPEN for ${symbol} missing strategy (would have defaulted to STOCK)`);
    }
  }

  // Guard: backtest trades must have explicit timestamps -- never fall back to
  // wall-clock time, which collapses the equity curve to a single day.
  if (requireExplicitTimestamps) {
    if (isOpen_ && !openedAt) {
      throw new Error(`recordTrade: backtest OPEN for ${symbol} missing openedAt timestamp`);
    }
    if (!isOpen_ && action === 'ADD' && !openedAt) {
      throw new Error(`recordTrade: backtest ADD for ${symbol} missing openedAt timestamp`);
    }
    if (!isOpen_ && action !== 'ADD' && !closedAt) {
      throw new Error(`recordTrade: backtest ${action ?? 'position-modify'} for ${symbol} missing closedAt timestamp`);
    }
  }

  // Build scoped filter for finding existing positions.
  // Strategy filter prevents matching e.g. a STOCK position when the signal is for PDS.
  const scopeFilters = [
    isOpen,
    forSymbol(symbol),
    forTrader(trader),
    ...(strategy ? [forStrategy(strategy)] : []),
    forChannel(channelId),
  ];

  // ── OPEN: insert a new trade row ──
  if (isOpen_) {
    const tradeId = crypto.randomUUID();
    const ts = openedAt ?? now;
    const values = {
      id: tradeId,
      taskId: taskId ?? null,
      sourceMessageId: sourceMessageId ?? null,
      trader,
      symbol,
      // SAFETY: direction and strategy are guaranteed non-null by the isOpen_ guard above.
      direction: direction!,
      strategy: strategy!,
      legs: legs ?? [],
      status: 'OPEN',
      entryPrice: entryPrice != null ? String(entryPrice) : null,
      exitPrice: null,
      quantity: quantity ?? 1,
      pnl: null,
      openedAt: ts,
      closedAt: null,
      channelId,
      metadata: metadata ?? {},
    };

    const trade = runTx((tx) => {
      tx.insert(schema.trades).values(values).run();
      // SAFETY: direction and strategy are guaranteed non-null by the isOpen_ guard above.
      emitEvent(tx, { id: tradeId, strategy: strategy!, direction: direction!, legs: legs ?? [] }, {
        action: 'OPEN', price: entryPrice, quantity: quantity ?? 1,
        messageId: sourceMessageId, metadata: metadata ?? undefined, timestamp: ts,
      });
      const [row] = tx.select().from(schema.trades).where(eq(schema.trades.id, tradeId)).all();
      return row;
    });

    log.debug(`OPEN: ${direction} ${strategy} ${symbol} qty=${quantity ?? 1} @$${entryPrice} [${tradeId.slice(0, 8)}]`);
    return { tradeId, action: 'OPEN', trade };
  }

  // ── Find existing open position for CLOSE/ADD/TRIM/LEG_OFF ──
  // Fast path: caller already identified the trade (pipeline does its own lookup).
  // Fallback: scope-filter query for callers that only know symbol/trader/strategy.
  const [existing] = input.tradeId
    ? await db.select().from(schema.trades).where(eq(schema.trades.id, input.tradeId))
    : await db.select().from(schema.trades).where(and(...scopeFilters)).limit(1);
  if (!existing) {
    log.debug(`${action ?? 'position-modify'}: no open position for ${symbol}/${trader} [${channelId}]`);
    return null;
  }

  // ── Derive action from legs vs existing position ──
  // The caller's action is a hint; the data determines what actually happened.
  const existingLegs = existing.legs;
  const incomingLegs = legs ?? [];
  const derived = deriveActionFromLegs(incomingLegs, existingLegs, tradeQty(existing.quantity));
  const effectiveAction = derived ?? action;
  if (!effectiveAction) {
    log.debug(`Cannot determine action for ${symbol}/${trader}: derivation returned null and no caller hint [${existing.id.slice(0, 8)}]`);
    return null;
  }

  if (derived && derived !== action && action != null) {
    log.debug(`Action override: caller=${action} derived=${derived} for ${symbol} [${existing.id.slice(0, 8)}]`);
  }

  // ── CLOSE: close the entire position ──
  if (effectiveAction === 'CLOSE') {
    // ── Fallback leg comparison: auto-detect partial leg close on spreads ──
    // (Normally caught by deriveActionFromLegs above, but kept for callers that
    // don't provide legs or when derivation returns null.)
    if (existingLegs.length >= 2 && incomingLegs.length > 0 && incomingLegs.length < existingLegs.length) {
      // Match incoming legs to existing legs by strike + type + expiry
      const closedLegs: TradeLeg[] = [];
      const keptLegs: TradeLeg[] = [];
      for (const el of existingLegs) {
        const matched = incomingLegs.some(il =>
          il.strike === el.strike && il.type === el.type && il.expiry === el.expiry
        );
        if (matched) closedLegs.push(el);
        else keptLegs.push(el);
      }

      if (closedLegs.length > 0 && keptLegs.length > 0) {
        // This is a partial leg close -- convert to LEG_OFF
        const closedLeg = closedLegs[0];
        const keptLeg = keptLegs[0];
        const targetStrategy = keptLeg.type === 'CALL' ? 'CALL' as Strategy
          : keptLeg.type === 'PUT' ? 'PUT' as Strategy
          : 'STOCK' as Strategy;

        // Derive direction from kept leg: BUY leg = LONG, SELL leg = SHORT
        const newDirection: Direction = keptLeg.action === 'SELL' ? 'SHORT' : 'LONG';

        const exit = exitPrice ?? 0;
        const entry = safeParseFloat(existing.entryPrice);
        // BUY (kept long) → accumulate debit: entry + buyback cost
        // SELL (kept short) → net credit: original credit - buyback cost
        const newEntryPrice = keptLeg.action === 'SELL'
          ? roundCents(entry - exit)
          : roundCents(entry + exit);
        const ts = closedAt ?? now;

        // Compute realized PnL on the closed leg (if individual fill price is known)
        const legOffPnl = closedLeg.fillPrice != null
          ? computeTradePnl({
              entryPrice: closedLeg.fillPrice, exitPrice: exit,
              direction: closedLeg.action === 'BUY' ? 'LONG' : 'SHORT',
              strategy: closedLeg.type, quantity: tradeQty(existing.quantity),
            })
          : undefined;

        const trade = runTx((tx) => {
          emitEvent(tx, existing, {
            action: 'LEG_OFF', price: exit, quantity: tradeQty(existing.quantity),
            messageId: closeMessageId, metadata: { targetStrategy, closedLeg, keptLeg, legOffPnl }, timestamp: ts,
          });

          const openLegCount = existingLegs.length;
          const existingMeta = existing.metadata;
          tx.update(schema.trades)
            .set({
              strategy: targetStrategy,
              legs: [keptLeg],
              entryPrice: String(newEntryPrice),
              direction: newDirection,
              metadata: { ...existingMeta, chaseSteps: sumChase(existingMeta.chaseSteps, metadata?.chaseSteps), openLegCount, flags: buildFlags(existingMeta.flags, 'legOff') },
            })
            .where(eq(schema.trades.id, existing.id))
            .run();

          const [row] = tx.select().from(schema.trades).where(eq(schema.trades.id, existing.id)).all();
          return row;
        });

        log.debug(`LEG_OFF (auto): ${existing.strategy}->${targetStrategy} ${symbol} dir=${newDirection} buyback=$${exit} newBasis=$${newEntryPrice}${legOffPnl != null ? ` legPnl=$${legOffPnl}` : ''} [${existing.id.slice(0, 8)}]`);
        return { tradeId: existing.id, action: 'LEG_OFF', trade };
      }
      // Detection failed -- fall through to normal CLOSE
    }

    const exit = exitPrice ?? 0;
    const entry = safeParseFloat(existing.entryPrice);
    const qty = tradeQty(existing.quantity);
    const closePnl = computeTradePnl({
      entryPrice: entry, exitPrice: exit,
      direction: existing.direction,
      strategy: existing.strategy, quantity: qty,
    });
    // Total PnL includes any realized PnL accumulated from prior TRIMs
    const priorRealized = safeParseFloat(existing.realizedPnl);
    const totalPnl = roundCents(closePnl + priorRealized);
    const ts = closedAt ?? now;

    const existingMeta = existing.metadata;
    const closeFlags: TradeFlag[] = [];
    if (!closeMessageId) closeFlags.push('autoClose');
    const mergedMeta: TradeMetadata = {
      ...existingMeta,
      ...metadata,
      chaseSteps: sumChase(existingMeta.chaseSteps, metadata?.chaseSteps),
      flags: buildFlags(existingMeta.flags, ...metadata?.flags ?? [], ...closeFlags),
    };

    const trade = runTx((tx) => {
      emitEvent(tx, existing, {
        action: 'CLOSE', price: exit, quantity: qty,
        messageId: closeMessageId, metadata: metadata ?? undefined, timestamp: ts,
      });

      tx.update(schema.trades)
        .set({
          status: 'CLOSED',
          exitPrice: String(exit),
          pnl: String(totalPnl),
          closedAt: ts,
          closeMessageId: closeMessageId ?? null,
          metadata: mergedMeta,
        })
        .where(eq(schema.trades.id, existing.id))
        .run();

      const [row] = tx.select().from(schema.trades).where(eq(schema.trades.id, existing.id)).all();
      return row;
    });

    log.debug(`CLOSE: ${existing.symbol} exit=$${exit} closePnl=$${closePnl} realizedPnl=$${priorRealized} totalPnl=$${totalPnl} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'CLOSE', trade };
  }

  // ── ADD: increase quantity on existing position ──
  if (effectiveAction === 'ADD') {
    const addQty = quantity ?? 1;
    const addPrice = entryPrice ?? 0;
    const existingQty = tradeQty(existing.quantity);
    const existingPrice = safeParseFloat(existing.entryPrice);

    const totalQty = existingQty + addQty;
    const avgPrice = roundCents((existingPrice * existingQty + addPrice * addQty) / totalQty);
    const ts = openedAt ?? now;

    const existingMeta = existing.metadata;

    const trade = runTx((tx) => {
      emitEvent(tx, existing, {
        action: 'ADD', price: addPrice, quantity: addQty,
        messageId: sourceMessageId, metadata: metadata ?? undefined, timestamp: ts,
      });

      tx.update(schema.trades)
        .set({
          quantity: totalQty,
          entryPrice: String(avgPrice),
          avgEntryPrice: String(avgPrice),
          metadata: { ...existingMeta, flags: buildFlags(existingMeta.flags, 'add') },
        })
        .where(eq(schema.trades.id, existing.id))
        .run();

      const [row] = tx.select().from(schema.trades).where(eq(schema.trades.id, existing.id)).all();
      return row;
    });

    log.debug(`ADD: ${symbol} +${addQty} @$${addPrice} -> avg=$${avgPrice} totalQty=${totalQty} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'ADD', trade };
  }

  // ── TRIM: partial close -- update position in place, accumulate realizedPnl ──
  if (effectiveAction === 'TRIM') {
    const existingQty = tradeQty(existing.quantity);
    let trimQty = closeQuantity ?? (exitPercent
      ? Math.max(1, Math.floor(existingQty * exitPercent))
      : Math.max(1, Math.floor(existingQty * 0.5)));

    // Clamp to existing quantity
    if (trimQty > existingQty) {
      log.debug(`TRIM: clamping closeQuantity ${trimQty} -> ${existingQty}`);
      trimQty = existingQty;
    }

    const exit = exitPrice ?? 0;
    const entry = safeParseFloat(existing.entryPrice);
    const trimPnl = computeTradePnl({
      entryPrice: entry, exitPrice: exit,
      direction: existing.direction,
      strategy: existing.strategy, quantity: trimQty,
    });
    const ts = closedAt ?? now;

    // Accumulate realized PnL from this trim
    const priorRealized = safeParseFloat(existing.realizedPnl);
    const newRealized = roundCents(priorRealized + trimPnl);
    const remainingQty = existingQty - trimQty;

    const existingMeta = existing.metadata;
    const trimFlags = buildFlags(existingMeta.flags, 'trim');

    const trade = runTx((tx) => {
      emitEvent(tx, existing, {
        action: 'TRIM', price: exit, quantity: trimQty, messageId: closeMessageId,
        metadata: { exitPercent: exitPercent ?? (existingQty > 0 ? trimQty / existingQty : null), trimPnl, ...metadata },
        timestamp: ts,
      });

      const trimMeta: TradeMetadata = {
        ...existingMeta,
        chaseSteps: sumChase(existingMeta.chaseSteps, metadata?.chaseSteps),
        flags: trimFlags,
      };
      if (remainingQty <= 0) {
        // 100% trim = effectively a close
        tx.update(schema.trades)
          .set({
            quantity: 0,
            status: 'CLOSED',
            realizedPnl: String(newRealized),
            pnl: String(newRealized),
            exitPrice: String(exit),
            closedAt: ts,
            closeMessageId: closeMessageId ?? null,
            metadata: trimMeta,
          })
          .where(eq(schema.trades.id, existing.id))
          .run();
      } else {
        tx.update(schema.trades)
          .set({
            quantity: remainingQty,
            realizedPnl: String(newRealized),
            metadata: trimMeta,
          })
          .where(eq(schema.trades.id, existing.id))
          .run();
      }

      const [row] = tx.select().from(schema.trades).where(eq(schema.trades.id, existing.id)).all();
      return row;
    });

    log.debug(`TRIM: ${symbol} -${trimQty}/${existingQty} @$${exit} trimPnl=$${trimPnl} realizedPnl=$${newRealized} remaining=${remainingQty} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'TRIM', trade };
  }

  // ── LEG_OFF: close one leg of a spread, mutate position in place ──
  // Not a new trade -- the position stays open with a different shape.
  // OPEN CDS -> LEG_OFF (mutate to CALL) -> eventually CLOSE CALL. One trade row.
  if (effectiveAction === 'LEG_OFF') {
    const exit = exitPrice ?? 0;
    const entry = safeParseFloat(existing.entryPrice);

    // Try metadata first (explicit LEG_OFF from caller), then derive from legs
    let targetStrategy = metadata?.targetStrategy;
    let closedLeg = metadata?.closedLeg;
    let keptLeg = metadata?.keptLeg;

    if ((!targetStrategy || !keptLeg) && incomingLegs.length > 0 && existingLegs.length >= 2) {
      // Derive from leg comparison (same logic as old CLOSE-branch auto-detect)
      const closed: TradeLeg[] = [];
      const kept: TradeLeg[] = [];
      for (const el of existingLegs) {
        const matched = incomingLegs.some(il =>
          il.strike === el.strike && il.type === el.type && il.expiry === el.expiry
        );
        if (matched) closed.push(el);
        else kept.push(el);
      }
      if (closed.length > 0 && kept.length > 0) {
        closedLeg = closed[0];
        keptLeg = kept[0];
        targetStrategy = keptLeg.type === 'CALL' ? 'CALL' as Strategy
          : keptLeg.type === 'PUT' ? 'PUT' as Strategy
          : 'STOCK' as Strategy;
      }
    }

    if (!targetStrategy || !keptLeg) {
      log.warn(`LEG_OFF: missing targetStrategy or keptLeg metadata for ${symbol}/${trader}`);
      return null;
    }

    // Derive direction from kept leg: BUY leg = LONG, SELL leg = SHORT
    const newDirection: Direction = keptLeg.action === 'SELL' ? 'SHORT' : 'LONG';

    // BUY (kept long) → accumulate debit: entry + buyback cost
    // SELL (kept short) → net credit: original credit - buyback cost
    const newEntryPrice = keptLeg.action === 'SELL'
      ? roundCents(entry - exit)
      : roundCents(entry + exit);
    const ts = closedAt ?? now;

    const openLegCount = Array.isArray(existing.legs) ? existing.legs.length : 1;
    const existingMeta = existing.metadata;

    // Compute realized PnL on the closed leg (if individual fill price is known)
    const legOffPnl = closedLeg?.fillPrice != null
      ? computeTradePnl({
          entryPrice: closedLeg.fillPrice, exitPrice: exit,
          direction: closedLeg.action === 'BUY' ? 'LONG' : 'SHORT',
          strategy: closedLeg.type, quantity: tradeQty(existing.quantity),
        })
      : undefined;

    const trade = runTx((tx) => {
      emitEvent(tx, existing, {
        action: 'LEG_OFF', price: exit, quantity: tradeQty(existing.quantity),
        messageId: closeMessageId, metadata: { targetStrategy, closedLeg, keptLeg, legOffPnl }, timestamp: ts,
      });

      tx.update(schema.trades)
        .set({
          strategy: targetStrategy,
          legs: [keptLeg],
          entryPrice: String(newEntryPrice),
          direction: newDirection,
          metadata: { ...existingMeta, chaseSteps: sumChase(existingMeta.chaseSteps, metadata?.chaseSteps), openLegCount, flags: buildFlags(existingMeta.flags, 'legOff') },
        })
        .where(eq(schema.trades.id, existing.id))
        .run();

      const [row] = tx.select().from(schema.trades).where(eq(schema.trades.id, existing.id)).all();
      return row;
    });

    log.debug(`LEG_OFF: ${existing.strategy}->${targetStrategy} ${symbol} dir=${newDirection} buyback=$${exit} newBasis=$${newEntryPrice}${legOffPnl != null ? ` legPnl=$${legOffPnl}` : ''} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'LEG_OFF', trade };
  }

  return null;
}

// ─── Cancelled Open ────────────────────────────────

export type RecordCancelledOpenInput = {
  pending: {
    symbol: string;
    trader: string;
    direction: Direction;
    strategy: Strategy;
    quantity: number;
    legs: TradeLeg[] | OrderLeg[];
    messageId?: string;
    taskId?: string;
  };
  order: {
    adjustmentCount: number;
    placedAt: Date;
    cancelledAt?: Date;
    currentLimitPrice: number;
    params: { limitPrice?: number };
  };
  channelId: string;
  agentModel?: string;
};

/**
 * Record a trade that was attempted (order placed + chased) but never filled.
 * Creates a row with status='CANCELLED' — visible in trade lists, excluded from stats.
 */
export async function recordCancelledOpen(input: RecordCancelledOpenInput): Promise<RecordTradeResult> {
  const { pending, order, channelId, agentModel } = input;
  const now = new Date().toISOString();
  const tradeId = crypto.randomUUID();
  const ts = order.placedAt.toISOString();

  // Build chase metadata from order (was previously done by caller)
  const chaseFlags: TradeFlag[] = [];
  if (order.adjustmentCount >= 10) chaseFlags.push('chaseDanger');
  else if (order.adjustmentCount >= 5) chaseFlags.push('chaseWarn');
  const metadata: TradeMetadata = {
    chaseSteps: order.adjustmentCount,
    ...(chaseFlags.length > 0 ? { flags: chaseFlags } : {}),
    extra: {
      cancelReason: 'chase_timeout',
      originalLimitPrice: order.params.limitPrice,
      finalLimitPrice: order.currentLimitPrice,
    },
    ...(agentModel ? { agentModel } : {}),
  };

  const values = {
    id: tradeId,
    taskId: pending.taskId ?? null,
    sourceMessageId: pending.messageId ?? null,
    trader: pending.trader,
    symbol: pending.symbol,
    direction: pending.direction,
    strategy: pending.strategy,
    legs: pending.legs as TradeLeg[],
    status: 'CANCELLED',
    entryPrice: null,
    exitPrice: null,
    quantity: pending.quantity,
    pnl: null,
    openedAt: ts,
    closedAt: order.cancelledAt?.toISOString() ?? now,
    channelId,
    metadata,
  };

  const trade = runTx((tx) => {
    tx.insert(schema.trades).values(values).run();
    emitEvent(tx, { id: tradeId, strategy: pending.strategy, direction: pending.direction, legs: pending.legs as TradeLeg[] }, {
      action: 'CANCEL', price: null, quantity: pending.quantity,
      messageId: pending.messageId, metadata, timestamp: order.cancelledAt?.toISOString() ?? now,
    });
    const [row] = tx.select().from(schema.trades).where(eq(schema.trades.id, tradeId)).all();
    return row;
  });

  log.debug(`CANCEL: ${pending.direction} ${pending.strategy} ${pending.symbol} qty=${pending.quantity} [${tradeId.slice(0, 8)}]`);
  return { tradeId, action: 'OPEN', trade };
}
