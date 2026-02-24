/**
 * Open-path resolver for the intent orchestrator.
 *
 * Handles OPEN signals (new positions). Takes a ParseResult + OrchestratorContext
 * and produces a fully concrete ResolvedSignal by:
 *   1. Validating required fields
 *   2. Resolving expiry from expiryHint
 *   3. Determining strike selection method
 *   4. Resolving strikes via market data
 *   5. Building legs using spreadLegs
 *   6. Validating stated premium (when applicable)
 *   7. Returning the ResolvedSignal
 */

import type {
  ParseResult,
  OrchestratorContext,
  OrchestratorResult,
  ResolvedSignal,
  StrikeSelection,
  OptionLeg,
  StockLeg,
  Leg,
} from './types.js';
import { spreadLegs } from '../../lib/spread-legs.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('Orchestrator:OpenPath');

// ── Date helpers ───────────────────────────────────────────────────────────────

function parseMessageDate(timestamp: string): Date {
  return new Date(timestamp);
}

function dateToYMD(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Next Friday on or after `from` (UTC). If `from` IS a Friday, returns `from`. */
function nextFriday(from: Date): Date {
  const d = new Date(from);
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const daysUntilFriday = (5 - dow + 7) % 7;
  d.setUTCDate(d.getUTCDate() + daysUntilFriday);
  return d;
}

/** Friday of the current week (week containing `from`). */
function thisWeekFriday(from: Date): Date {
  const d = new Date(from);
  const dow = d.getUTCDay();
  // Days until Friday this week (could be negative if already past Friday → return last Friday)
  const delta = 5 - dow;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

/** Friday of the NEXT calendar week (Mon–Sun week after the one containing `from`). */
function nextWeekFriday(from: Date): Date {
  const d = new Date(from);
  const dow = d.getUTCDay(); // 0=Sun
  // Move to the upcoming Monday (start of next week)
  const daysToNextMonday = (8 - dow) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysToNextMonday);
  // Then advance to Friday of that week (Mon+4)
  d.setUTCDate(d.getUTCDate() + 4);
  return d;
}

/** Third Friday of the given month (0-indexed month). */
function thirdFriday(year: number, month: number): Date {
  // First day of month
  const d = new Date(Date.UTC(year, month, 1));
  const dow = d.getUTCDay();
  // First Friday of month
  const firstFridayDate = 1 + ((5 - dow + 7) % 7);
  // Third Friday
  const thirdFridayDate = firstFridayDate + 14;
  return new Date(Date.UTC(year, month, thirdFridayDate));
}

/** Add n business days (Mon–Fri) to date. */
function addBusinessDays(date: Date, n: number): Date {
  const d = new Date(date);
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      remaining--;
    }
  }
  return d;
}

/** Named weekday index (0=Sun). */
const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Resolve an expiryHint string to a YYYY-MM-DD date string.
 * Returns null if the hint cannot be interpreted.
 */
function resolveExpiryHint(hint: string, messageDate: Date): string | null {
  const normalized = hint.trim().toLowerCase();

  // 0DTE
  if (normalized === '0dte') {
    return dateToYMD(messageDate);
  }

  // LEAP
  if (normalized === 'leap') {
    const leapDate = new Date(messageDate);
    leapDate.setUTCFullYear(leapDate.getUTCFullYear() + 1);
    return dateToYMD(nextFriday(leapDate));
  }

  // overnight → next business day
  if (normalized === 'overnight') {
    return dateToYMD(addBusinessDays(messageDate, 1));
  }

  // "next friday"
  if (normalized === 'next friday') {
    // Strict "next" = the Friday of next week, not this week's Friday
    return dateToYMD(nextWeekFriday(messageDate));
  }

  // "this week" / "this friday"
  if (normalized === 'this week' || normalized === 'this friday') {
    return dateToYMD(thisWeekFriday(messageDate));
  }

  // "next week"
  if (normalized === 'next week') {
    return dateToYMD(nextWeekFriday(messageDate));
  }

  // "next monday" / "next tuesday" etc.
  const nextDayMatch = normalized.match(/^next\s+(\w+)$/);
  if (nextDayMatch) {
    const dayName = nextDayMatch[1];
    const targetDow = WEEKDAY_MAP[dayName];
    if (targetDow !== undefined) {
      const d = new Date(messageDate);
      const currentDow = d.getUTCDay();
      // Days until that weekday next week (always at least 7+ days out, strictly next week)
      const daysToNextMonday = (8 - currentDow) % 7 || 7;
      d.setUTCDate(d.getUTCDate() + daysToNextMonday); // start of next week (Monday)
      // From Monday, advance to the target day
      const deltaFromMonday = (targetDow - 1 + 7) % 7;
      d.setUTCDate(d.getUTCDate() + deltaFromMonday);
      return dateToYMD(d);
    }
  }

  // Explicit slash date: "3/6", "3/6/26", "3/6/2026"
  const slashMatch = hint.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1], 10) - 1; // 0-indexed
    const day = parseInt(slashMatch[2], 10);
    let year: number;
    if (slashMatch[3]) {
      const rawYear = parseInt(slashMatch[3], 10);
      year = rawYear < 100 ? 2000 + rawYear : rawYear;
    } else {
      year = messageDate.getUTCFullYear();
      // If the resolved date is in the past, advance one year
      const candidate = new Date(Date.UTC(year, month, day));
      if (candidate < messageDate) year++;
    }
    const date = new Date(Date.UTC(year, month, day));
    if (isNaN(date.getTime())) return null;
    return dateToYMD(date);
  }

  // Month + day: "Jan 17", "feb 3"
  const monthDayMatch = hint.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (monthDayMatch) {
    const monthIdx = MONTH_MAP[monthDayMatch[1].toLowerCase()];
    if (monthIdx !== undefined) {
      const day = parseInt(monthDayMatch[2], 10);
      let year = messageDate.getUTCFullYear();
      const candidate = new Date(Date.UTC(year, monthIdx, day));
      if (candidate < messageDate) year++;
      const date = new Date(Date.UTC(year, monthIdx, day));
      return dateToYMD(date);
    }
  }

  // Bare month: "Oct", "January"
  const bareMonthMatch = MONTH_MAP[normalized];
  if (bareMonthMatch !== undefined) {
    let year = messageDate.getUTCFullYear();
    const candidate = thirdFriday(year, bareMonthMatch);
    if (candidate < messageDate) {
      year++;
    }
    return dateToYMD(thirdFriday(year, bareMonthMatch));
  }

  return null;
}

// ── Strike helpers ─────────────────────────────────────────────────────────────

/**
 * Auto-detect a sensible strike interval from the current stock price,
 * or from chain strikes if available.
 */
function detectStrikeInterval(price: number, chainStrikes?: number[]): number {
  if (chainStrikes && chainStrikes.length >= 2) {
    const sorted = [...chainStrikes].sort((a, b) => a - b);
    const diffs: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      diffs.push(sorted[i] - sorted[i - 1]);
    }
    // Return the most common difference
    const freq = new Map<number, number>();
    for (const d of diffs) freq.set(d, (freq.get(d) ?? 0) + 1);
    let best = diffs[0];
    let bestCount = 0;
    for (const [val, count] of freq) {
      if (count > bestCount) { bestCount = count; best = val; }
    }
    return best;
  }
  if (price < 20) return 0.5;
  if (price < 100) return 1;
  if (price < 500) return 5;
  return 10;
}

/** Round `price` to the nearest multiple of `interval`. */
function roundToInterval(price: number, interval: number): number {
  return Math.round(price / interval) * interval;
}

/** Compute mid price of a strike from chain. */
function chainMid(bid: number, ask: number): number {
  return (bid + ask) / 2;
}

/**
 * Given a chain, find the strike whose mid is closest to `targetPremium`.
 * Returns the matching OptionsStrike or null.
 */
function findStrikeByPremium(
  chain: { strike: number; bid: number; ask: number }[],
  targetPremium: number,
): number | null {
  if (!chain.length) return null;
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const s of chain) {
    const mid = chainMid(s.bid, s.ask);
    const diff = Math.abs(mid - targetPremium);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s.strike;
    }
  }
  return best;
}

/** Compute spread mid from two strikes on a chain (pick by strike value). */
function computeSpreadMid(
  chain: { strike: number; bid: number; ask: number }[],
  buyStrike: number,
  sellStrike: number,
): number | null {
  const buy = chain.find(s => s.strike === buyStrike);
  const sell = chain.find(s => s.strike === sellStrike);
  if (!buy || !sell) return null;
  const buyMid = chainMid(buy.bid, buy.ask);
  const sellMid = chainMid(sell.bid, sell.ask);
  // Debit spread: buy – sell; credit spread: sell – buy (always return absolute value)
  return Math.abs(buyMid - sellMid);
}

/** Generate a set of weekly expiry candidates (Fri) starting from messageDate. */
function generateWeeklyExpiries(from: Date, count = 6): string[] {
  const expiries: string[] = [];
  let d = thisWeekFriday(from);
  // If this week's Friday is already past, start next week
  if (d < from) d = nextWeekFriday(from);
  for (let i = 0; i < count; i++) {
    expiries.push(dateToYMD(d));
    d = new Date(d);
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return expiries;
}

// ── Strike selection derivation ────────────────────────────────────────────────

function strikeSelectionFromParse(parse: ParseResult, cleanText: string): StrikeSelection {
  if (parse.strikes && parse.strikes.length > 0) {
    return { method: 'explicit', strikes: parse.strikes };
  }

  // Lotto/yolo context → buy cheap OTM (high delta from pricing perspective = price ~0.70)
  const isLotto = /lotto|yolo/i.test(cleanText);
  if (isLotto) {
    return { method: 'delta', target: 0.70, bias: 'nearest' };
  }

  if (parse.premiumHint !== null) {
    return { method: 'premium_match', statedPremium: parse.premiumHint };
  }

  return { method: 'atm' };
}

// ── Option type from strategy ──────────────────────────────────────────────────

function optionTypeFromStrategy(strategy: 'CALL' | 'PUT' | 'CDS' | 'PDS'): 'CALL' | 'PUT' {
  return (strategy === 'CALL' || strategy === 'CDS') ? 'CALL' : 'PUT';
}

// ── Main resolver ──────────────────────────────────────────────────────────────

export async function resolveOpenPath(
  parse: ParseResult,
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  // ── Step 1: Validate required fields ────────────────────────────────────────

  if (!parse.symbol) {
    log.debug('open-path: missing symbol');
    return { outcome: 'FLAG_FOR_REVIEW', reason: 'OPEN signal missing symbol' };
  }

  if (!parse.strategy) {
    log.debug('open-path: missing strategy');
    return { outcome: 'FLAG_FOR_REVIEW', reason: 'OPEN signal missing strategy' };
  }

  const symbol = parse.symbol;
  const strategy = parse.strategy;

  // Direction required for STOCK, CALL, PUT; for CDS/PDS direction is always known
  if (strategy === 'STOCK' || strategy === 'CALL' || strategy === 'PUT') {
    if (!parse.direction) {
      log.debug('open-path: missing direction for %s', strategy);
      return { outcome: 'FLAG_FOR_REVIEW', reason: `OPEN signal missing direction for strategy ${strategy}` };
    }
  }

  const direction = parse.direction ?? (strategy === 'CDS' ? 'LONG' : 'LONG');

  // ── Step 2: Resolve expiry ───────────────────────────────────────────────────

  const messageDate = parseMessageDate(ctx.timestamp);
  const strikeSelection = strikeSelectionFromParse(parse, ctx.cleanText);

  let resolvedExpiry: string | null = null;

  if (strategy === 'STOCK') {
    // Stock needs no expiry
    resolvedExpiry = null;
  } else if (parse.expiryHint !== null) {
    resolvedExpiry = resolveExpiryHint(parse.expiryHint, messageDate);
    if (!resolvedExpiry) {
      log.debug('open-path: could not parse expiryHint "%s"', parse.expiryHint);
      return {
        outcome: 'FLAG_FOR_REVIEW',
        reason: `Could not interpret expiryHint: "${parse.expiryHint}"`,
      };
    }
    log.debug('open-path: resolved expiry %s from hint "%s"', resolvedExpiry, parse.expiryHint);
  } else {
    // No expiryHint
    if (strikeSelection.method === 'premium_match') {
      // Will scan expiries — resolvedExpiry stays null until scan below
      resolvedExpiry = null;
    } else {
      return {
        outcome: 'FLAG_FOR_REVIEW',
        reason: 'No expiry or premium to infer from',
      };
    }
  }

  // ── Step 3 & 4: Resolve strikes via market data ──────────────────────────────

  interface ResolvedLegs {
    legs: Leg[];
    limitPrice?: number;
    premiumMatchExpiry?: string;
  }

  async function buildLegsForExpiry(expiry: string): Promise<ResolvedLegs | { error: string }> {
    if (strategy === 'STOCK') {
      // Handled separately below
      return { error: 'stock handled separately' };
    }

    const isSpread = strategy === 'CDS' || strategy === 'PDS';
    const optType = optionTypeFromStrategy(strategy as 'CALL' | 'PUT' | 'CDS' | 'PDS');

    if (strikeSelection.method === 'explicit') {
      const strikes = strikeSelection.strikes;
      if (isSpread) {
        if (strikes.length < 2) {
          return { error: `Spread strategy ${strategy} requires 2 strikes, got ${strikes.length}` };
        }
        const spreadLegsResult = spreadLegs(
          strategy as 'CDS' | 'PDS',
          direction as 'LONG' | 'SHORT',
          strikes[0],
          strikes[1],
        );
        const legs: OptionLeg[] = spreadLegsResult.map(sl => ({
          type: 'option' as const,
          symbol,
          expiry,
          optionType: sl.optionType,
          strike: sl.strike,
          side: sl.action,
          quantity: 1,
        }));
        return { legs };
      } else {
        // Naked CALL or PUT
        const strike = strikes[0];
        const side = direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
        const leg: OptionLeg = {
          type: 'option',
          symbol,
          expiry,
          optionType: optType,
          strike,
          side,
          quantity: 1,
        };
        return { legs: [leg] };
      }
    }

    if (strikeSelection.method === 'atm') {
      let stockPrice: number;
      try {
        const quote = await ctx.marketData.getQuote(symbol);
        stockPrice = (quote.bid + quote.ask) / 2;
      } catch (err) {
        return { error: `Failed to get quote for ${symbol}: ${String(err)}` };
      }

      // Try to get chain to detect interval
      let chainStrikes: number[] | undefined;
      try {
        const chain = await ctx.marketData.getOptionChain(symbol, expiry, optType);
        if (chain) chainStrikes = chain.strikes.map(s => s.strike);
      } catch {
        // non-fatal
      }

      const interval = detectStrikeInterval(stockPrice, chainStrikes);
      const atmStrike = roundToInterval(stockPrice, interval);

      if (isSpread) {
        const otmStrike = optType === 'PUT' ? atmStrike - interval : atmStrike + interval;
        const spreadLegsResult = spreadLegs(
          strategy as 'CDS' | 'PDS',
          direction as 'LONG' | 'SHORT',
          atmStrike,
          otmStrike,
        );
        const legs: OptionLeg[] = spreadLegsResult.map(sl => ({
          type: 'option' as const,
          symbol,
          expiry,
          optionType: sl.optionType,
          strike: sl.strike,
          side: sl.action,
          quantity: 1,
        }));
        return { legs };
      } else {
        const side = direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
        const leg: OptionLeg = {
          type: 'option',
          symbol,
          expiry,
          optionType: optType,
          strike: atmStrike,
          side,
          quantity: 1,
        };
        return { legs: [leg] };
      }
    }

    if (strikeSelection.method === 'delta') {
      let chain;
      try {
        chain = await ctx.marketData.getOptionChain(symbol, expiry, optType);
      } catch (err) {
        return { error: `Failed to get chain for delta selection: ${String(err)}` };
      }
      if (!chain || !chain.strikes.length) {
        return { error: `No chain data available for ${symbol} ${expiry} delta selection` };
      }
      const { target } = strikeSelection;
      // Find strike whose delta is nearest to target
      let bestStrike: number | null = null;
      let bestDiff = Infinity;
      for (const s of chain.strikes) {
        if (s.delta !== undefined) {
          const diff = Math.abs(Math.abs(s.delta) - target);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestStrike = s.strike;
          }
        }
      }
      if (bestStrike === null) {
        // Fallback: no delta data — use ATM
        let stockPrice: number;
        try {
          const quote = await ctx.marketData.getQuote(symbol);
          stockPrice = (quote.bid + quote.ask) / 2;
        } catch (err) {
          return { error: `Failed to get quote for delta fallback: ${String(err)}` };
        }
        const interval = detectStrikeInterval(stockPrice, chain.strikes.map(s => s.strike));
        bestStrike = roundToInterval(stockPrice, interval);
      }

      const side = direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
      const leg: OptionLeg = {
        type: 'option',
        symbol,
        expiry,
        optionType: optType,
        strike: bestStrike,
        side,
        quantity: 1,
      };
      return { legs: [leg] };
    }

    if (strikeSelection.method === 'premium_match') {
      const statedPremium = strikeSelection.statedPremium;
      let chain;
      try {
        chain = await ctx.marketData.getOptionChain(symbol, expiry, optType);
      } catch (err) {
        return { error: `Failed to get chain for premium match: ${String(err)}` };
      }
      if (!chain || !chain.strikes.length) {
        return { error: `No chain data for ${symbol} ${expiry}` };
      }

      if (isSpread) {
        // For spreads: we need to find the combination of two strikes whose spread mid
        // is closest to stated premium. We'll pick the best matching pair.
        const sorted = [...chain.strikes].sort((a, b) => a.strike - b.strike);
        let bestStrikes: [number, number] | null = null;
        let bestDiff = Infinity;
        for (let i = 0; i < sorted.length; i++) {
          for (let j = i + 1; j < sorted.length; j++) {
            const mid = computeSpreadMid(
              chain.strikes,
              sorted[i].strike,
              sorted[j].strike,
            );
            if (mid !== null) {
              const diff = Math.abs(mid - statedPremium);
              if (diff < bestDiff) {
                bestDiff = diff;
                bestStrikes = [sorted[i].strike, sorted[j].strike];
              }
            }
          }
        }
        if (!bestStrikes) return { error: 'Could not find matching spread strikes' };

        const tolerance = statedPremium * 0.05;
        if (bestDiff > tolerance) {
          return { error: `premium_mismatch: best spread diff ${bestDiff.toFixed(2)} > tolerance ${tolerance.toFixed(2)}` };
        }

        const spreadLegsResult = spreadLegs(
          strategy as 'CDS' | 'PDS',
          direction as 'LONG' | 'SHORT',
          bestStrikes[0],
          bestStrikes[1],
        );
        const legs: OptionLeg[] = spreadLegsResult.map(sl => ({
          type: 'option' as const,
          symbol,
          expiry,
          optionType: sl.optionType,
          strike: sl.strike,
          side: sl.action,
          quantity: 1,
        }));
        return { legs, limitPrice: statedPremium };
      } else {
        // Naked option: find strike by premium
        const bestStrike = findStrikeByPremium(chain.strikes, statedPremium);
        if (!bestStrike) return { error: 'No strikes in chain' };

        const matchedStrike = chain.strikes.find(s => s.strike === bestStrike);
        const matchedMid = matchedStrike ? chainMid(matchedStrike.bid, matchedStrike.ask) : 0;
        const tolerance = statedPremium * 0.05;
        const diff = Math.abs(matchedMid - statedPremium);
        if (diff > tolerance) {
          return { error: `premium_mismatch: diff ${diff.toFixed(2)} > tolerance ${tolerance.toFixed(2)}` };
        }

        const side = direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
        const leg: OptionLeg = {
          type: 'option',
          symbol,
          expiry,
          optionType: optType,
          strike: bestStrike,
          side,
          quantity: 1,
        };
        return { legs: [leg], limitPrice: statedPremium };
      }
    }

    return { error: 'Unknown strike selection method' };
  }

  // ── Handle STOCK strategy ────────────────────────────────────────────────────

  if (strategy === 'STOCK') {
    const side = direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
    const stockLeg: StockLeg = { type: 'stock', symbol, side, quantity: 1 };
    const signal: ResolvedSignal = { orderType: 'STOCK', legs: [stockLeg] };
    log.debug('open-path: built STOCK signal for %s', symbol);
    return { outcome: 'EXECUTE', signals: [signal] };
  }

  // ── Premium-match scan (expiry unknown, scanning multiple expiries) ──────────

  if (strikeSelection.method === 'premium_match' && resolvedExpiry === null) {
    let candidateExpiries: string[];
    try {
      candidateExpiries = await ctx.marketData.getExpiryDates(symbol);
    } catch {
      candidateExpiries = [];
    }
    if (!candidateExpiries.length) {
      candidateExpiries = generateWeeklyExpiries(messageDate, 6);
    }

    for (const expiry of candidateExpiries) {
      const result = await buildLegsForExpiry(expiry);
      if ('error' in result) {
        if (result.error.startsWith('premium_mismatch')) {
          // This expiry doesn't match — try next
          log.debug('open-path: premium scan %s %s: %s', symbol, expiry, result.error);
          continue;
        }
        // I/O error or no data — skip this expiry quietly
        log.debug('open-path: premium scan skipping %s: %s', expiry, result.error);
        continue;
      }
      // Found a matching expiry
      log.debug('open-path: premium scan matched expiry %s for %s', expiry, symbol);
      const limitPrice = buildLimitPrice(result.limitPrice, direction);
      const signal: ResolvedSignal = {
        orderType: result.legs.length > 1 ? 'SPREAD' : 'SINGLE',
        legs: result.legs,
        ...(limitPrice !== undefined && { limitPrice }),
      };
      return { outcome: 'EXECUTE', signals: [signal] };
    }

    return {
      outcome: 'FLAG_FOR_REVIEW',
      reason: `premium mismatch: no expiry found matching stated premium of ${(strikeSelection as { statedPremium: number }).statedPremium} for ${symbol}`,
    };
  }

  // ── Single expiry path ───────────────────────────────────────────────────────

  if (!resolvedExpiry) {
    return { outcome: 'FLAG_FOR_REVIEW', reason: 'No expiry resolved' };
  }

  let buildResult: ResolvedLegs | { error: string };
  if (strikeSelection.method === 'delta') {
    buildResult = await buildLegsForExpiry(resolvedExpiry);
    if ('error' in buildResult) {
      return {
        outcome: 'FLAG_FOR_REVIEW',
        reason: buildResult.error,
      };
    }
  } else {
    try {
      buildResult = await buildLegsForExpiry(resolvedExpiry);
    } catch (err) {
      return {
        outcome: 'FLAG_FOR_REVIEW',
        reason: `Market data error: ${String(err)}`,
      };
    }
    if ('error' in buildResult) {
      return {
        outcome: 'FLAG_FOR_REVIEW',
        reason: buildResult.error,
      };
    }
  }

  const resolvedLegs = buildResult as ResolvedLegs;

  // ── Step 6: Premium validation (when premium stated, expiry resolved via non-premium-match) ──

  if (
    parse.premiumHint !== null &&
    strikeSelection.method !== 'premium_match' &&
    resolvedLegs.legs.length > 0
  ) {
    const optionLegs = resolvedLegs.legs.filter((l): l is OptionLeg => l.type === 'option');
    if (optionLegs.length > 0) {
      const optType = optionLegs[0].optionType;
      let chain;
      try {
        chain = await ctx.marketData.getOptionChain(symbol, resolvedExpiry, optType);
      } catch {
        chain = null;
      }

      if (chain && chain.strikes.length > 0) {
        let computedMid: number | null = null;
        const isSpread = resolvedLegs.legs.length > 1;

        if (isSpread && optionLegs.length === 2) {
          const strikes = optionLegs.map(l => l.strike);
          computedMid = computeSpreadMid(chain.strikes, strikes[0], strikes[1]);
        } else {
          const s = chain.strikes.find(cs => cs.strike === optionLegs[0].strike);
          if (s) computedMid = chainMid(s.bid, s.ask);
        }

        if (computedMid !== null) {
          const tolerance = parse.premiumHint * 0.05;
          const diff = Math.abs(computedMid - parse.premiumHint);
          if (diff > tolerance) {
            log.debug(
              'open-path: premium validation failed for %s — stated %s vs market %s',
              symbol,
              parse.premiumHint,
              computedMid.toFixed(2),
            );
            const orderType = resolvedLegs.legs.length > 1 ? 'SPREAD' : 'SINGLE';
            return {
              outcome: 'FLAG_FOR_REVIEW',
              reason: `Premium mismatch: stated ${parse.premiumHint} vs market mid ${computedMid.toFixed(2)}`,
              partial: [{ orderType, legs: resolvedLegs.legs }],
            };
          }
        }
      }
    }
  }

  // ── Step 7: Build ResolvedSignal ─────────────────────────────────────────────

  const isSpreadSignal = resolvedLegs.legs.length > 1;
  const limitPrice = buildLimitPrice(
    resolvedLegs.limitPrice ?? parse.premiumHint ?? undefined,
    direction,
  );

  const signal: ResolvedSignal = {
    orderType: isSpreadSignal ? 'SPREAD' : 'SINGLE',
    legs: resolvedLegs.legs,
    ...(limitPrice !== undefined && { limitPrice }),
  };

  log.debug(
    'open-path: resolved %s %s %s → %d legs expiry=%s',
    direction,
    strategy,
    symbol,
    signal.legs.length,
    resolvedExpiry,
  );

  return { outcome: 'EXECUTE', signals: [signal] };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Apply sign convention to limitPrice:
 * - LONG / debit strategies → positive (paying premium)
 * - SHORT / credit strategies → negative (receiving premium)
 */
function buildLimitPrice(
  price: number | undefined,
  direction: string,
): number | undefined {
  if (price === undefined || price === null) return undefined;
  const abs = Math.abs(price);
  return direction === 'SHORT' ? -abs : abs;
}
