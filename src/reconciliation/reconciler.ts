import { db, schema } from '../db/client.js';
import { eq, and } from 'drizzle-orm';
import type { BrokerService } from '../broker/interface.js';
import type { BrokerPosition } from '../broker/types.js';
import type { ReconciliationAlertType } from '../db/schema.js';
import { sendDiscordAlert } from './notify.js';

export type ReconciliationAlertInput = {
  type: ReconciliationAlertType;
  symbol: string;
  tradeId?: string;
  expected: unknown;
  actual: unknown;
};

/**
 * Compare broker positions vs DB open trades and produce alerts
 * for any discrepancies.
 */
export async function runReconciliation(broker: BrokerService): Promise<ReconciliationAlertInput[]> {
  const brokerPositions = await broker.getPositions();
  const dbTrades = await db.select()
    .from(schema.trades)
    .where(and(
      eq(schema.trades.status, 'OPEN'),
      eq(schema.trades.isBacktest, false),
    ));

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

    const dbTotalQty = trades.reduce((sum, t) => sum + (t.quantity ?? 1), 0);
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
      console.warn(`[RECON] ${alert.type}: ${alert.symbol}`, alert);
    }

    // Send Discord notification (non-blocking, non-fatal)
    sendDiscordAlert(alerts).catch((err) => console.warn('Discord alert failed:', err));
  } else {
    console.log('[RECON] No discrepancies found');
  }

  return alerts;
}

/**
 * Extract the underlying symbol from an OCC option symbol or pass through.
 * OCC format: "SPY   250214C00500000" -> "SPY"
 */
function extractUnderlying(symbol: string): string {
  // If symbol has spaces (OCC format), extract the underlying
  const trimmed = symbol.trim();
  if (trimmed.length > 6 && /\d{6}[CP]\d{8}/.test(trimmed.replace(/\s/g, ''))) {
    return trimmed.split(/\s/)[0].trim();
  }
  return trimmed;
}
