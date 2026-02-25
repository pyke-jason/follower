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
  OpenPosition,
} from './types.js';
import type { Strategy } from '../../lib/enums.js';
import { spreadLegs } from '../../lib/spread-legs.js';
import { strikesFromParse } from './parser.js';
import { resolveExpiryHint, generateWeeklyExpiries } from './expiry-resolver.js';
import { createLogger } from '../../lib/logger.js';
import { toDateKeyET } from '../../lib/et-date.js';

const log = createLogger('Orchestrator:OpenPath');

type SpreadStrategy = 'CDS' | 'PDS' | 'PCS';
const SPREAD_STRATEGIES = new Set<Strategy>(['CDS', 'PDS', 'PCS']);
function isSpread(s: Strategy): s is SpreadStrategy { return SPREAD_STRATEGIES.has(s); }
/** Credit strategies receive premium (negative limit price). */
function isCreditStrategy(s: Strategy): boolean { return s === 'PCS'; }

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

// ── Option type from strategy ──────────────────────────────────────────────────

function optionTypeFromStrategy(strategy: Strategy): 'CALL' | 'PUT' {
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
    return { outcome: 'MANUAL_REVIEW', reason: 'OPEN signal missing symbol' };
  }

  if (!parse.strategy) {
    log.debug('open-path: missing strategy');
    return { outcome: 'MANUAL_REVIEW', reason: 'OPEN signal missing strategy' };
  }

  const symbol = parse.symbol;
  const strategy = parse.strategy;

  const spreadStrategy = isSpread(strategy);

  // Direction required for STOCK, CALL, PUT; spreads derive it from legs
  if (!spreadStrategy) {
    if (!parse.direction) {
      log.debug('open-path: missing direction for %s', strategy);
      return { outcome: 'MANUAL_REVIEW', reason: `OPEN signal missing direction for strategy ${strategy}` };
    }
  }

  // For non-spread strategies, direction comes from parse. For spreads it's unused.
  const direction = parse.direction ?? 'LONG';

  // ── Step 2: Resolve expiry ───────────────────────────────────────────────────

  const messageDate = new Date(ctx.timestamp);
  let strikeSelection = strikesFromParse(parse);

  // Safety net: reject explicit strikes that are wildly inconsistent with the stock price.
  // Catches misidentified premiums or cost-basis values (e.g. "$38.97 avg" on a $550 stock).
  if (
    strikeSelection.method === 'explicit' &&
    !spreadStrategy &&
    strategy !== 'STOCK' &&
    strikeSelection.strikes.length === 1
  ) {
    const quote = await ctx.marketData.getQuote(symbol);
    const stockPrice = (quote.bid + quote.ask) / 2;
    const strike = strikeSelection.strikes[0];
    if (strike < stockPrice * 0.15 || strike > stockPrice * 5) {
      log.debug(
        'open-path: explicit strike %s implausible vs stock price %s — falling back to ATM',
        strike,
        stockPrice.toFixed(2),
      );
      strikeSelection = { method: 'atm' };
    }
  }

  let resolvedExpiry: string | null = null;

  if (strategy === 'STOCK') {
    // Stock needs no expiry
    resolvedExpiry = null;
  } else if (parse.expiryHint !== null) {
    resolvedExpiry = resolveExpiryHint(parse.expiryHint, messageDate);
    if (!resolvedExpiry) {
      log.debug('open-path: could not parse expiryHint "%s"', parse.expiryHint);
      return {
        outcome: 'MANUAL_REVIEW',
        reason: `Could not interpret expiryHint: "${parse.expiryHint}"`,
      };
    }
    log.debug('open-path: resolved expiry %s from hint "%s"', resolvedExpiry, parse.expiryHint);
  } else {
    // No expiryHint — try to find nearest real expiry via market data
    if (strikeSelection.method === 'premium_match') {
      // Will scan expiries — resolvedExpiry stays null until scan below
      resolvedExpiry = null;
    } else {
      let candidateExpiries = await ctx.marketData.getExpiryDates(symbol);
      if (!candidateExpiries.length) {
        candidateExpiries = generateWeeklyExpiries(messageDate, 6);
      }
      if (candidateExpiries.length > 0) {
        resolvedExpiry = candidateExpiries[0];
        log.debug('open-path: defaulted to nearest expiry %s for %s (no hint)', resolvedExpiry, symbol);
      } else {
        return {
          outcome: 'MANUAL_REVIEW',
          reason: 'No expiry or premium to infer from',
        };
      }
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

    const optType = optionTypeFromStrategy(strategy);

    if (strikeSelection.method === 'explicit') {
      const strikes = strikeSelection.strikes;
      if (spreadStrategy) {
        if (strikes.length < 2) {
          return { error: `Spread strategy ${strategy} requires 2 strikes, got ${strikes.length}` };
        }
        const spreadLegsResult = spreadLegs(strategy as SpreadStrategy, strikes[0], strikes[1]);
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
      const quote = await ctx.marketData.getQuote(symbol);
      const stockPrice = (quote.bid + quote.ask) / 2;

      // Chain is required for ATM — if null, the expiry likely doesn't exist
      const chainForInterval = await ctx.marketData.getOptionChain(symbol, expiry, optType);
      if (!chainForInterval || !chainForInterval.strikes.length) {
        return { error: `No option chain for ${symbol} ${expiry} ${optType} — expiry may not exist` };
      }
      const chainStrikes = chainForInterval.strikes.map(s => s.strike);

      const interval = detectStrikeInterval(stockPrice, chainStrikes);
      const atmStrike = roundToInterval(stockPrice, interval);

      if (spreadStrategy) {
        const otmStrike = optType === 'PUT' ? atmStrike - interval : atmStrike + interval;
        const spreadLegsResult = spreadLegs(strategy as SpreadStrategy, atmStrike, otmStrike);
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
      const chain = await ctx.marketData.getOptionChain(symbol, expiry, optType);
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
        const quote = await ctx.marketData.getQuote(symbol);
        const stockPrice = (quote.bid + quote.ask) / 2;
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
      const chain = await ctx.marketData.getOptionChain(symbol, expiry, optType);
      if (!chain || !chain.strikes.length) {
        return { error: `No chain data for ${symbol} ${expiry}` };
      }

      if (spreadStrategy) {
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

        const tolerance = Math.max(statedPremium * 0.15, 0.15);
        if (bestDiff > tolerance) {
          return { error: `premium_mismatch: best spread diff ${bestDiff.toFixed(2)} > tolerance ${tolerance.toFixed(2)}` };
        }

        const spreadLegsResult = spreadLegs(strategy as SpreadStrategy, bestStrikes[0], bestStrikes[1]);
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
        const tolerance = Math.max(statedPremium * 0.15, 0.15);
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
    let candidateExpiries = await ctx.marketData.getExpiryDates(symbol);
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
      const limitPrice = buildLimitPrice(result.limitPrice, strategy, direction);
      const signal: ResolvedSignal = {
        orderType: result.legs.length > 1 ? 'SPREAD' : 'SINGLE',
        legs: result.legs,
        ...(limitPrice !== undefined && { limitPrice }),
      };
      return { outcome: 'EXECUTE', signals: [signal] };
    }

    return {
      outcome: 'MANUAL_REVIEW',
      reason: `premium mismatch: no expiry found matching stated premium of ${(strikeSelection as { statedPremium: number }).statedPremium} for ${symbol}`,
    };
  }

  // ── Single expiry path ───────────────────────────────────────────────────────

  if (!resolvedExpiry) {
    return { outcome: 'MANUAL_REVIEW', reason: 'No expiry resolved' };
  }

  const buildResult = await buildLegsForExpiry(resolvedExpiry);
  if ('error' in buildResult) {
    return {
      outcome: 'MANUAL_REVIEW',
      reason: buildResult.error,
    };
  }

  const resolvedLegs = buildResult as ResolvedLegs;

  // ── Step 6: Premium validation (when premium stated, expiry resolved via non-premium-match) ──

  if (
    parse.premiumHint !== null &&
    strikeSelection.method !== 'premium_match' &&
    strikeSelection.method !== 'explicit' &&
    resolvedLegs.legs.length > 0
  ) {
    const optionLegs = resolvedLegs.legs.filter((l): l is OptionLeg => l.type === 'option');
    if (optionLegs.length > 0) {
      const optType = optionLegs[0].optionType;
      const chain = await ctx.marketData.getOptionChain(symbol, resolvedExpiry, optType);

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
          const tolerance = Math.max(parse.premiumHint * 0.15, 0.15);
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
              outcome: 'MANUAL_REVIEW',
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
    strategy,
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

// ── ADD path ──────────────────────────────────────────────────────────────────

/**
 * Resolve an ADD action: adding to an existing open position.
 *
 * 1. Look up existing open position by symbol (+ optional strategy preference)
 * 2. Enrich parse.direction from matched position (handles "Added to AMD short" where direction=null)
 * 3. Delegate to resolveOpenPath with action='OPEN' so existing leg-building logic applies
 * 4. If EXECUTE and position found, stamp tradeId on each signal so the executor ADDs to the existing trade
 */
export async function resolveAddPath(
  parse: ParseResult,
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  if (!parse.symbol) {
    return { outcome: 'MANUAL_REVIEW', reason: 'ADD signal missing symbol' };
  }

  // Look up existing position
  let positions: OpenPosition[];
  try {
    positions = await ctx.positions.getPositions(parse.symbol);
  } catch (err) {
    log.error('getPositions failed for', parse.symbol, err);
    return {
      outcome: 'MANUAL_REVIEW',
      reason: `failed to fetch positions for ${parse.symbol}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Find matching position — strategy-filtered if parse has a strategy hint
  let matched: OpenPosition | null = null;
  if (positions.length === 1) {
    matched = positions[0];
  } else if (positions.length > 1 && parse.strategy) {
    const byStrategy = positions.filter(p => p.strategy === parse.strategy);
    if (byStrategy.length === 1) {
      matched = byStrategy[0];
    }
  }

  // Enrich direction from the matched position when parse didn't determine it
  const enrichedParse: ParseResult = {
    ...parse,
    action: 'OPEN', // delegate to open-path as a new OPEN
    direction: parse.direction ?? matched?.direction ?? null,
    strategy: parse.strategy ?? matched?.strategy ?? null,
  };

  const result = await resolveOpenPath(enrichedParse, ctx);

  // If EXECUTE and we matched a position, stamp tradeId so executor ADDs to existing trade
  if (result.outcome === 'EXECUTE' && matched) {
    for (const signal of result.signals) {
      signal.tradeId = matched.id;
    }
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Apply sign convention to limitPrice:
 * - Debit strategies → positive (paying premium)
 * - Credit strategies (PCS, sold options) → negative (receiving premium)
 */
function buildLimitPrice(
  price: number | undefined,
  strategy: Strategy,
  direction: string,
): number | undefined {
  if (price === undefined || price === null) return undefined;
  const abs = Math.abs(price);
  const credit = isCreditStrategy(strategy) || direction === 'SHORT';
  return credit ? -abs : abs;
}
