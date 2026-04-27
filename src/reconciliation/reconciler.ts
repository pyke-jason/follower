import { db, schema } from '../db/client.js';
import { eq, and } from 'drizzle-orm';
import type { BrokerService } from '../broker/interface.js';
import type { BrokerPosition } from '../broker/types.js';
import type { ReconciliationAlertType } from '../db/schema.js';
import { sendDiscordAlert } from './notify.js';
import { isOpen, forChannel } from '../trades/filters.js';
import { createLogger } from '../lib/logger.js';
import { tradeQty } from '../lib/trade.js';
import { extractUnderlying } from '../lib/occ-symbology.js';

const log = createLogger('Recon');

export type ReconciliationAlertInput = {
  type: ReconciliationAlertType;
  symbol: string;
  tradeId?: string;
  expected: unknown;
  actual: unknown;
};

type DbTrade = typeof schema.trades.$inferSelect;

/**
 * Auto-resolve alerts whose current broker+DB state no longer matches the
 * original discrepancy. Called with the same symbol maps the scan uses so
 * "is the alert still valid right now?" is a direct lookup.
 */
async function autoResolveAlerts(
  brokerBySymbol: Map<string, BrokerPosition[]>,
  dbBySymbol: Map<string, DbTrade[]>,
  channelId: string,
): Promise<void> {
  const unresolved = await db.select()
    .from(schema.reconciliationAlerts)
    .where(and(
      eq(schema.reconciliationAlerts.channelId, channelId),
      eq(schema.reconciliationAlerts.resolved, false),
    ));

  if (unresolved.length === 0) return;

  const now = new Date().toISOString();

  for (const alert of unresolved) {
    const brokerPos = brokerBySymbol.get(alert.symbol) ?? [];
    const dbTrades = dbBySymbol.get(alert.symbol) ?? [];
    let reason: string | null = null;

    if (alert.type === 'DB_ONLY') {
      if (alert.tradeId) {
        const trade = dbTrades.find((t) => t.id === alert.tradeId);
        if (!trade || trade.status !== 'OPEN') {
          reason = `Trade status changed to ${trade?.status ?? 'missing'}`;
        } else if (brokerPos.length > 0) {
          reason = `Broker position now exists for ${alert.symbol}`;
        }
      }
    } else if (alert.type === 'BROKER_ONLY') {
      if (brokerPos.length === 0) {
        reason = 'Broker position no longer exists';
      } else if (dbTrades.length > 0) {
        reason = 'DB now has matching open trade(s)';
      }
    } else if (alert.type === 'QUANTITY_MISMATCH') {
      if (brokerPos.length === 0 || dbTrades.length === 0) {
        reason = 'No longer both-sided';
      } else {
        const dbQty = dbTrades.reduce((s, t) => s + tradeQty(t.quantity), 0);
        const brokerQty = brokerPos.reduce((s, p) => s + Math.abs(p.quantity), 0);
        if (dbQty === brokerQty) reason = 'Quantities now match';
      }
    }

    if (reason) {
      await db.update(schema.reconciliationAlerts)
        .set({ resolved: true, resolvedAt: now, resolvedReason: reason })
        .where(eq(schema.reconciliationAlerts.id, alert.id));
      log.info(`Auto-resolved ${alert.type} alert for ${alert.symbol}: ${reason}`);
    }
  }
}

/**
 * Compare broker positions vs DB open trades and produce alerts
 * for any discrepancies.
 */
export async function runReconciliation(broker: BrokerService, channelId: string): Promise<ReconciliationAlertInput[]> {
  const allBrokerPositions = await broker.getPositions();
  const brokerPositions = allBrokerPositions.filter((p) => p.quantity !== 0);

  const dbTrades = await db.select()
    .from(schema.trades)
    .where(and(isOpen, forChannel(channelId)));

  const brokerBySymbol = new Map<string, BrokerPosition[]>();
  for (const pos of brokerPositions) {
    const underlying = extractUnderlying(pos.symbol);
    const existing = brokerBySymbol.get(underlying) ?? [];
    existing.push(pos);
    brokerBySymbol.set(underlying, existing);
  }

  const dbBySymbol = new Map<string, typeof dbTrades>();
  for (const trade of dbTrades) {
    const existing = dbBySymbol.get(trade.symbol) ?? [];
    existing.push(trade);
    dbBySymbol.set(trade.symbol, existing);
  }

  await autoResolveAlerts(brokerBySymbol, dbBySymbol, channelId);

  const alerts: ReconciliationAlertInput[] = [];

  // Check for DB_ONLY: trades we think are open but broker has no position
  for (const [symbol, trades] of dbBySymbol) {
    if (!brokerBySymbol.has(symbol)) {
      for (const trade of trades) {
        alerts.push({
          type: 'DB_ONLY',
          symbol,
          tradeId: trade.id,
          expected: { quantity: trade.quantity, direction: trade.direction, strategy: trade.strategy },
          actual: null,
        });
      }
    }
  }

  // Check for BROKER_ONLY: positions at broker not in our DB
  for (const [symbol, positions] of brokerBySymbol) {
    if (!dbBySymbol.has(symbol)) {
      for (const pos of positions) {
        alerts.push({
          type: 'BROKER_ONLY',
          symbol,
          expected: null,
          actual: { quantity: pos.quantity, averageCost: pos.averageCost, assetType: pos.assetType },
        });
      }
    }
  }

  // Check for QUANTITY_MISMATCH: both exist but quantities differ
  for (const [symbol, trades] of dbBySymbol) {
    const brokerPos = brokerBySymbol.get(symbol);
    if (!brokerPos) continue;

    const dbTotalQty = trades.reduce((sum, t) => sum + tradeQty(t.quantity), 0);
    const brokerTotalQty = brokerPos.reduce((sum, p) => sum + Math.abs(p.quantity), 0);

    if (dbTotalQty !== brokerTotalQty) {
      alerts.push({
        type: 'QUANTITY_MISMATCH',
        symbol,
        expected: { dbQuantity: dbTotalQty, trades: trades.map((t) => t.id) },
        actual: { brokerQuantity: brokerTotalQty, positions: brokerPos.length },
      });
    }
  }

  const existingUnresolved = await db.select({
    type: schema.reconciliationAlerts.type,
    symbol: schema.reconciliationAlerts.symbol,
    tradeId: schema.reconciliationAlerts.tradeId,
  })
    .from(schema.reconciliationAlerts)
    .where(and(
      eq(schema.reconciliationAlerts.channelId, channelId),
      eq(schema.reconciliationAlerts.resolved, false),
    ));

  const dedupKey = (type: string, symbol: string, tradeId: string | null) =>
    `${type}|${symbol}|${tradeId ?? ''}`;
  const existingKeys = new Set(existingUnresolved.map((a) => dedupKey(a.type, a.symbol, a.tradeId)));

  // Broker is source of truth: once a BROKER_ONLY drift has been resolved for a (symbol, quantity)
  // pair, suppress regenerated alerts for the same exact state. If the broker quantity changes,
  // a fresh alert still fires because the dedup key includes the quantity.
  const resolvedBrokerOnly = await db.select({
    symbol: schema.reconciliationAlerts.symbol,
    actual: schema.reconciliationAlerts.actual,
  })
    .from(schema.reconciliationAlerts)
    .where(and(
      eq(schema.reconciliationAlerts.channelId, channelId),
      eq(schema.reconciliationAlerts.type, 'BROKER_ONLY'),
      eq(schema.reconciliationAlerts.resolved, true),
    ));

  const ackedBrokerOnly = new Set<string>();
  for (const a of resolvedBrokerOnly) {
    const actual = a.actual as { quantity?: number } | null;
    if (actual?.quantity !== undefined) {
      ackedBrokerOnly.add(`${a.symbol}|${actual.quantity}`);
    }
  }

  const newAlerts = alerts.filter((a) => {
    if (existingKeys.has(dedupKey(a.type, a.symbol, a.tradeId ?? null))) return false;
    if (a.type === 'BROKER_ONLY') {
      const actualQty = (a.actual as { quantity?: number } | null)?.quantity;
      if (actualQty !== undefined && ackedBrokerOnly.has(`${a.symbol}|${actualQty}`)) return false;
    }
    return true;
  });
  const suppressed = alerts.length - newAlerts.length;

  if (newAlerts.length > 0) {
    await db.insert(schema.reconciliationAlerts).values(
      newAlerts.map((a) => ({ channelId, ...a, tradeId: a.tradeId ?? null })),
    );

    for (const alert of newAlerts) {
      log.warn(`${alert.type}: ${alert.symbol}`, alert);
    }

    sendDiscordAlert(newAlerts).catch((err) => log.warn('Discord alert failed:', err));
  }

  if (suppressed > 0) {
    log.info(`Suppressed ${suppressed} duplicate alert(s) already unresolved`);
  }
  if (alerts.length === 0) {
    log.info('No discrepancies found');
  }

  return newAlerts;
}


