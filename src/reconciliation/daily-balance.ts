import { db, schema } from '../db/client.js';
import { and, eq } from 'drizzle-orm';
import type { BrokerService } from '../broker/interface.js';
import { safeParseFloat } from '../lib/numbers.js';
import { createLogger } from '../lib/logger.js';
import { toDateKeyET } from '../lib/et-date.js';

const log = createLogger('Balance');

/**
 * Capture today's starting balance from the broker.
 * Only inserts once per trading day (idempotent).
 */
export async function captureStartingBalance(
  broker: BrokerService,
  channelId: string,
): Promise<void> {
  const today = toDateKeyET(new Date());

  // Check if we already have a row for today
  const existing = await db.select()
    .from(schema.dailyBalances)
    .where(and(
      eq(schema.dailyBalances.date, today),
      eq(schema.dailyBalances.channelId, channelId),
    ))
    .limit(1);

  if (existing.length > 0) {
    log.debug(`Already captured for ${today}`);
    return;
  }

  const balance = await broker.getAccountBalance();

  await db.insert(schema.dailyBalances).values({
    channelId,
    date: today,
    cashBalance: String(balance.cashBalance),
    buyingPower: String(balance.buyingPower),
    equity: String(balance.equity),
    marketValue: String(balance.marketValue),
    unrealizedPnl: String(balance.unrealizedPnl),
    realizedPnl: String(balance.realizedPnl),
  });

  log.info(`[${channelId}] Captured for ${today}: equity=${balance.equity}, buyingPower=${balance.buyingPower}`);
}

export async function getTodayStartingBalance(channelId: string): Promise<{
  equity: number;
  buyingPower: number;
  cashBalance: number;
} | null> {
  const today = toDateKeyET(new Date());

  const [row] = await db.select()
    .from(schema.dailyBalances)
    .where(and(
      eq(schema.dailyBalances.date, today),
      eq(schema.dailyBalances.channelId, channelId),
    ))
    .limit(1);

  if (!row) return null;

  return {
    equity: safeParseFloat(row.equity),
    buyingPower: safeParseFloat(row.buyingPower),
    cashBalance: safeParseFloat(row.cashBalance),
  };
}
