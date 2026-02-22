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
import { RecordTradeInputSchema, LegOffMetadataSchema } from './schemas.js';
import type { TradeLeg } from '../db/schema.js';

export type { RecordTradeInput } from './schemas.js';

const log = createLogger('RecordTrade');

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

export async function recordTrade(rawInput: unknown): Promise<RecordTradeResult | null> {
  const input = RecordTradeInputSchema.parse(rawInput);
  // Common fields present in every variant
  const { action, symbol, trader, direction, strategy,
          tradeId: inputTradeId, isBacktest, backtestRunId,
          sourceMessageId, closeMessageId, taskId, metadata } = input;

  const now = new Date().toISOString();

  // Guard: backtest trades must have explicit timestamps — never fall back to
  // wall-clock time, which collapses the equity curve to a single day.
  if (isBacktest || backtestRunId) {
    if (action === 'OPEN') {
      const openedAt = input.action === 'OPEN' ? input.openedAt : undefined;
      if (!openedAt) throw new Error(`recordTrade: backtest OPEN for ${symbol} missing openedAt timestamp`);
    }
    if (action === 'CLOSE' || action === 'TRIM') {
      const closedAt = (input.action === 'CLOSE' || input.action === 'TRIM') ? input.closedAt : undefined;
      if (!closedAt) throw new Error(`recordTrade: backtest ${action} for ${symbol} missing closedAt timestamp`);
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
  if (input.action === 'OPEN') {
    const { entryPrice, quantity, openedAt, legs } = input;
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
  const [existing] = inputTradeId
    ? await db.select().from(schema.trades).where(eq(schema.trades.id, inputTradeId))
    : await db.select().from(schema.trades).where(and(...scopeFilters)).limit(1);
  if (!existing) {
    log.debug(`${action}: no open position for ${symbol}/${trader}${backtestRunId ? ` run=${backtestRunId.slice(0, 8)}` : ''}`);
    return null;
  }

  // ── CLOSE: close the entire position ──
  if (input.action === 'CLOSE') {
    const { exitPrice, closedAt } = input;
    const exit = exitPrice ?? 0;
    const entry = safeParseFloat(existing.entryPrice);
    const qty = tradeQty(existing.quantity);
    const closePnl = computeTradePnl({
      entryPrice: entry, exitPrice: exit,
      direction: existing.direction as 'LONG' | 'SHORT',
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
        ...(metadata ? { metadata: { ...(existing.metadata as Record<string, unknown> ?? {}), ...metadata } } : {}),
      })
      .where(eq(schema.trades.id, existing.id));

    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
    log.debug(`CLOSE: ${existing.symbol} exit=$${exit} closePnl=$${closePnl} realizedPnl=$${priorRealized} totalPnl=$${totalPnl} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'CLOSE', trade };
  }

  // ── ADD: increase quantity on existing position ──
  if (input.action === 'ADD') {
    const { entryPrice, quantity, openedAt } = input;
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
  if (input.action === 'TRIM') {
    const { exitPrice, closeQuantity, exitPercent, closedAt } = input;
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
  if (input.action === 'LEG_OFF') {
    const { exitPrice, closedAt } = input;
    const exit = exitPrice ?? 0;
    const entry = safeParseFloat(existing.entryPrice);

    const { targetStrategy, closedLeg, keptLeg } = LegOffMetadataSchema.parse(metadata);

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
