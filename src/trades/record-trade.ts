/**
 * Shared trade recording for both live and backtest.
 * Handles OPEN, CLOSE, TRIM, ADD, LEG_OFF actions against the trades table.
 * Each action also emits an immutable event to trade_events for audit/history.
 * `backtestRunId` scopes all queries during backtest; omit for live.
 */
import { db, schema } from '../db/client.js';
import { eq, and } from 'drizzle-orm';
import { isOpen, forRun, forSymbol, forTrader, forStrategy } from './filters.js';
import { safeParseFloat, roundCents } from '../lib/numbers.js';
import { computeTradePnl } from '../lib/pnl.js';
import { createLogger } from '../lib/logger.js';
import { tradeQty } from '../lib/trade.js';
import type { TradeLeg } from '../db/schema.js';
import type { Direction, Strategy } from '../lib/enums.js';

const log = createLogger('RecordTrade');

export type RecordTradeInput = {
  /** Optional hint — recordTrade derives the actual action from legs vs existing position.
   *  If omitted, the function infers OPEN (no tradeId) or derives CLOSE/TRIM/ADD/LEG_OFF
   *  from leg comparison. If provided, used as fallback when derivation returns null. */
  action?: 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF';
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
  backtestRunId?: string;
  isBacktest?: boolean;
  metadata?: Record<string, unknown>;
};

export type RecordTradeResult = {
  tradeId: string;
  action: 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF';
  /** The trade row after the operation */
  trade: typeof schema.trades.$inferSelect;
};

// ─── Event helper ────────────────────────────────────

function emitEvent(params: {
  tradeId: string;
  action: string;
  price?: number | null;
  quantity?: number | null;
  legs?: TradeLeg[];
  strategy?: Strategy | null;
  direction?: Direction | null;
  messageId?: string | null;
  metadata?: Record<string, unknown>;
  timestamp: string;
}) {
  return db.insert(schema.tradeEvents).values({
    id: crypto.randomUUID(),
    tradeId: params.tradeId,
    action: params.action,
    price: params.price != null ? String(params.price) : null,
    quantity: params.quantity ?? null,
    legs: params.legs ?? [],
    strategy: params.strategy ?? null,
    direction: params.direction ?? null,
    messageId: params.messageId ?? null,
    metadata: params.metadata ?? {},
    timestamp: params.timestamp,
  });
}

// ─── Action derivation ──────────────────────────────

type DerivedAction = 'CLOSE' | 'TRIM' | 'LEG_OFF' | 'ADD';

/**
 * Derive the correct action by comparing incoming legs against the existing
 * position's legs. Returns null if derivation isn't possible (caller's hint
 * is used as fallback).
 *
 * Same-direction legs (BUY→BUY or SELL→SELL) = ADD.
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

  // All incoming legs are same-direction as existing → adding to position
  if (sameDir > 0 && reversal === 0 && unmatched === 0) return 'ADD';

  // All incoming legs are reversals
  if (reversal > 0 && sameDir === 0) {
    // Subset of existing legs reversed → LEG_OFF (spread shape changes)
    if (reversal < existingLegs.length) return 'LEG_OFF';

    // All existing legs reversed — check quantity to distinguish CLOSE vs TRIM
    const incomingQty = incomingLegs[0]?.quantity ?? 1;
    if (incomingQty < existingQty) return 'TRIM';
    return 'CLOSE';
  }

  // Mixed or unmatched — can't derive reliably
  return null;
}

// ─── Main ────────────────────────────────────────────

export async function recordTrade(input: RecordTradeInput): Promise<RecordTradeResult | null> {
  const {
    action, symbol, trader, direction, strategy,
    entryPrice, exitPrice, quantity,
    closeQuantity, exitPercent,
    legs, openedAt, closedAt, sourceMessageId, closeMessageId,
    taskId, backtestRunId, isBacktest, metadata,
  } = input;

  const now = new Date().toISOString();

  // Infer intent: no tradeId → OPEN, tradeId present → position-modifying (derived from legs later)
  const isOpen_ = !input.tradeId && (action === 'OPEN' || action == null);

  // Guard: quantity must be positive if provided (validate at boundary, not in readers).
  if (quantity != null && quantity <= 0) {
    throw new Error(`recordTrade: invalid quantity ${quantity} for ${action ?? 'unknown'} ${symbol} (must be positive)`);
  }
  if (closeQuantity != null && closeQuantity <= 0) {
    throw new Error(`recordTrade: invalid closeQuantity ${closeQuantity} for ${action ?? 'unknown'} ${symbol} (must be positive)`);
  }

  // Guard: backtest trades must have explicit timestamps — never fall back to
  // wall-clock time, which collapses the equity curve to a single day.
  if (isBacktest || backtestRunId) {
    if (isOpen_ && !openedAt) {
      throw new Error(`recordTrade: backtest OPEN for ${symbol} missing openedAt timestamp`);
    }
    if (!isOpen_ && !closedAt) {
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
    ...(backtestRunId ? [forRun(backtestRunId)] : [eq(schema.trades.isBacktest, false)]),
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
      direction: direction ?? 'LONG',
      strategy: strategy ?? 'STOCK',
      legs: legs ?? [],
      status: 'OPEN',
      entryPrice: entryPrice != null ? String(entryPrice) : null,
      exitPrice: null,
      quantity: quantity ?? 1,
      pnl: null,
      openedAt: ts,
      closedAt: null,
      isBacktest: isBacktest ?? !!backtestRunId,
      backtestRunId: backtestRunId ?? null,
      metadata: metadata ?? {},
    };
    await db.insert(schema.trades).values(values);
    await emitEvent({
      tradeId,
      action: 'OPEN',
      price: entryPrice,
      quantity: quantity ?? 1,
      legs: legs ?? [],
      strategy: strategy ?? 'STOCK',
      direction: direction ?? 'LONG',
      messageId: sourceMessageId,
      timestamp: ts,
    });
    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, tradeId));
    log.debug(`OPEN: ${direction ?? 'LONG'} ${strategy ?? 'STOCK'} ${symbol} qty=${quantity ?? 1} @$${entryPrice} [${tradeId.slice(0, 8)}]`);
    return { tradeId, action: 'OPEN', trade };
  }

  // ── Find existing open position for CLOSE/ADD/TRIM/LEG_OFF ──
  // Fast path: caller already identified the trade (pipeline does its own lookup).
  // Fallback: scope-filter query for callers that only know symbol/trader/strategy.
  const [existing] = input.tradeId
    ? await db.select().from(schema.trades).where(eq(schema.trades.id, input.tradeId))
    : await db.select().from(schema.trades).where(and(...scopeFilters)).limit(1);
  if (!existing) {
    log.debug(`${action ?? 'position-modify'}: no open position for ${symbol}/${trader}${backtestRunId ? ` run=${backtestRunId.slice(0, 8)}` : ''}`);
    return null;
  }

  // ── Derive action from legs vs existing position ──
  // The caller's action is a hint; the data determines what actually happened.
  const existingLegs = (existing.legs ?? []) as TradeLeg[];
  const incomingLegs = legs ?? [];
  const derived = deriveActionFromLegs(incomingLegs, existingLegs, tradeQty(existing.quantity));
  const effectiveAction = derived ?? action ?? 'CLOSE';

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
        // This is a partial leg close — convert to LEG_OFF
        const closedLeg = closedLegs[0];
        const keptLeg = keptLegs[0];
        const targetStrategy = keptLeg.type === 'CALL' ? 'CALL' as Strategy
          : keptLeg.type === 'PUT' ? 'PUT' as Strategy
          : 'STOCK' as Strategy;

        const exit = exitPrice ?? 0;
        const entry = safeParseFloat(existing.entryPrice);
        const newEntryPrice = roundCents(entry + exit);
        const ts = closedAt ?? now;

        await emitEvent({
          tradeId: existing.id,
          action: 'LEG_OFF',
          price: exit,
          quantity: tradeQty(existing.quantity),
          legs: existingLegs,
          strategy: existing.strategy,
          direction: existing.direction,
          messageId: closeMessageId,
          metadata: { targetStrategy, closedLeg, keptLeg },
          timestamp: ts,
        });

        const openLegCount = existingLegs.length;
        await db.update(schema.trades)
          .set({
            strategy: targetStrategy,
            legs: [keptLeg],
            entryPrice: String(newEntryPrice),
            metadata: { ...existing.metadata, openLegCount },
          })
          .where(eq(schema.trades.id, existing.id));

        const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
        log.debug(`LEG_OFF (auto): ${existing.strategy}→${targetStrategy} ${symbol} buyback=$${exit} newBasis=$${newEntryPrice} [${existing.id.slice(0, 8)}]`);
        return { tradeId: existing.id, action: 'LEG_OFF', trade };
      }
      // Detection failed — fall through to normal CLOSE
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

    await emitEvent({
      tradeId: existing.id,
      action: 'CLOSE',
      price: exit,
      quantity: qty,
      strategy: existing.strategy,
      direction: existing.direction,
      messageId: closeMessageId,
      timestamp: ts,
    });

    await db.update(schema.trades)
      .set({
        status: 'CLOSED',
        exitPrice: String(exit),
        pnl: String(totalPnl),
        closedAt: ts,
        closeMessageId: closeMessageId ?? null,
        ...(metadata ? { metadata: { ...existing.metadata, ...metadata } } : {}),
      })
      .where(eq(schema.trades.id, existing.id));

    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
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

    await emitEvent({
      tradeId: existing.id,
      action: 'ADD',
      price: addPrice,
      quantity: addQty,
      strategy: existing.strategy,
      direction: existing.direction,
      messageId: sourceMessageId,
      timestamp: ts,
    });

    await db.update(schema.trades)
      .set({
        quantity: totalQty,
        entryPrice: String(avgPrice),
        avgEntryPrice: String(avgPrice),
      })
      .where(eq(schema.trades.id, existing.id));

    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
    log.debug(`ADD: ${symbol} +${addQty} @$${addPrice} -> avg=$${avgPrice} totalQty=${totalQty} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'ADD', trade };
  }

  // ── TRIM: partial close — update position in place, accumulate realizedPnl ──
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

    await emitEvent({
      tradeId: existing.id,
      action: 'TRIM',
      price: exit,
      quantity: trimQty,
      strategy: existing.strategy,
      direction: existing.direction,
      messageId: closeMessageId,
      metadata: { exitPercent: exitPercent ?? (existingQty > 0 ? trimQty / existingQty : null), trimPnl },
      timestamp: ts,
    });

    // Accumulate realized PnL from this trim
    const priorRealized = safeParseFloat(existing.realizedPnl);
    const newRealized = roundCents(priorRealized + trimPnl);
    const remainingQty = existingQty - trimQty;

    if (remainingQty <= 0) {
      // 100% trim = effectively a close
      await db.update(schema.trades)
        .set({
          quantity: 0,
          status: 'CLOSED',
          realizedPnl: String(newRealized),
          pnl: String(newRealized),
          exitPrice: String(exit),
          closedAt: ts,
          closeMessageId: closeMessageId ?? null,
        })
        .where(eq(schema.trades.id, existing.id));
    } else {
      await db.update(schema.trades)
        .set({
          quantity: remainingQty,
          realizedPnl: String(newRealized),
        })
        .where(eq(schema.trades.id, existing.id));
    }

    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
    log.debug(`TRIM: ${symbol} -${trimQty}/${existingQty} @$${exit} trimPnl=$${trimPnl} realizedPnl=$${newRealized} remaining=${remainingQty} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'TRIM', trade };
  }

  // ── LEG_OFF: close one leg of a spread, mutate position in place ──
  // Not a new trade — the position stays open with a different shape.
  // OPEN CDS → LEG_OFF (mutate to CALL) → eventually CLOSE CALL. One trade row.
  if (effectiveAction === 'LEG_OFF') {
    const exit = exitPrice ?? 0;
    const entry = safeParseFloat(existing.entryPrice);

    // Try metadata first (explicit LEG_OFF from caller), then derive from legs
    let targetStrategy = (metadata as Record<string, unknown>)?.targetStrategy as Strategy | undefined;
    let closedLeg = (metadata as Record<string, unknown>)?.closedLeg as TradeLeg | undefined;
    let keptLeg = (metadata as Record<string, unknown>)?.keptLeg as TradeLeg | undefined;

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

    const newEntryPrice = roundCents(entry + exit);
    const ts = closedAt ?? now;

    await emitEvent({
      tradeId: existing.id,
      action: 'LEG_OFF',
      price: exit,
      quantity: tradeQty(existing.quantity),
      legs: existing.legs as TradeLeg[],
      strategy: existing.strategy,
      direction: existing.direction,
      messageId: closeMessageId,
      metadata: { targetStrategy, closedLeg, keptLeg },
      timestamp: ts,
    });

    const openLegCount = Array.isArray(existing.legs) ? existing.legs.length : 1;
    await db.update(schema.trades)
      .set({
        strategy: targetStrategy,
        legs: [keptLeg],
        entryPrice: String(newEntryPrice),
        metadata: { ...existing.metadata, openLegCount },
      })
      .where(eq(schema.trades.id, existing.id));

    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
    log.debug(`LEG_OFF: ${existing.strategy}→${targetStrategy} ${symbol} buyback=$${exit} newBasis=$${newEntryPrice} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'LEG_OFF', trade };
  }

  return null;
}
