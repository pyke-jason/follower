import { db, schema } from '../db/client.js';
import { eq, and } from 'drizzle-orm';
import type { BrokerService } from '../broker/interface.js';
import type { BrokerPosition } from '../broker/types.js';
import type { ReconciliationAlertType } from '../db/schema.js';
import { sendDiscordAlert } from './notify.js';
import { isOpen, notBacktest } from '../trades/filters.js';
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

/**
 * Auto-resolve stale reconciliation alerts that are no longer valid.
 * Runs before the comparison logic using the already-fetched broker positions.
 */
async function autoResolveAlerts(brokerPositions: BrokerPosition[]): Promise<void> {
  const unresolved = await db.select()
    .from(schema.reconciliationAlerts)
    .where(eq(schema.reconciliationAlerts.resolved, false));

  if (unresolved.length === 0) return;

  const brokerSymbols = new Set(brokerPositions.map(p => extractUnderlying(p.symbol)));
  const now = new Date().toISOString();

  for (const alert of unresolved) {
    let reason: string | null = null;

    if (alert.type === 'DB_ONLY') {
      // Trade in DB, not at broker — blocks all trading
      if (alert.tradeId) {
        const trades = await db.select()
          .from(schema.trades)
          .where(eq(schema.trades.id, alert.tradeId))
          .limit(1);
        const trade = trades[0];

        if (trade && trade.status !== 'OPEN') {
          reason = `Trade status changed to ${trade.status}`;
        } else if (brokerSymbols.has(alert.symbol)) {
          reason = `Broker position now exists for ${alert.symbol}`;
        }
      }
    } else if (alert.type === 'BROKER_ONLY') {
      // Position at broker, not in DB
      if (!brokerSymbols.has(alert.symbol)) {
        reason = 'Broker position no longer exists';
      }
    } else if (alert.type === 'QUANTITY_MISMATCH') {
      // Auto-resolve after 24 hours (will be re-raised if still relevant)
      const alertAge = Date.now() - new Date(alert.createdAt!).getTime();
      if (alertAge > 24 * 60 * 60 * 1000) {
        reason = 'Alert expired (will be re-raised if still relevant)';
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
export async function runReconciliation(broker: BrokerService): Promise<ReconciliationAlertInput[]> {
  const brokerPositions = await broker.getPositions();

  // Auto-resolve stale alerts before running comparison
  await autoResolveAlerts(brokerPositions);

  const dbTrades = await db.select()
    .from(schema.trades)
    .where(and(isOpen, notBacktest));

  const alerts: ReconciliationAlertInput[] = [];

  // Build lookup maps by underlying symbol
  const brokerBySymbol = new Map<string, BrokerPosition[]>();
  for (const pos of brokerPositions) {
    // Extract underlying symbol (e.g. from OCC option symbol or direct)
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

  // Persist alerts to DB
  if (alerts.length > 0) {
    await db.insert(schema.reconciliationAlerts).values(
      alerts.map((a) => ({
        type: a.type,
        symbol: a.symbol,
        tradeId: a.tradeId ?? null,
        expected: a.expected,
        actual: a.actual,
      })),
    );

    for (const alert of alerts) {
      log.warn(`${alert.type}: ${alert.symbol}`, alert);
    }

    // Send Discord notification (non-blocking, non-fatal)
    sendDiscordAlert(alerts).catch((err) => log.warn('Discord alert failed:', err));
  } else {
    log.info('No discrepancies found');
  }

  return alerts;
}


