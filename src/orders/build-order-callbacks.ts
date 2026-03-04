/**
 * Shared OrderManager callback builder.
 *
 * Both the live runner and backtest runner wire identical onFill/onCancel/onAdjust
 * callbacks that look up the pending intent, emit events, and record fills.
 * This factory extracts that ~50-line pattern into one place.
 *
 * Orphan fill/cancel handling (DB insert + logging) is shared — the only
 * runner-specific concern is operational alerting (live sends Pushover/Discord,
 * backtest does not).
 */

import type { OrderManagerConfig } from './order-manager.js';
import type { ResolvedPendingContext } from '../pipeline/execute-resolved.js';
import type { SignalEventEmitter } from '../decisions/emitter.js';
import type { FilledWorkingOrder, WorkingOrder } from '../broker/types.js';
import { db, schema } from '../db/client.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('OrderCallbacks');

export type CallbackDeps = {
  pendingIntents: Map<string, ResolvedPendingContext>;
  createScopedEmitter: (messageId: string, taskId?: string) => SignalEventEmitter;
  clock: () => Date;
  /** Scoping fields written to orphan_fills for attribution. */
  scope: { taskId?: string; channelId?: string };
  /** Optional operational alerting (live sends Pushover/Discord, backtest omits). */
  sendAlert?: (params: { title: string; message: string; severity: 'critical' | 'warning' }) => Promise<void>;
};

export function buildOrderCallbacks(
  deps: CallbackDeps,
): Pick<OrderManagerConfig, 'onFill' | 'onCancel' | 'onAdjust'> {
  const { pendingIntents, createScopedEmitter } = deps;

  return {
    onFill: async (order) => {
      const pending = pendingIntents.get(order.orderId);
      if (!pending) {
        log.error(`ORPHAN FILL: orderId=${order.orderId} symbol=${order.params.symbol} strategy=${order.params.strategy} filled@${order.filledPrice} qty=${order.filledQuantity}`);
        await db.insert(schema.orphanFills).values({
          orderId: order.orderId,
          symbol: order.params.symbol,
          strategy: order.params.strategy,
          direction: order.params.direction,
          filledPrice: order.filledPrice,
          filledAt: order.filledAt.toISOString(),
          filledQuantity: order.filledQuantity ?? null,
          commission: order.commission ?? null,
          legs: JSON.stringify(order.params.legs),
          rawOrder: JSON.stringify(order),
          detectedAt: deps.clock().toISOString(),
          ...deps.scope,
        }).onConflictDoNothing();
        await deps.sendAlert?.({
          title: 'ORPHAN FILL — Position at broker with no DB record',
          message: `Order ${order.orderId}: ${order.params.direction} ${order.params.strategy} ${order.params.symbol} filled @ $${order.filledPrice} qty=${order.filledQuantity}. Written to orphan_fills. Manual reconciliation required.`,
          severity: 'critical',
        });
        return;
      }
      pendingIntents.delete(order.orderId);
      const emitter = createScopedEmitter(pending.messageId ?? '', pending.taskId);
      await emitter.emit('ORDER_FILLED', {
        orderId: order.orderId,
        symbol: order.params.symbol,
        strategy: order.params.strategy,
        direction: order.params.direction,
        filledPrice: order.filledPrice,
        filledAt: order.filledAt.toISOString(),
        filledQuantity: order.filledQuantity,
        commission: order.commission,
        legFills: order.legFills,
        adjustmentCount: order.adjustmentCount,
        originalLimitPrice: order.params.limitPrice,
        immediatelyFilled: false,
      }, { signalIndex: pending.signalIndex ?? null });
      await pending.recordFill(order.filledPrice, order.filledAt);
    },

    onCancel: async (order) => {
      const pending = pendingIntents.get(order.orderId);
      if (!pending) {
        log.warn(`Orphan cancel: orderId=${order.orderId} symbol=${order.params.symbol}`);
        await deps.sendAlert?.({
          title: 'Orphan cancel — order cancelled with no pending intent',
          message: `Order ${order.orderId}: ${order.params.symbol}. State desync detected.`,
          severity: 'warning',
        });
        return;
      }
      const emitter = createScopedEmitter(pending.messageId ?? '', pending.taskId);
      await emitter.emit('ORDER_CANCELLED', {
        orderId: order.orderId,
        symbol: order.params.symbol,
        strategy: order.params.strategy,
        direction: order.params.direction,
        originalLimitPrice: order.params.limitPrice,
        finalLimitPrice: order.currentLimitPrice,
        adjustmentCount: order.adjustmentCount,
        reason: order.status,
        placedAt: order.placedAt.toISOString(),
      }, { signalIndex: pending.signalIndex ?? null, tradeId: pending.tradeId ?? null });
      pendingIntents.delete(order.orderId);
    },

    onAdjust: async (order, fromPrice, toPrice, step) => {
      const pending = pendingIntents.get(order.orderId);
      if (!pending) {
        log.warn(`onAdjust: no pendingIntent for orderId=${order.orderId} — adjustment untracked`);
        return;
      }
      const emitter = createScopedEmitter(pending.messageId ?? '', pending.taskId);
      await emitter.emit('ORDER_ADJUSTED', {
        orderId: order.orderId, fromPrice, toPrice, step,
      }, { signalIndex: pending.signalIndex ?? null });
    },
  };
}
