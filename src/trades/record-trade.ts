/**
 * Shared trade recording for both live and backtest.
 * Handles OPEN, CLOSE, TRIM, ADD, LEG_OFF actions against the trades table.
 * Each action also emits an immutable event to trade_events for audit/history.
 * `backtestRunId` scopes all queries during backtest; omit for live.
 */
import { db, schema } from '../db/client.js';
import { eq, and } from 'drizzle-orm';
import { isOpen, forRun, forSymbol, forTrader } from './filters.js';
import { safeParseFloat, roundCents } from '../lib/numbers.js';
import { computeTradePnl } from '../lib/pnl.js';
import { createLogger } from '../lib/logger.js';
import { tradeQty } from '../lib/trade.js';
import type { TradeLeg } from '../db/schema.js';

const log = createLogger('RecordTrade');

export type RecordTradeInput = {
  action: 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF';
  symbol: string;
  trader: string;
  direction?: 'LONG' | 'SHORT';
  strategy?: string;
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
  strategy?: string | null;
  direction?: string | null;
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

  // Guard: backtest trades must have explicit timestamps — never fall back to
  // wall-clock time, which collapses the equity curve to a single day.
  if (isBacktest || backtestRunId) {
    if (action === 'OPEN' && !openedAt) {
      throw new Error(`recordTrade: backtest OPEN for ${symbol} missing openedAt timestamp`);
    }
    if ((action === 'CLOSE' || action === 'TRIM') && !closedAt) {
      throw new Error(`recordTrade: backtest ${action} for ${symbol} missing closedAt timestamp`);
    }
  }

  // Build scoped filter for finding existing positions
  const scopeFilters = [
    isOpen,
    forSymbol(symbol),
    forTrader(trader),
    ...(backtestRunId ? [forRun(backtestRunId)] : [eq(schema.trades.isBacktest, false)]),
  ];

  // ── OPEN: insert a new trade row ──
  if (action === 'OPEN') {
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
  const [existing] = await db.select().from(schema.trades).where(and(...scopeFilters)).limit(1);
  if (!existing) {
    log.debug(`${action}: no open position for ${symbol}/${trader}${backtestRunId ? ` run=${backtestRunId.slice(0, 8)}` : ''}`);
    return null;
  }

  // ── CLOSE: close the entire position ──
  if (action === 'CLOSE') {
    const exit = exitPrice ?? 0;
    const entry = safeParseFloat(existing.entryPrice);
    const qty = tradeQty(existing.quantity);
    const pnl = computeTradePnl({
      entryPrice: entry, exitPrice: exit,
      direction: existing.direction as 'LONG' | 'SHORT',
      strategy: existing.strategy, quantity: qty,
    });
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
        pnl: String(pnl),
        closedAt: ts,
        closeMessageId: closeMessageId ?? null,
      })
      .where(eq(schema.trades.id, existing.id));

    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
    log.debug(`CLOSE: ${existing.symbol} exit=$${exit} PnL=$${pnl} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'CLOSE', trade };
  }

  // ── ADD: increase quantity on existing position ──
  if (action === 'ADD') {
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

  // ── TRIM: partial close — create child trade, update parent ──
  if (action === 'TRIM') {
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
    const pnl = computeTradePnl({
      entryPrice: entry, exitPrice: exit,
      direction: existing.direction as 'LONG' | 'SHORT',
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
      metadata: { exitPercent: exitPercent ?? (existingQty > 0 ? trimQty / existingQty : null) },
      timestamp: ts,
    });

    // Create closed child trade
    const childId = crypto.randomUUID();
    await db.insert(schema.trades).values({
      id: childId,
      taskId: taskId ?? null,
      sourceMessageId: sourceMessageId ?? existing.sourceMessageId,
      trader,
      symbol,
      direction: existing.direction,
      strategy: existing.strategy,
      legs: existing.legs,
      status: 'CLOSED',
      entryPrice: existing.entryPrice,
      exitPrice: String(exit),
      exitPercent: existingQty > 0 ? trimQty / existingQty : null,
      quantity: trimQty,
      pnl: String(pnl),
      openedAt: existing.openedAt,
      closedAt: ts,
      closeMessageId: closeMessageId ?? null,
      parentTradeId: existing.id,
      isBacktest: existing.isBacktest,
      backtestRunId: existing.backtestRunId,
      metadata: metadata ?? {},
    });

    // Update parent: reduce quantity, change status
    const remainingQty = existingQty - trimQty;
    await db.update(schema.trades)
      .set({
        quantity: Math.max(0, remainingQty),
        status: remainingQty <= 0 ? 'CLOSED' : 'PARTIAL',
      })
      .where(eq(schema.trades.id, existing.id));

    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, childId));
    log.debug(`TRIM: ${symbol} -${trimQty}/${existingQty} @$${exit} PnL=$${pnl} remaining=${remainingQty} [${existing.id.slice(0, 8)}]`);
    return { tradeId: childId, action: 'TRIM', trade };
  }

  // ── LEG_OFF: close one leg of a spread, mutate position in place ──
  // Not a new trade — the position stays open with a different shape.
  // OPEN CDS → LEG_OFF (mutate to CALL) → eventually CLOSE CALL. One trade row.
  if (action === 'LEG_OFF') {
    const exit = exitPrice ?? 0;
    const entry = safeParseFloat(existing.entryPrice);

    const targetStrategy = (metadata as Record<string, unknown>)?.targetStrategy as string;
    const closedLeg = (metadata as Record<string, unknown>)?.closedLeg as TradeLeg | undefined;
    const keptLeg = (metadata as Record<string, unknown>)?.keptLeg as TradeLeg | undefined;

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

    await db.update(schema.trades)
      .set({
        strategy: targetStrategy,
        legs: [keptLeg],
        entryPrice: String(newEntryPrice),
      })
      .where(eq(schema.trades.id, existing.id));

    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
    log.debug(`LEG_OFF: ${existing.strategy}→${targetStrategy} ${symbol} buyback=$${exit} newBasis=$${newEntryPrice} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'LEG_OFF', trade };
  }

  return null;
}
