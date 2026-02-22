/**
 * Shared trade recording for both live and backtest.
 * Handles OPEN, CLOSE, TRIM, ADD, LEG_OFF actions against the trades table.
 * Each action also emits an immutable event to trade_events for audit/history.
 * `backtestRunId` scopes all queries during backtest; omit for live.
 *
 * Validation: RecordTradeInputSchema (Zod discriminated union) validates at
 * the boundary.  Per-action required fields (exitPrice for CLOSE, quantity
 * for OPEN, etc.) are enforced by the schema — not by inline throws.
 */
import { z } from 'zod';
import { db, schema } from '../db/client.js';
import { eq, and } from 'drizzle-orm';
import { isOpen, forRun, forSymbol, forTrader, forStrategy } from './filters.js';
import { safeParseFloat, roundCents } from '../lib/numbers.js';
import { computeTradePnl } from '../lib/pnl.js';
import { createLogger } from '../lib/logger.js';
import { tradeQty } from '../lib/trade.js';
import { TradeLegSchema } from '../db/schema.js';
import { DirectionSchema, StrategySchema } from '../lib/enums.js';
import { zNonNegPrice, zQuantity } from '../lib/zod-financial.js';
import type { TradeLeg, TradeMetadata } from '../db/schema.js';

const log = createLogger('RecordTrade');

// ─── Input schemas (boundary validation) ──────────────

const BaseFields = {
  symbol: z.string().min(1),
  trader: z.string().min(1),
  tradeId: z.string().optional(),
  sourceMessageId: z.string().optional(),
  closeMessageId: z.string().optional(),
  taskId: z.string().optional(),
  backtestRunId: z.string().optional(),
  isBacktest: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
};

const RecordTradeOpenSchema = z.object({
  action: z.literal('OPEN'),
  ...BaseFields,
  direction: DirectionSchema,
  strategy: StrategySchema,
  entryPrice: z.number().optional(),
  quantity: zQuantity,
  legs: z.array(TradeLegSchema),
  openedAt: z.string().optional(),
}).refine(
  s => !(s.isBacktest || s.backtestRunId) || s.openedAt != null,
  { message: 'Backtest OPEN requires openedAt timestamp' },
);

const RecordTradeCloseSchema = z.object({
  action: z.literal('CLOSE'),
  ...BaseFields,
  direction: DirectionSchema.optional(),
  strategy: z.string().optional(),
  exitPrice: zNonNegPrice,
  closedAt: z.string().optional(),
}).refine(
  s => !(s.isBacktest || s.backtestRunId) || s.closedAt != null,
  { message: 'Backtest CLOSE requires closedAt timestamp' },
);

const RecordTradeAddSchema = z.object({
  action: z.literal('ADD'),
  ...BaseFields,
  direction: DirectionSchema,
  strategy: StrategySchema,
  entryPrice: z.number().optional(),
  quantity: zQuantity,
  legs: z.array(TradeLegSchema).optional(),
  openedAt: z.string().optional(),
});

const RecordTradeTrimSchema = z.object({
  action: z.literal('TRIM'),
  ...BaseFields,
  direction: DirectionSchema.optional(),
  strategy: z.string().optional(),
  exitPrice: zNonNegPrice,
  closeQuantity: z.number().int().positive().optional(),
  exitPercent: z.number().min(0).max(1).optional(),
  closedAt: z.string().optional(),
}).refine(
  s => !(s.isBacktest || s.backtestRunId) || s.closedAt != null,
  { message: 'Backtest TRIM requires closedAt timestamp' },
);

const RecordTradeLegOffSchema = z.object({
  action: z.literal('LEG_OFF'),
  ...BaseFields,
  direction: DirectionSchema.optional(),
  strategy: z.string().optional(),
  exitPrice: zNonNegPrice,
  targetStrategy: z.string().min(1),
  keptLeg: TradeLegSchema,
  closedLeg: TradeLegSchema.optional(),
  closedAt: z.string().optional(),
});

// Discriminated union can't include ZodEffects variants from .refine(),
// so we use z.union() — error messages are still per-schema.
export const RecordTradeInputSchema = z.union([
  RecordTradeOpenSchema,
  RecordTradeCloseSchema,
  RecordTradeAddSchema,
  RecordTradeTrimSchema,
  RecordTradeLegOffSchema,
]);

export type RecordTradeInput = z.infer<typeof RecordTradeInputSchema>;

export type RecordTradeResult = {
  tradeId: string;
  action: 'OPEN' | 'CLOSE' | 'ADD' | 'TRIM' | 'LEG_OFF';
  /** The trade row after the operation */
  trade: typeof schema.trades.$inferSelect;
};

// ─── Types ────────────────────────────────────────────

type DbContext = typeof db;

// ─── Event helper ────────────────────────────────────

function emitEvent(dbCtx: DbContext, params: {
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
  return dbCtx.insert(schema.tradeEvents).values({
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

export async function recordTrade(raw: RecordTradeInput): Promise<RecordTradeResult | null> {
  const input = RecordTradeInputSchema.parse(raw);

  const now = new Date().toISOString();

  // Build scoped filter for finding existing positions.
  // Strategy filter prevents matching e.g. a STOCK position when the signal is for PDS.
  const strategy = 'strategy' in input ? input.strategy : undefined;
  const scopeFilters = [
    isOpen,
    forSymbol(input.symbol),
    forTrader(input.trader),
    ...(strategy ? [forStrategy(strategy)] : []),
    ...(input.backtestRunId ? [forRun(input.backtestRunId)] : [eq(schema.trades.isBacktest, false)]),
  ];

  // ── OPEN: insert a new trade row ──
  if (input.action === 'OPEN') {
    const tradeId = crypto.randomUUID();
    const ts = input.openedAt ?? now;
    const values = {
      id: tradeId,
      taskId: input.taskId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      trader: input.trader,
      symbol: input.symbol,
      direction: input.direction,
      strategy: input.strategy,
      legs: input.legs,
      status: 'OPEN',
      entryPrice: input.entryPrice != null ? String(input.entryPrice) : null,
      exitPrice: null,
      quantity: input.quantity,
      pnl: null,
      openedAt: ts,
      closedAt: null,
      isBacktest: input.isBacktest ?? !!input.backtestRunId,
      backtestRunId: input.backtestRunId ?? null,
      metadata: input.metadata ?? {},
    };
    const trade = await db.transaction(async (tx) => {
      await tx.insert(schema.trades).values(values);
      await emitEvent(tx, {
        tradeId,
        action: 'OPEN',
        price: input.entryPrice,
        quantity: input.quantity,
        legs: input.legs,
        strategy: input.strategy,
        direction: input.direction,
        messageId: input.sourceMessageId,
        timestamp: ts,
      });
      const [row] = await tx.select().from(schema.trades).where(eq(schema.trades.id, tradeId));
      return row;
    });
    log.debug(`OPEN: ${input.direction} ${input.strategy} ${input.symbol} qty=${input.quantity} @$${input.entryPrice} [${tradeId.slice(0, 8)}]`);
    return { tradeId, action: 'OPEN', trade };
  }

  // ── Find existing open position for CLOSE/ADD/TRIM/LEG_OFF ──
  // Fast path: caller already identified the trade (pipeline does its own lookup).
  // Fallback: scope-filter query for callers that only know symbol/trader/strategy.
  const [existing] = input.tradeId
    ? await db.select().from(schema.trades).where(eq(schema.trades.id, input.tradeId))
    : await db.select().from(schema.trades).where(and(...scopeFilters)).limit(1);
  if (!existing) {
    log.debug(`${input.action}: no open position for ${input.symbol}/${input.trader}${input.backtestRunId ? ` run=${input.backtestRunId.slice(0, 8)}` : ''}`);
    return null;
  }

  // ── CLOSE: close the entire position ──
  if (input.action === 'CLOSE') {
    const exit = input.exitPrice;
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
    const ts = input.closedAt ?? now;

    const trade = await db.transaction(async (tx) => {
      await emitEvent(tx, {
        tradeId: existing.id,
        action: 'CLOSE',
        price: exit,
        quantity: qty,
        strategy: existing.strategy,
        direction: existing.direction,
        messageId: input.closeMessageId,
        timestamp: ts,
      });

      const mergedMetadata: TradeMetadata = {
        ...(existing.metadata ?? {}),
        ...(input.metadata ? input.metadata as TradeMetadata : {}),
      };

      await tx.update(schema.trades)
        .set({
          status: 'CLOSED',
          exitPrice: String(exit),
          pnl: String(totalPnl),
          closedAt: ts,
          closeMessageId: input.closeMessageId ?? null,
          ...(input.metadata ? { metadata: mergedMetadata } : {}),
        })
        .where(eq(schema.trades.id, existing.id));

      const [row] = await tx.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
      return row;
    });
    log.debug(`CLOSE: ${existing.symbol} exit=$${exit} closePnl=$${closePnl} realizedPnl=$${priorRealized} totalPnl=$${totalPnl} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'CLOSE', trade };
  }

  // ── ADD: increase quantity on existing position ──
  if (input.action === 'ADD') {
    const addQty = input.quantity;
    const addPrice = input.entryPrice ?? 0;
    const existingQty = tradeQty(existing.quantity);
    const existingPrice = safeParseFloat(existing.entryPrice);

    const totalQty = existingQty + addQty;
    const avgPrice = roundCents((existingPrice * existingQty + addPrice * addQty) / totalQty);
    const ts = input.openedAt ?? now;

    const trade = await db.transaction(async (tx) => {
      await emitEvent(tx, {
        tradeId: existing.id,
        action: 'ADD',
        price: addPrice,
        quantity: addQty,
        strategy: existing.strategy,
        direction: existing.direction,
        messageId: input.sourceMessageId,
        timestamp: ts,
      });

      await tx.update(schema.trades)
        .set({
          quantity: totalQty,
          entryPrice: String(avgPrice),
          avgEntryPrice: String(avgPrice),
        })
        .where(eq(schema.trades.id, existing.id));

      const [row] = await tx.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
      return row;
    });
    log.debug(`ADD: ${input.symbol} +${addQty} @$${addPrice} -> avg=$${avgPrice} totalQty=${totalQty} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'ADD', trade };
  }

  // ── TRIM: partial close — update position in place, accumulate realizedPnl ──
  if (input.action === 'TRIM') {
    const existingQty = tradeQty(existing.quantity);
    let trimQty = input.closeQuantity ?? (input.exitPercent
      ? Math.max(1, Math.floor(existingQty * input.exitPercent))
      : Math.max(1, Math.floor(existingQty * 0.5)));

    // Clamp to existing quantity
    if (trimQty > existingQty) {
      log.debug(`TRIM: clamping closeQuantity ${trimQty} -> ${existingQty}`);
      trimQty = existingQty;
    }

    const exit = input.exitPrice;
    const entry = safeParseFloat(existing.entryPrice);
    const trimPnl = computeTradePnl({
      entryPrice: entry, exitPrice: exit,
      direction: existing.direction as 'LONG' | 'SHORT',
      strategy: existing.strategy, quantity: trimQty,
    });
    const ts = input.closedAt ?? now;

    // Accumulate realized PnL from this trim
    const priorRealized = safeParseFloat(existing.realizedPnl);
    const newRealized = roundCents(priorRealized + trimPnl);
    const remainingQty = existingQty - trimQty;

    // Compute the actual exit percent for the event metadata.
    // Prefer caller-provided value; compute from quantities if absent.
    const actualExitPercent = input.exitPercent != null
      ? input.exitPercent
      : (existingQty > 0 ? trimQty / existingQty : null);

    const trade = await db.transaction(async (tx) => {
      await emitEvent(tx, {
        tradeId: existing.id,
        action: 'TRIM',
        price: exit,
        quantity: trimQty,
        strategy: existing.strategy,
        direction: existing.direction,
        messageId: input.closeMessageId,
        metadata: { exitPercent: actualExitPercent, trimPnl },
        timestamp: ts,
      });

      if (remainingQty <= 0) {
        // 100% trim = effectively a close
        await tx.update(schema.trades)
          .set({
            quantity: 0,
            status: 'CLOSED',
            realizedPnl: String(newRealized),
            pnl: String(newRealized),
            exitPrice: String(exit),
            closedAt: ts,
            closeMessageId: input.closeMessageId ?? null,
          })
          .where(eq(schema.trades.id, existing.id));
      } else {
        await tx.update(schema.trades)
          .set({
            quantity: remainingQty,
            realizedPnl: String(newRealized),
          })
          .where(eq(schema.trades.id, existing.id));
      }

      const [row] = await tx.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
      return row;
    });
    log.debug(`TRIM: ${input.symbol} -${trimQty}/${existingQty} @$${exit} trimPnl=$${trimPnl} realizedPnl=$${newRealized} remaining=${remainingQty} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'TRIM', trade };
  }

  // ── LEG_OFF: close one leg of a spread, mutate position in place ──
  // Not a new trade — the position stays open with a different shape.
  // OPEN CDS → LEG_OFF (mutate to CALL) → eventually CLOSE CALL. One trade row.
  if (input.action === 'LEG_OFF') {
    const exit = input.exitPrice;
    const entry = safeParseFloat(existing.entryPrice);

    const newEntryPrice = roundCents(entry + exit);
    const ts = input.closedAt ?? now;

    const trade = await db.transaction(async (tx) => {
      await emitEvent(tx, {
        tradeId: existing.id,
        action: 'LEG_OFF',
        price: exit,
        quantity: tradeQty(existing.quantity),
        legs: existing.legs,
        strategy: existing.strategy,
        direction: existing.direction,
        messageId: input.closeMessageId,
        metadata: { targetStrategy: input.targetStrategy, closedLeg: input.closedLeg, keptLeg: input.keptLeg },
        timestamp: ts,
      });

      await tx.update(schema.trades)
        .set({
          strategy: input.targetStrategy,
          legs: [input.keptLeg],
          entryPrice: String(newEntryPrice),
        })
        .where(eq(schema.trades.id, existing.id));

      const [row] = await tx.select().from(schema.trades).where(eq(schema.trades.id, existing.id));
      return row;
    });
    log.debug(`LEG_OFF: ${existing.strategy}→${input.targetStrategy} ${input.symbol} buyback=$${exit} newBasis=$${newEntryPrice} [${existing.id.slice(0, 8)}]`);
    return { tradeId: existing.id, action: 'LEG_OFF', trade };
  }

  return null;
}
