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
  TradePosition,
} from './types.js';
import type { LegAction, OptionType, Strategy } from '@/lib/enums.js';
import { isSpread, getOptionLegs, type SpreadStrategy } from '@/lib/trade.js';
import { strikesFromParse } from './parser.js';
import { generateWeeklyExpiries } from './expiry-resolver.js';
import { normalizeExpiry } from '@/lib/occ-symbology.js';
import { createLogger } from '@/lib/logger.js';
import { toDateKeyET } from '@/lib/et-date.js';

const log = createLogger('Orchestrator:OpenPath');

/**
 * Build OptionLeg[] for a vertical spread in canonical order.
 *
 * Canonical ordering: dominant (first) leg determines price-chase direction
 * in OrderManager. Credit spreads open with SELL first so the close order
 * reverses to BUY first → chases UP. Debit spreads open with BUY first so
 * the close reverses to SELL first → chases DOWN.
 *
 * PCS  →  [SELL max PUT,  BUY  min PUT ]   put credit spread (SHORT)
 * PDS  →  [BUY  max PUT,  SELL min PUT ]   put debit spread  (LONG)
 * CDS  →  [BUY  min CALL, SELL max CALL]   call debit spread (LONG)
 * CCS  →  [SELL min CALL, BUY  max CALL]   call credit spread (SHORT)
 */
function buildSpreadOptionLegs(
  strategy: SpreadStrategy,
  s1: number,
  s2: number,
  symbol: string,
  expiry: string,
): OptionLeg[] {
  const hi = Math.max(s1, s2);
  const lo = Math.min(s1, s2);

  const table = {
    PCS: [{ strike: hi, side: 'SELL' as const, optionType: 'PUT' as const }, { strike: lo, side: 'BUY' as const, optionType: 'PUT' as const }],
    PDS: [{ strike: hi, side: 'BUY' as const, optionType: 'PUT' as const }, { strike: lo, side: 'SELL' as const, optionType: 'PUT' as const }],
    CDS: [{ strike: lo, side: 'BUY' as const, optionType: 'CALL' as const }, { strike: hi, side: 'SELL' as const, optionType: 'CALL' as const }],
    CCS: [{ strike: lo, side: 'SELL' as const, optionType: 'CALL' as const }, { strike: hi, side: 'BUY' as const, optionType: 'CALL' as const }],
  };

  return table[strategy].map(l => ({ ...l, type: 'option' as const, symbol, expiry, quantity: 1 }));
}

/** Build a single naked option leg (quantity: 1). */
function buildNakedLeg(
  symbol: string,
  expiry: string,
  optionType: OptionType,
  strike: number,
  side: LegAction,
): OptionLeg {
  return { type: 'option', symbol, expiry, optionType, strike, side, quantity: 1 };
}

/** Credit strategies receive premium (negative limit price). */
function isCreditStrategy(s: Strategy): boolean { return s === 'PCS' || s === 'CCS'; }

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

function optionTypeFromStrategy(strategy: Strategy): OptionType {
  return (strategy === 'CALL' || strategy === 'CDS' || strategy === 'CCS') ? 'CALL' : 'PUT';
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

  const messageDate = new Date(ctx.message.timestamp);
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
    try {
      resolvedExpiry = normalizeExpiry(parse.expiryHint, messageDate);
    } catch {
      resolvedExpiry = null;
    }
    if (!resolvedExpiry) {
      // Hint was unparseable — fall back to nearest available expiry
      log.debug('open-path: could not parse expiryHint "%s", falling back to nearest expiry', parse.expiryHint);
      if (strikeSelection.method !== 'premium_match') {
        let fallbackExpiries = await ctx.marketData.getExpiryDates(symbol);
        if (!fallbackExpiries.length) {
          fallbackExpiries = generateWeeklyExpiries(messageDate, 6);
        }
        if (fallbackExpiries.length > 0) {
          resolvedExpiry = fallbackExpiries[0];
          log.debug('open-path: fell back to nearest expiry %s for %s', resolvedExpiry, symbol);
        } else {
          return {
            outcome: 'MANUAL_REVIEW',
            reason: `Could not interpret expiryHint: "${parse.expiryHint}" and no fallback expiries available`,
          };
        }
      }
      // If premium_match, resolvedExpiry stays null and the scan loop below handles it
    } else {
      log.debug('open-path: resolved expiry %s from hint "%s"', resolvedExpiry, parse.expiryHint);
    }
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
        const legs = buildSpreadOptionLegs(strategy as SpreadStrategy, strikes[0], strikes[1], symbol, expiry);
        return { legs };
      } else {
        // Naked CALL or PUT
        const strike = strikes[0];
        const side = direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
        return { legs: [buildNakedLeg(symbol, expiry, optType, strike, side)] };
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
        const legs = buildSpreadOptionLegs(strategy as SpreadStrategy, atmStrike, otmStrike, symbol, expiry);
        return { legs };
      } else {
        const side = direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
        return { legs: [buildNakedLeg(symbol, expiry, optType, atmStrike, side)] };
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
      return { legs: [buildNakedLeg(symbol, expiry, optType, bestStrike, side)] };
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

        const legs = buildSpreadOptionLegs(strategy as SpreadStrategy, bestStrikes[0], bestStrikes[1], symbol, expiry);
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
        return { legs: [buildNakedLeg(symbol, expiry, optType, bestStrike, side)], limitPrice: statedPremium };
      }
    }

    return { error: 'Unknown strike selection method' };
  }

  // ── Handle STOCK strategy ────────────────────────────────────────────────────

  if (strategy === 'STOCK') {
    const side = direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
    const stockLeg: StockLeg = { type: 'stock', symbol, side, quantity: 1 };
    const signal: ResolvedSignal = { action: 'OPEN', orderType: 'STOCK', legs: [stockLeg] };
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
        action: 'OPEN',
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
    const optionLegs = getOptionLegs(resolvedLegs.legs);
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
    action: 'OPEN',
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
  let positions: TradePosition[];
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
  let candidates = positions;
  if (parse.strategy) {
    const byStrategy = positions.filter(p => p.strategy === parse.strategy);
    if (byStrategy.length > 0) {
      candidates = byStrategy;
    } else {
      // No strategy match. Block STOCK↔non-STOCK cross-type ADDs — these are
      // never benign (e.g. PDS should not merge into a STOCK position).
      // Treat as a new OPEN instead.
      const parseIsStock = parse.strategy === 'STOCK';
      const allCrossType = positions.every(p => (p.strategy === 'STOCK') !== parseIsStock);
      if (allCrossType) {
        log.debug(
          'ADD: strategy cross-type (%s vs positions [%s]) — treating as new OPEN',
          parse.strategy,
          positions.map(p => p.strategy).join(', '),
        );
        const enrichedParse: ParseResult = { ...parse, action: 'OPEN', direction: parse.direction };
        return resolveOpenPath(enrichedParse, ctx);
      }
    }
  }

  let matched: TradePosition | null = null;
  if (candidates.length === 1) {
    matched = candidates[0];
  } else if (candidates.length > 1) {
    // Multiple candidates — pick the most recently opened (LIFO)
    const sorted = [...candidates]
      .filter(p => p.openedAt != null)
      .sort((a, b) => b.openedAt!.localeCompare(a.openedAt!));
    if (sorted.length > 0) {
      matched = sorted[0];
      log.debug('ADD: multiple positions for %s — using most-recent: %s', parse.symbol, matched.id.slice(0, 8));
    }
  }

  // Infer direction: matched position first, then unanimous agreement across all positions
  let inferredDirection = parse.direction ?? matched?.direction ?? null;
  if (!inferredDirection && candidates.length > 0) {
    const dirs = new Set(candidates.map(p => p.direction));
    if (dirs.size === 1) {
      inferredDirection = candidates[0].direction;
      log.debug('ADD: inferred direction %s from %d unanimous positions', inferredDirection, candidates.length);
    }
  }

  // Enrich direction from the matched position when parse didn't determine it
  const enrichedParse: ParseResult = {
    ...parse,
    action: 'OPEN', // delegate to open-path as a new OPEN
    direction: inferredDirection,
    strategy: parse.strategy ?? matched?.strategy ?? null,
  };

  const result = await resolveOpenPath(enrichedParse, ctx);

  // If EXECUTE and we matched a position, stamp tradeId + action so executor ADDs to existing trade
  if (result.outcome === 'EXECUTE' && matched) {
    for (const signal of result.signals) {
      signal.tradeId = matched.id;
      signal.action = 'ADD';
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
