import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import type { BrokerService } from '../broker/interface.js';

/**
 * Capture today's starting balance from the broker.
 * Only inserts once per trading day (idempotent).
 */
export async function captureStartingBalance(broker: BrokerService): Promise<void> {
  const today = new Date().toISOString().split('T')[0];

  // Check if we already have a row for today
  const existing = await db.select()
    .from(schema.dailyBalances)
    .where(eq(schema.dailyBalances.date, today))
    .limit(1);

  if (existing.length > 0) {
    console.log(`Daily balance already captured for ${today}`);
    return;
  }

  const balance = await broker.getAccountBalance();

  await db.insert(schema.dailyBalances).values({
    date: today,
    cashBalance: String(balance.cashBalance),
    buyingPower: String(balance.buyingPower),
    equity: String(balance.equity),
    marketValue: String(balance.marketValue),
    unrealizedPnl: String(balance.unrealizedPnl),
    realizedPnl: String(balance.realizedPnl),
  });

  console.log(`Daily balance captured for ${today}: equity=${balance.equity}, buyingPower=${balance.buyingPower}`);
}

/**
 * Get today's starting balance from the DB.
 * Returns null if not yet captured (e.g. during backtesting).
 */
export async function getTodayStartingBalance(): Promise<{
  equity: number;
  buyingPower: number;
  cashBalance: number;
} | null> {
  const today = new Date().toISOString().split('T')[0];

  const [row] = await db.select()
    .from(schema.dailyBalances)
    .where(eq(schema.dailyBalances.date, today))
    .limit(1);

  if (!row) return null;

  return {
    equity: parseFloat(row.equity),
    buyingPower: parseFloat(row.buyingPower),
    cashBalance: parseFloat(row.cashBalance),
  };
}
