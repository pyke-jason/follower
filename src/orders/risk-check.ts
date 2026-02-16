import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import { getTodayStartingBalance } from '../reconciliation/daily-balance.js';
import type { RiskCheckResult } from '../agent/tool-factory.js';
import { safeParseFloat } from '../lib/numbers.js';

export type RiskCheckInput = {
  symbol: string;
  strategy: string;
  trader: string;
  maxRisk?: number;
};

/**
 * Shared live risk-check: queries the DB for trader config, daily PnL,
 * open positions, drawdown, and reconciliation alerts.
 */
export async function checkRiskLimits(input: RiskCheckInput): Promise<RiskCheckResult> {
  const todayPnl = await db.select({
    total: sql<string>`COALESCE(SUM(CAST(pnl AS REAL)), 0)`,
  })
    .from(schema.trades)
    .where(and(
      eq(schema.trades.trader, input.trader),
      sql`opened_at >= date('now')`,
    ));

  const openPositions = await db.select({
    count: sql<number>`COUNT(*)`,
  })
    .from(schema.trades)
    .where(and(
      eq(schema.trades.symbol, input.symbol),
      eq(schema.trades.status, 'OPEN'),
    ));

  const dailyPnl = safeParseFloat(todayPnl[0]?.total);

  const startingBalance = await getTodayStartingBalance();
  let currentDrawdownPct: number | undefined;
  let drawdownBlocked = false;
  if (startingBalance && startingBalance.equity > 0) {
    currentDrawdownPct = Math.round((Math.abs(dailyPnl) / startingBalance.equity) * 10000) / 100;
    const maxDrawdownPct = 5; // 5% default
    if (currentDrawdownPct >= maxDrawdownPct) {
      drawdownBlocked = true;
    }
  }

  // Check for unresolved reconciliation alerts (DB_ONLY = dangerous)
  const unresolvedAlerts = await db.select({
    count: sql<number>`COUNT(*)`,
  })
    .from(schema.reconciliationAlerts)
    .where(and(
      eq(schema.reconciliationAlerts.resolved, false),
      eq(schema.reconciliationAlerts.type, 'DB_ONLY'),
    ));
  const alertCount = unresolvedAlerts[0]?.count ?? 0;

  // Total open positions across all symbols
  const totalOpen = await db.select({ count: sql<number>`COUNT(*)` })
    .from(schema.trades)
    .where(and(
      eq(schema.trades.trader, input.trader),
      eq(schema.trades.status, 'OPEN'),
      eq(schema.trades.isBacktest, false),
    ));
  const totalOpenCount = totalOpen[0]?.count ?? 0;
  const MAX_TOTAL_POSITIONS = 20;
  const totalPositionBlocked = totalOpenCount >= MAX_TOTAL_POSITIONS;

  const allowed = (
    (openPositions[0]?.count ?? 0) < 5 &&
    !totalPositionBlocked &&
    !drawdownBlocked &&
    alertCount === 0
  );

  const reason = totalPositionBlocked
    ? `Total open positions (${totalOpenCount}) exceeds max (${MAX_TOTAL_POSITIONS})`
    : drawdownBlocked
      ? `Drawdown limit exceeded (${currentDrawdownPct}%)`
      : alertCount > 0
        ? `${alertCount} unresolved DB_ONLY reconciliation alert(s)`
        : undefined;

  return {
    allowed,
    reason,
    traderDailyPnl: dailyPnl,
    openPositionsOnSymbol: openPositions[0]?.count ?? 0,
    startingEquity: startingBalance?.equity,
    currentDrawdownPct,
    buyingPower: startingBalance?.buyingPower,
    reconciliationAlerts: alertCount,
    totalOpenPositions: totalOpenCount,
    maxTotalPositions: MAX_TOTAL_POSITIONS,
  };
}
