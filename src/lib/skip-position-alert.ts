/**
 * Layer 2 Safety Net: Alert when LLM skips a message for a symbol
 * where the trader has an active open position.
 *
 * LIVE MODE ONLY. Async fire-and-forget — never blocks the pipeline.
 */

import type { Trade, TradeLeg, TaskContext } from '../db/schema.js';
import type { PrefetchedData } from '../agent/prefetch.js';
import { sendSystemAlert } from './alert.js';
import { toDateKeyET } from './et-date.js';
import { getNextTradingDayKey } from './et-date.js';

type SkipAlertInput = {
  context: TaskContext;
  prefetched: PrefetchedData | undefined;
  skipReason: string;
  messageId: string;
  taskId: string;
};

/** Throttle: max 1 alert per trader+symbol per calendar day (ET). */
const alertThrottle = new Map<string, string>();

function isThrottled(trader: string, symbol: string): boolean {
  const key = `${trader}:${symbol}`;
  const today = toDateKeyET(new Date());
  if (alertThrottle.get(key) === today) return true;
  alertThrottle.set(key, today);
  return false;
}

/**
 * Check if any matching position has legs expiring within 2 trading days.
 */
function hasNearExpiryLegs(positions: Trade[], now: Date): boolean {
  const today = toDateKeyET(now);
  const tomorrow = getNextTradingDayKey(today);
  const dayAfter = tomorrow ? getNextTradingDayKey(tomorrow) : null;

  const nearDates = new Set([today]);
  if (tomorrow) nearDates.add(tomorrow);
  if (dayAfter) nearDates.add(dayAfter);

  for (const pos of positions) {
    const legs = pos.legs as TradeLeg[] | null;
    if (!legs?.length) continue;
    for (const leg of legs) {
      if (leg.expiry && nearDates.has(leg.expiry)) return true;
    }
  }
  return false;
}

/**
 * Fire an alert if the trader has an active position on any of the skipped message's symbols.
 * Owns all guard logic internally — callers just pass context + prefetched data.
 * Always fires as CRITICAL severity (Discord + Pushover).
 *
 * Call with .catch(() => {}) — this must never crash the caller.
 */
export async function alertIfSkippedWithActivePosition(input: SkipAlertInput): Promise<void> {
  const { context, prefetched, skipReason, messageId, taskId } = input;

  // No position data or fetch failed — can't check, bail silently
  if (!prefetched || prefetched.positions.failed) return;

  const positions = prefetched.positions.allForTrader;
  if (positions.length === 0) return;

  const trader = context.author ?? 'unknown';
  const symbols = (context.symbols ?? []) as string[];
  const messageText = context.cleanText ?? '';

  // Find which symbols have matching open positions
  const positionSymbols = new Set(positions.map(p => p.symbol));
  const matchingSymbols = symbols.filter(s => positionSymbols.has(s));
  if (matchingSymbols.length === 0) return;

  // Throttle per symbol
  const unthrottled = matchingSymbols.filter(s => !isThrottled(trader, s));
  if (unthrottled.length === 0) return;

  const nearExpiry = hasNearExpiryLegs(positions, new Date());
  const matchingPositions = positions.filter(p => unthrottled.includes(p.symbol));

  const positionSummary = matchingPositions
    .map(p => {
      const legs = p.legs as TradeLeg[] | null;
      const expiry = legs?.[0]?.expiry ?? 'n/a';
      return `${p.symbol} ${p.strategy} x${p.quantity} (exp: ${expiry})`;
    })
    .join('\n');

  await sendSystemAlert({
    title: 'Skipped message on active position',
    message: `${trader}'s message about ${unthrottled.join(', ')} was skipped:\n"${messageText.slice(0, 200)}"`,
    severity: 'critical',
    fields: [
      { name: 'Trader', value: trader, inline: true },
      { name: 'Symbol(s)', value: unthrottled.join(', '), inline: true },
      { name: 'Near Expiry', value: nearExpiry ? 'YES' : 'No', inline: true },
      { name: 'Skip Reason', value: skipReason.slice(0, 500), inline: false },
      { name: 'Open Positions', value: positionSummary.slice(0, 500), inline: false },
      { name: 'Message ID', value: messageId, inline: true },
      { name: 'Task ID', value: taskId, inline: true },
    ],
  });
}
