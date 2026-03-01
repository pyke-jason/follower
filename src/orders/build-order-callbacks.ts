/**
 * Shared OrderManager callback builder.
 *
 * Both the live runner and backtest runner wire identical onFill/onCancel/onAdjust
 * callbacks that look up the pending intent, emit events, and record fills.
 * This factory extracts that ~50-line pattern into one place.
 *
 * The caller owns the `pendingIntents` map and the emitter scope — this module
 * only closes over them.
 */

import type { OrderManagerConfig } from './order-manager.js';
import type { ResolvedPendingContext } from '../pipeline/execute-resolved.js';
import type { SignalEventEmitter } from '../decisions/emitter.js';

type CallbackDeps = {
  pendingIntents: Map<string, ResolvedPendingContext>;
  createScopedEmitter: (messageId: string) => SignalEventEmitter;
};

export function buildOrderCallbacks(
  deps: CallbackDeps,
): Pick<OrderManagerConfig, 'onFill' | 'onCancel' | 'onAdjust'> {
  const { pendingIntents, createScopedEmitter } = deps;

  return {
    onFill: async (order) => {
      const pending = pendingIntents.get(order.orderId);
      if (!pending) return;
      pendingIntents.delete(order.orderId);
      const emitter = createScopedEmitter(pending.messageId ?? '');
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
      if (pending) {
        const emitter = createScopedEmitter(pending.messageId ?? '');
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
      }
      pendingIntents.delete(order.orderId);
    },

    onAdjust: async (order, fromPrice, toPrice, step) => {
      const pending = pendingIntents.get(order.orderId);
      if (!pending) return;
      const emitter = createScopedEmitter(pending.messageId ?? '');
      await emitter.emit('ORDER_ADJUSTED', {
        orderId: order.orderId, fromPrice, toPrice, step,
      }, { signalIndex: pending.signalIndex ?? null });
    },
  };
}
