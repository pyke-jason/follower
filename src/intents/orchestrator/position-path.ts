/**
 * Position path resolver for CLOSE, TRIM, and LEG_OFF signals.
 *
 * Looks up the trader's existing open position for the given symbol and produces
 * the reversal legs needed to close, trim, or leg off the position.
 */

import { createLogger } from '../../lib/logger.js';
import type {
  ParseResult,
  OrchestratorContext,
  OrchestratorResult,
  OpenPosition,
  OptionLeg,
  StockLeg,
  Leg,
  ResolvedSignal,
} from './types.js';

const log = createLogger('Orchestrator:PositionPath');

/**
 * Extract the underlying ticker from an OCC option symbol or return the symbol
 * as-is if it's already a plain ticker.
 *
 * OCC format: "AAPL  260307C00180000" — leading alpha chars before the date.
 * Spaces between the ticker and date are variable (0–5).
 */
function extractUnderlying(occOrTicker: string): string {
  // OCC symbols have a 6-digit date immediately after the ticker (with optional spaces)
  const match = /^([A-Z]{1,6})\s*\d{6}[CP]/i.exec(occOrTicker);
  return match ? match[1] : occOrTicker;
}

/** Reverse a side: BUY → SELL, SELL → BUY. */
function reverseSide(side: 'BUY' | 'SELL'): 'BUY' | 'SELL' {
  return side === 'BUY' ? 'SELL' : 'BUY';
}

/**
 * Convert a position leg into a Leg (OptionLeg or StockLeg) with sides reversed
 * for closing and the given quantity.
 */
function buildReversalLeg(
  positionLeg: OpenPosition['legs'][number],
  underlyingSymbol: string,
  quantity: number,
): Leg {
  if (positionLeg.type === 'stock') {
    const leg: StockLeg = {
      type: 'stock',
      symbol: underlyingSymbol,
      side: reverseSide(positionLeg.side),
      quantity,
    };
    return leg;
  }

  const leg: OptionLeg = {
    type: 'option',
    symbol: extractUnderlying(positionLeg.symbol) || underlyingSymbol,
    expiry: positionLeg.expiry,
    optionType: positionLeg.optionType ?? (positionLeg.symbol.includes('C') ? 'CALL' : 'PUT'),
    strike: positionLeg.strike,
    side: reverseSide(positionLeg.side),
    quantity,
  };
  return leg;
}

/** Determine orderType from the legs array. */
function orderTypeFromLegs(legs: Leg[]): 'SINGLE' | 'SPREAD' | 'STOCK' {
  if (legs.length >= 2) return 'SPREAD';
  if (legs[0]?.type === 'stock') return 'STOCK';
  return 'SINGLE';
}

/**
 * Match an open position from the candidate list using fuzzy matching rules.
 *
 * Returns the matched position or null if no unambiguous match is found, along
 * with a reason string for FLAG_FOR_REVIEW cases.
 */
function matchPosition(
  positions: OpenPosition[],
  parse: ParseResult,
): { position: OpenPosition } | { flagReason: string } {
  const symbol = parse.symbol!; // caller ensures non-null

  // Primary filter: symbol match
  const bySymbol = positions.filter((p) => p.symbol === symbol);

  if (bySymbol.length === 0) {
    return { flagReason: `no open position found for ${symbol}` };
  }

  // Strategy filter
  let candidates = bySymbol;
  if (parse.strategy !== null) {
    const byStrategy = bySymbol.filter((p) => p.strategy === parse.strategy);

    if (byStrategy.length === 0) {
      // Fuzzy fallback: if only one position for this symbol, use it regardless of strategy
      if (bySymbol.length === 1) {
        log.debug(
          `strategy mismatch for ${symbol}: parse=${parse.strategy}, position=${bySymbol[0].strategy} — using fuzzy fallback`,
        );
        candidates = bySymbol;
      } else {
        // Multiple positions with no strategy match — ambiguous
        return {
          flagReason: `multiple positions found for ${symbol}, cannot determine which to close`,
        };
      }
    } else {
      candidates = byStrategy;
    }
  }

  // Exactly one candidate — use it
  if (candidates.length === 1) {
    return { position: candidates[0] };
  }

  // Multiple candidates — try direction tie-breaking
  if (parse.direction !== null) {
    const byDirection = candidates.filter((p) => p.direction === parse.direction);
    if (byDirection.length === 1) {
      return { position: byDirection[0] };
    }
  } else {
    // Default: prefer LONG positions (most common open position type)
    const longPositions = candidates.filter((p) => p.direction === 'LONG');
    if (longPositions.length === 1) {
      return { position: longPositions[0] };
    }
  }

  return {
    flagReason: `multiple positions found for ${symbol}, cannot determine which to close`,
  };
}

/**
 * Build reversal legs for a full CLOSE of the matched position.
 */
function buildCloseLegs(position: OpenPosition, underlyingSymbol: string): Leg[] {
  return position.legs.map((leg) =>
    buildReversalLeg(leg, underlyingSymbol, position.quantity),
  );
}

/**
 * Build reversal legs for a TRIM of the matched position.
 */
function buildTrimLegs(
  position: OpenPosition,
  underlyingSymbol: string,
  exitPercent: number,
): Leg[] | { flagReason: string } {
  const trimQuantity = Math.round(position.quantity * exitPercent);
  if (trimQuantity < 1) {
    return {
      flagReason: `trim quantity rounds to 0 (position qty=${position.quantity}, exitPercent=${exitPercent})`,
    };
  }
  return position.legs.map((leg) => buildReversalLeg(leg, underlyingSymbol, trimQuantity));
}

/**
 * Build the single reversal leg for a LEG_OFF action.
 *
 * targetStrategy identifies the leg to KEEP; the opposite leg is closed.
 *
 * For CDS (BUY lower CALL + SELL upper CALL):
 *   - targetStrategy=CALL → keep the BUY (long) leg → close the SELL leg (BUY back upper call)
 *
 * For PDS (BUY upper PUT + SELL lower PUT):
 *   - targetStrategy=PUT → keep the BUY (long) leg → close the SELL leg (BUY back lower put)
 *
 * General rule: find the SELL leg (short leg) and close it, since the caller
 * wants to "hold straight [target]" which means keeping the long/bought side.
 */
function buildLegOffLegs(
  position: OpenPosition,
  underlyingSymbol: string,
  targetStrategy: NonNullable<ParseResult['targetStrategy']>,
): Leg[] | { flagReason: string } {
  const legs = position.legs;

  if (legs.length < 2) {
    return { flagReason: `LEG_OFF requires a spread position but found ${legs.length} leg(s)` };
  }

  // Determine the option type we want to KEEP based on targetStrategy
  const keepOptionType: 'CALL' | 'PUT' | null =
    targetStrategy === 'CALL'
      ? 'CALL'
      : targetStrategy === 'PUT'
        ? 'PUT'
        : null;

  if (keepOptionType !== null) {
    // Find the leg to CLOSE: the leg that is NOT the keepOptionType
    // (i.e., the other option type, which is the one being legged off)
    const legToClose = legs.find(
      (l) => l.type === 'option' && l.optionType !== keepOptionType,
    );

    if (legToClose) {
      return [buildReversalLeg(legToClose, underlyingSymbol, position.quantity)];
    }

    // Same option type on both legs (e.g. a vertical spread) — close the SELL leg
    const sellLeg = legs.find((l) => l.side === 'SELL');
    if (sellLeg) {
      log.debug(
        `LEG_OFF: both legs are ${keepOptionType}, closing SELL leg for ${underlyingSymbol}`,
      );
      return [buildReversalLeg(sellLeg, underlyingSymbol, position.quantity)];
    }
  } else {
    // targetStrategy is not CALL/PUT (e.g. CDS/PDS/STOCK) — fall back to closing SELL leg
    const sellLeg = legs.find((l) => l.side === 'SELL');
    if (sellLeg) {
      return [buildReversalLeg(sellLeg, underlyingSymbol, position.quantity)];
    }
  }

  return {
    flagReason: `LEG_OFF: could not determine which leg to close for ${underlyingSymbol} (targetStrategy=${targetStrategy})`,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function resolvePositionPath(
  parse: ParseResult,
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  // Step 1: Validate required fields
  if (parse.symbol === null) {
    return {
      outcome: 'FLAG_FOR_REVIEW',
      reason: 'position path requires a symbol but none was parsed',
    };
  }

  if (
    parse.action !== 'CLOSE' &&
    parse.action !== 'TRIM' &&
    parse.action !== 'LEG_OFF'
  ) {
    return {
      outcome: 'FLAG_FOR_REVIEW',
      reason: `resolvePositionPath called with invalid action: ${parse.action ?? 'null'}`,
    };
  }

  const symbol = parse.symbol;
  const action = parse.action;

  // Step 2: Look up open positions
  let positions: OpenPosition[];
  try {
    positions = await ctx.positions.getPositions(symbol);
  } catch (err) {
    log.error('getPositions failed for', symbol, err);
    return {
      outcome: 'FLAG_FOR_REVIEW',
      reason: `failed to fetch positions for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 3: Match position with fuzzy logic
  const matchResult = matchPosition(positions, parse);

  if ('flagReason' in matchResult) {
    return { outcome: 'FLAG_FOR_REVIEW', reason: matchResult.flagReason };
  }

  const { position } = matchResult;

  log.debug(
    `${action} matched position id=${position.id} symbol=${position.symbol} strategy=${position.strategy} direction=${position.direction} qty=${position.quantity}`,
  );

  // Step 4: Build reversal legs based on action
  let legs: Leg[];

  if (action === 'CLOSE') {
    legs = buildCloseLegs(position, symbol);
  } else if (action === 'TRIM') {
    const exitPercent = parse.exitPercent ?? 0.5;
    const result = buildTrimLegs(position, symbol, exitPercent);
    if ('flagReason' in result) {
      return { outcome: 'FLAG_FOR_REVIEW', reason: result.flagReason };
    }
    legs = result;
  } else {
    // LEG_OFF
    if (parse.targetStrategy === null) {
      return {
        outcome: 'FLAG_FOR_REVIEW',
        reason: 'LEG_OFF requires knowing which leg to keep (targetStrategy is null)',
      };
    }
    const result = buildLegOffLegs(position, symbol, parse.targetStrategy);
    if ('flagReason' in result) {
      return { outcome: 'FLAG_FOR_REVIEW', reason: result.flagReason };
    }
    legs = result;
  }

  if (legs.length === 0) {
    return {
      outcome: 'FLAG_FOR_REVIEW',
      reason: `no reversal legs could be built for ${symbol} (position has ${position.legs.length} legs)`,
    };
  }

  // Step 5: Build ResolvedSignal
  // Note: limitPrice is NOT set — closing orders use price-chase logic in the execution pipeline
  const signal: ResolvedSignal = {
    orderType: orderTypeFromLegs(legs),
    legs,
    tradeId: position.id,
    ...(action === 'TRIM' && { exitPercent: parse.exitPercent ?? 0.5 }),
  };

  return { outcome: 'EXECUTE', signals: [signal] };
}
