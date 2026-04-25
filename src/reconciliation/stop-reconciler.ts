/**
 * Startup stop reconciliation.
 *
 * On bot (re)start: scan all open DB trades for the channel and ensure each
 * has a live GTC stop order at IBKR. If the stop order is missing or gone
 * (e.g. bot was kill-9'd after entry filled but before stop was placed, or
 * the stop filled/was cancelled unexpectedly), place a new one.
 *
 * This is a one-shot guard run at startup, not a recurring poll.
 * The recurring reconciler (reconciler.ts) handles position-level mismatches.
 *
 * Default stop levels used when re-placing (same as live placement):
 *   STOCK  LONG/SHORT : 5% from entry
 *   OPTION LONG       : 50% loss of premium
 *   OPTION SHORT      : 3× received premium
 *   Spreads           : skipped (not yet supported)
 */

import { db, schema } from '../db/client.js';
import { and } from 'drizzle-orm';
import type { BrokerService } from '../broker/interface.js';
import type { OrderLeg } from '../broker/types.js';
import type { Direction, Strategy } from '../lib/enums.js';
import { isOpen, forChannel } from '../trades/filters.js';
import { computeStopParams, isStopSupportedStrategy } from '../config/stop-defaults.js';
import { placeTradeStop } from '../trades/stop-orders.js';
import { safeParseFloat } from '../lib/numbers.js';
import { tradeQty } from '../lib/trade.js';
import { createLogger } from '../lib/logger.js';
import { sendSystemAlert } from '../lib/alert.js';

const log = createLogger('StopRecon');

/**
 * Reconcile server-side stop orders for all open trades on a channel.
 * Runs at startup and is non-fatal: failures are logged and alerted but
 * do not prevent the bot from starting.
 */
export async function reconcileStops(broker: BrokerService, channelId: string): Promise<void> {
  log.info(`Reconciling stops for channel ${channelId}`);

  const openTrades = await db
    .select()
    .from(schema.trades)
    .where(and(isOpen, forChannel(channelId)));

  if (openTrades.length === 0) {
    log.info('No open trades — nothing to reconcile');
    return;
  }

  log.info(`Checking ${openTrades.length} open trade(s) for active stops`);

  let placed = 0;
  let skipped = 0;
  let failed = 0;

  for (const trade of openTrades) {
    const strategy = trade.strategy as Strategy;
    const direction = trade.direction as Direction;

    if (!isStopSupportedStrategy(strategy)) {
      log.info(`Skip stop reconcile: trade ${trade.id} strategy=${strategy} (not supported)`);
      skipped++;
      continue;
    }

    // Check whether the existing stop is still live at the broker
    const existingStopId = trade.metadata?.stopOrderId;
    if (existingStopId) {
      try {
        const status = await broker.getOrderStatus(existingStopId);
        if (status.status === 'OPEN' || status.status === 'PENDING') {
          log.info(`Stop alive: orderId=${existingStopId} trade=${trade.id}`);
          continue; // already protected
        }
        log.warn(`Stop ${existingStopId} for trade ${trade.id} is ${status.status} — re-placing`);
      } catch {
        log.warn(`Stop ${existingStopId} for trade ${trade.id} not found at broker — re-placing`);
      }
    } else {
      log.warn(`Trade ${trade.id} (${strategy} ${direction} ${trade.symbol}) has no stop — placing`);
    }

    // Derive stop params from the trade's recorded entry price and legs
    const entryPrice = safeParseFloat(trade.entryPrice ?? '');
    if (!entryPrice || entryPrice <= 0) {
      log.warn(`Cannot place stop for trade ${trade.id}: invalid entryPrice="${trade.entryPrice}"`);
      failed++;
      continue;
    }

    const remainingQty = tradeQty(trade.quantity);
    if (remainingQty <= 0) {
      log.warn(`Cannot place stop for trade ${trade.id}: quantity=${trade.quantity}`);
      failed++;
      continue;
    }

    const legs: OrderLeg[] = trade.legs.map(({ fillPrice: _fp, ...l }) => l);
    const stopParams = computeStopParams(strategy, direction, entryPrice, legs, remainingQty);
    if (!stopParams) {
      log.warn(`No stop params for trade ${trade.id} strategy=${strategy}`);
      skipped++;
      continue;
    }

    try {
      await placeTradeStop(trade.id, broker, stopParams);
      placed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to place startup stop for trade ${trade.id}: ${msg}`);
      failed++;
      void sendSystemAlert({
        title: 'Startup stop placement failed',
        message: `Trade ${trade.id} (${strategy} ${direction} ${trade.symbol}) has no server-side stop after reconciliation: ${msg}`,
        severity: 'critical',
      });
    }
  }

  log.info(`Stop reconciliation complete: placed=${placed} skipped=${skipped} failed=${failed}`);

  if (failed > 0) {
    void sendSystemAlert({
      title: `${failed} trade(s) without server-side stops`,
      message: `Stop reconciliation placed=${placed} failed=${failed} — check logs. Positions may be unprotected.`,
      severity: 'critical',
    });
  }
}
