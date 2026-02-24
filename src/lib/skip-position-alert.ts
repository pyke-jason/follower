/**
 * Layer 2 Safety Net: Alert when LLM skips a message for a symbol
 * where the trader has an active open position.
 *
 * Exports:
 * - buildSkipPositionContext()  — pure context builder (works in both live and backtest)
 * - formatSkipPositionContext() — renders context as readable text
 * - alertIfSkippedWithActivePosition() — live-only alert sender
 */

import type { Message, Trade, TradeLeg, TaskContext } from '../db/schema.js';
import type { PrefetchedData, PrefetchedQuote } from '../agent/prefetch.js';
import { sendSystemAlert } from './alert.js';
import { toDateKeyET } from './et-date.js';
import { getNextTradingDayKey } from './et-date.js';
import { getRecentTraderMessages } from '../intents/trader-context.js';
import { formatTraderContext } from '../intents/trader-context.js';

// ─── Types ──────────────────────────────────────────

type SkipAlertInput = {
  context: TaskContext;
  prefetched: PrefetchedData | undefined;
  skipReason: string;
  messageId: string;
  taskId: string;
};

export type SkipPositionContext = {
  trader: string;
  messageTimestamp: string;
  skippedMessageText: string;
  messageSymbols: string[];
  messageBadges: string[];
  skipReason: string;
  matchingPositions: {
    symbol: string;
    strategy: string;
    direction: string;
    quantity: number;
    legs: { strike: number; expiry: string; type: string }[];
    entryPrice: string | null;
    openedAt: string | null;
  }[];
  nearExpiry: boolean;
  quotes: Record<string, PrefetchedQuote>;
  recentTraderMessages: string;
};

type BuildContextDeps = {
  getRecentTraderMessages: (trader: string, beforeTimestamp: string, limit?: number) => Promise<Message[]>;
};

// ─── Internal helpers ───────────────────────────────

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

// ─── Context builder ────────────────────────────────

/**
 * Build structured context about a skipped message that overlaps with active positions.
 * Pure data builder — no side effects, no alerts. Works in both live and backtest.
 *
 * Returns null when there's nothing relevant (no positions, no matching symbols, fetch failed).
 */
export async function buildSkipPositionContext(
  context: TaskContext,
  prefetched: PrefetchedData | undefined,
  skipReason: string,
  referenceTime: Date,
  deps: BuildContextDeps,
): Promise<SkipPositionContext | null> {
  // No position data or fetch failed — can't check
  if (!prefetched || prefetched.positions.failed) return null;

  const positions = prefetched.positions.allForTrader;
  if (positions.length === 0) return null;

  const trader = context.author ?? 'unknown';
  const symbols = (context.symbols ?? []) as string[];
  const badges = (context.badges ?? []) as string[];
  const messageText = context.cleanText ?? '';
  const messageTimestamp = context.messageTimestamp ?? referenceTime.toISOString();

  // Find which symbols have matching open positions
  const positionSymbols = new Set(positions.map(p => p.symbol));
  const matchingSymbols = symbols.filter(s => positionSymbols.has(s));
  if (matchingSymbols.length === 0) return null;

  // Build matching positions array
  const matchingSymbolSet = new Set(matchingSymbols);
  const matchingTrades = positions.filter(p => matchingSymbolSet.has(p.symbol));
  const matchingPositions = matchingTrades.map(p => {
    const legs = (p.legs as TradeLeg[] | null) ?? [];
    return {
      symbol: p.symbol,
      strategy: p.strategy,
      direction: p.direction,
      quantity: p.quantity ?? 1,
      legs: legs.map(l => ({ strike: l.strike, expiry: l.expiry, type: l.type })),
      entryPrice: p.entryPrice,
      openedAt: p.openedAt,
    };
  });

  const nearExpiry = hasNearExpiryLegs(matchingTrades, referenceTime);

  // Extract quotes for matching symbols
  const quotes: Record<string, PrefetchedQuote> = {};
  for (const sym of matchingSymbols) {
    if (prefetched.quotes[sym]) {
      quotes[sym] = prefetched.quotes[sym];
    }
  }

  // Fetch recent trader messages for context
  let recentTraderMessages: string;
  try {
    const messages = await deps.getRecentTraderMessages(trader, messageTimestamp, 10);
    recentTraderMessages = formatTraderContext(messages);
  } catch {
    recentTraderMessages = 'Failed to fetch recent messages.';
  }

  return {
    trader,
    messageTimestamp,
    skippedMessageText: messageText,
    messageSymbols: symbols,
    messageBadges: badges,
    skipReason,
    matchingPositions,
    nearExpiry,
    quotes,
    recentTraderMessages,
  };
}

// ─── Formatter ──────────────────────────────────────

/**
 * Render a SkipPositionContext as human-readable multi-line text.
 */
export function formatSkipPositionContext(ctx: SkipPositionContext): string {
  const lines: string[] = [];

  lines.push('── POSITION CONTEXT ──');
  lines.push(`Trader: ${ctx.trader}`);
  lines.push(`Skip reason: ${ctx.skipReason}`);

  if (ctx.nearExpiry) {
    lines.push('\u26A0 NEAR EXPIRY \u2014 legs expiring within 2 trading days');
  }

  lines.push('');
  lines.push('Matching positions:');
  for (const pos of ctx.matchingPositions) {
    const legsStr = pos.legs
      .map(l => `${l.type} ${l.strike} exp:${l.expiry}`)
      .join(', ');
    lines.push(`  ${pos.symbol} ${pos.direction} ${pos.strategy} x${pos.quantity} [${legsStr}]`);
    if (pos.entryPrice !== null) {
      lines.push(`    entry: $${pos.entryPrice} opened: ${pos.openedAt ?? 'n/a'}`);
    }
  }

  lines.push('');
  lines.push('Quotes:');
  for (const [symbol, quote] of Object.entries(ctx.quotes)) {
    if ('error' in quote) {
      lines.push(`  ${symbol}: error (${quote.error})`);
    } else {
      lines.push(`  ${symbol}: bid=${quote.bid} ask=${quote.ask} last=${quote.last} vol=${quote.volume}`);
    }
  }

  lines.push('');
  lines.push(ctx.recentTraderMessages);

  return lines.join('\n');
}

// ─── Live alert sender ──────────────────────────────

/**
 * Fire an alert if the trader has an active position on any of the skipped message's symbols.
 * Owns all guard logic internally — callers just pass context + prefetched data.
 * Always fires as CRITICAL severity (Discord + Pushover).
 *
 * Returns the SkipPositionContext if one was built (even if throttled), null otherwise.
 *
 * Call with .catch(() => {}) — this must never crash the caller.
 */
export async function alertIfSkippedWithActivePosition(input: SkipAlertInput): Promise<SkipPositionContext | null> {
  const { context, prefetched, skipReason, messageId, taskId } = input;

  const positionContext = await buildSkipPositionContext(
    context,
    prefetched,
    skipReason,
    new Date(),
    { getRecentTraderMessages },
  );

  if (!positionContext) return null;

  // Throttle per symbol — filter to unthrottled symbols
  const uniqueSymbols = Array.from(new Set(positionContext.matchingPositions.map(p => p.symbol)));
  const unthrottled = uniqueSymbols.filter(s => !isThrottled(positionContext.trader, s));
  if (unthrottled.length === 0) return positionContext;

  const formatted = formatSkipPositionContext(positionContext);

  await sendSystemAlert({
    title: 'Skipped message on active position',
    message: `${positionContext.trader}'s message about ${unthrottled.join(', ')} was skipped:\n"${positionContext.skippedMessageText.slice(0, 200)}"`,
    severity: 'critical',
    fields: [
      { name: 'Trader', value: positionContext.trader, inline: true },
      { name: 'Symbol(s)', value: unthrottled.join(', '), inline: true },
      { name: 'Near Expiry', value: positionContext.nearExpiry ? 'YES' : 'No', inline: true },
      { name: 'Skip Reason', value: skipReason.slice(0, 500), inline: false },
      { name: 'Positions & Quotes', value: formatted.slice(0, 900), inline: false },
      { name: 'Message ID', value: messageId, inline: true },
      { name: 'Task ID', value: taskId, inline: true },
    ],
  });

  return positionContext;
}
