/**
 * Broker-level stop order lifecycle helpers.
 *
 * These sit between the pipeline/reconciler and the broker:
 *   placeTradeStop          — place a GTC stop at IBKR and stamp stopOrderId on the trade
 *   cancelTradeStop         — cancel the stop at IBKR and clear stopOrderId
 *   cancelAndReplaceStop    — for TRIM: cancel old stop, re-place at remaining quantity
 *
 * Both are idempotent: if the stop is already gone they silently succeed.
 */

import { db, schema, runTx } from '../db/client.js';
import { eq } from 'drizzle-orm';
import type { BrokerService } from '../broker/interface.js';
import type { OrderLeg, StopOrderParams } from '../broker/types.js';
import type { Direction, Strategy } from '../lib/enums.js';
import type { TradeMetadata } from '../db/schema.js';
import { computeStopParams, isStopSupportedStrategy } from '../config/stop-defaults.js';
import { safeParseFloat } from '../lib/numbers.js';
import { tradeQty } from '../lib/trade.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('StopOrders');

/** Place a stop at the broker and record its orderId in trade metadata. */
export async function placeTradeStop(
  tradeId: string,
  broker: BrokerService,
  params: StopOrderParams,
): Promise<string> {
  const result = await broker.placeStopOrder(params);
  const stopOrderId = result.orderId;

  await runTx(async (tx) => {
    const [row] = await tx
      .select({ metadata: schema.trades.metadata })
      .from(schema.trades)
      .where(eq(schema.trades.id, tradeId))
      .limit(1);
    if (!row) return;
    await tx
      .update(schema.trades)
      .set({ metadata: { ...row.metadata, stopOrderId } satisfies TradeMetadata })
      .where(eq(schema.trades.id, tradeId));
  });

  log.info(`Stop placed: orderId=${stopOrderId} strategy=${params.strategy} stopPrice=${params.stopPrice}${params.limitPrice != null ? ` limitPrice=${params.limitPrice}` : ''} tradeId=${tradeId}`);
  return stopOrderId;
}

/**
 * Cancel an existing stop at the broker and clear stopOrderId from trade metadata.
 * Safe to call when no stop exists — returns without error.
 */
export async function cancelTradeStop(tradeId: string, broker: BrokerService): Promise<void> {
  // Read current stopOrderId
  const [row] = await db
    .select({ metadata: schema.trades.metadata })
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId))
    .limit(1);

  const stopOrderId = row?.metadata?.stopOrderId;
  if (!stopOrderId) return;

  try {
    await broker.cancelOrder(stopOrderId);
    log.info(`Stop cancelled: orderId=${stopOrderId} tradeId=${tradeId}`);
  } catch (err) {
    // Already filled/cancelled at broker — not an error; clear our record anyway
    log.warn(`Stop cancel non-fatal: orderId=${stopOrderId} tradeId=${tradeId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Clear stopOrderId from metadata regardless of cancel outcome
  await runTx(async (tx) => {
    const [r] = await tx
      .select({ metadata: schema.trades.metadata })
      .from(schema.trades)
      .where(eq(schema.trades.id, tradeId))
      .limit(1);
    if (!r) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { stopOrderId: _removed, ...rest } = r.metadata;
    await tx
      .update(schema.trades)
      .set({ metadata: rest satisfies TradeMetadata })
      .where(eq(schema.trades.id, tradeId));
  });
}

/**
 * For TRIM: cancel the existing stop then re-place at the remaining position size.
 * Reads the trade from DB after cancellation to get the current remaining quantity.
 * If the trade is fully closed (shouldn't happen on TRIM path), skips re-placement.
 */
export async function cancelAndReplaceStop(
  tradeId: string,
  broker: BrokerService,
  strategy: Strategy,
  direction: Direction,
): Promise<void> {
  await cancelTradeStop(tradeId, broker);

  if (!isStopSupportedStrategy(strategy)) return;

  // Re-read trade after the TRIM record has been committed
  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId))
    .limit(1);

  if (!trade || trade.status !== 'OPEN') return;

  const entryPrice = safeParseFloat(trade.entryPrice ?? '');
  if (!entryPrice || entryPrice <= 0) {
    log.warn(`cancelAndReplaceStop: no valid entryPrice on trade ${tradeId} — skipping re-placement`);
    return;
  }

  const remainingQty = tradeQty(trade.quantity);
  if (remainingQty <= 0) return;

  // Reconstruct legs as OrderLeg (strip fillPrice which is optional anyway)
  const legs: OrderLeg[] = trade.legs.map(({ fillPrice: _fp, ...l }) => l);

  const stopParams = computeStopParams(strategy, direction, entryPrice, legs, remainingQty);
  if (!stopParams) return;

  await placeTradeStop(tradeId, broker, stopParams);
}
