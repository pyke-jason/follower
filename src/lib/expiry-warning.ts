/**
 * Layer 3 Safety Net: Warn when positions approach expiration
 * without a close signal.
 *
 * LIVE MODE: Sends Discord/Pushover alerts on a schedule.
 * BACKTEST: Logs at info level before sweepExpired runs.
 */

import type { Trade } from '../db/schema.js';

import { sendSystemAlert } from './alert.js';
import { toDateKeyET, getNextTradingDayKey, getETMinuteOfDay } from './et-date.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ExpiryWarning');

type ExpiryBucket = 'TODAY' | 'TOMORROW';

/** Throttle: max 1 alert per trade per bucket per day. */
const alertThrottle = new Map<string, string>();

function isThrottled(tradeId: string, bucket: ExpiryBucket): boolean {
  const key = `${tradeId}:${bucket}`;
  const today = toDateKeyET(new Date());
  if (alertThrottle.get(key) === today) return true;
  alertThrottle.set(key, today);
  return false;
}

/** Get the earliest option expiry from a trade's legs. Returns null for STOCK. */
function getEarliestExpiry(trade: Trade): string | null {
  if (!trade.legs.length) return null;
  let earliest: string | null = null;
  for (const leg of trade.legs) {
    if (!leg.expiry) continue;
    if (!earliest || leg.expiry < earliest) earliest = leg.expiry;
  }
  return earliest;
}

type ExpiringPosition = {
  trade: Trade;
  expiry: string;
  bucket: ExpiryBucket;
};

/**
 * Check open positions for near-expiry conditions and send alerts.
 * Call from the live runner's polling loop.
 *
 * Timing:
 * - EXPIRING TODAY: alerts after 9:00 ET
 * - EXPIRING TOMORROW: alerts after 14:00 ET
 */
export async function checkExpiryWarnings(
  getOpenPositions: () => Promise<Trade[]>,
): Promise<void> {
  const now = new Date();
  const minuteOfDay = getETMinuteOfDay(now);
  const today = toDateKeyET(now);
  const tomorrow = getNextTradingDayKey(today);

  // Only check during market-relevant hours (9:00 AM - 5:00 PM ET)
  if (minuteOfDay < 540 || minuteOfDay > 1020) return;

  const positions = await getOpenPositions();
  if (positions.length === 0) return;

  const expiring: ExpiringPosition[] = [];

  for (const trade of positions) {
    if (trade.strategy === 'STOCK') continue;
    const expiry = getEarliestExpiry(trade);
    if (!expiry) continue;

    if (expiry === today && minuteOfDay >= 540) {
      expiring.push({ trade, expiry, bucket: 'TODAY' });
    } else if (expiry === tomorrow && minuteOfDay >= 840) {
      expiring.push({ trade, expiry, bucket: 'TOMORROW' });
    }
  }

  for (const { trade, expiry, bucket } of expiring) {
    if (isThrottled(trade.id, bucket)) continue;

    const severity = bucket === 'TODAY' ? 'critical' : 'warning';

    await sendSystemAlert({
      title: `Position expiring ${bucket === 'TODAY' ? 'today' : 'tomorrow'}`,
      message: `${trade.trader}'s ${trade.symbol} ${trade.strategy} expires ${expiry} with no close signal`,
      severity,
      fields: [
        { name: 'Trader', value: trade.trader, inline: true },
        { name: 'Symbol', value: trade.symbol, inline: true },
        { name: 'Strategy', value: trade.strategy ?? 'unknown', inline: true },
        { name: 'Expiry', value: expiry, inline: true },
        { name: 'Entry Price', value: String(trade.entryPrice), inline: true },
        { name: 'Quantity', value: String(trade.quantity), inline: true },
        { name: 'Opened', value: trade.openedAt ?? 'unknown', inline: true },
      ],
    });
  }
}

/**
 * Backtest variant: log positions about to be swept by sweepExpired.
 * Call BEFORE sweepExpired runs at day boundaries.
 */
export function logExpiryNotices(
  openPositions: Trade[],
  sweepThroughDate: string,
): void {
  for (const trade of openPositions) {
    if (trade.strategy === 'STOCK') continue;
    const expiry = getEarliestExpiry(trade);
    if (!expiry) continue;
    if (expiry <= sweepThroughDate) {
      log.info(
        `[EXPIRY-NOTICE] ${trade.symbol} ${trade.strategy} x${trade.quantity} (trader: ${trade.trader}) expires ${expiry}, no close signal received`,
      );
    }
  }
}
