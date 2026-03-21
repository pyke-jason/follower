/**
 * Position path resolver for CLOSE, TRIM, and LEG_OFF signals.
 *
 * Looks up the trader's existing open position for the given symbol and produces
 * the reversal legs needed to close, trim, or leg off the position.
 */

import type { LegAction, OptionType, OrderCategory } from '@/lib/enums.js';
import type { TradeLeg } from '@/db/schema.js';
import { createLogger } from '@/lib/logger.js';
import { extractUnderlying } from '@/lib/occ-symbology.js';
import { addTradeFlags } from '@/trades/trade-flags.js';
import type {
  ParseResult,
  OrchestratorContext,
  OrchestratorResult,
  TradePosition,
  OptionLeg,
  StockLeg,
  Leg,
  ResolvedSignal,
} from './types.js';

const log = createLogger('Orchestrator:PositionPath');

/** Reverse a side: BUY → SELL, SELL → BUY. */
function reverseSide(side: LegAction): LegAction {
  return side === 'BUY' ? 'SELL' : 'BUY';
}

/**
 * Convert a position leg into a Leg (OptionLeg or StockLeg) with sides reversed
 * for closing and the given quantity.
 */
export function buildReversalLeg(
  positionLeg: TradeLeg,
  underlyingSymbol: string,
  quantity: number,
): Leg {
  if (positionLeg.type === 'STOCK') {
    const leg: StockLeg = {
      type: 'stock',
      symbol: underlyingSymbol,
      side: reverseSide(positionLeg.action),
      quantity,
    };
    return leg;
  }

  const leg: OptionLeg = {
    type: 'option',
    symbol: extractUnderlying(positionLeg.symbol) || underlyingSymbol,
    expiry: positionLeg.expiry,
    optionType: positionLeg.type,
    strike: positionLeg.strike,
    side: reverseSide(positionLeg.action),
    quantity,
  };
  return leg;
}

/** Determine orderType from the legs array. */
function orderTypeFromLegs(legs: Leg[]): OrderCategory {
  if (legs.length >= 2) return 'SPREAD';
  if (legs[0]?.type === 'stock') return 'STOCK';
  return 'SINGLE';
}

/**
 * Match an open position from the candidate list using fuzzy matching rules.
 *
 * Returns the matched position or null if no unambiguous match is found, along
 * with a reason string for MANUAL_REVIEW cases.
 */
function matchPosition(
  positions: TradePosition[],
  parse: ParseResult,
): { position: TradePosition; strategyMismatch?: boolean } | { flagReason: string } {
  const symbol = parse.symbol!; // caller ensures non-null

  // Primary filter: symbol match
  const bySymbol = positions.filter((p) => p.symbol === symbol);

  if (bySymbol.length === 0) {
    return { flagReason: `no open position found for ${symbol}` };
  }

  // Strategy filter
  let candidates = bySymbol;
  let strategyMismatch = false;
  if (parse.strategy !== null) {
    const byStrategy = bySymbol.filter((p) => p.strategy === parse.strategy);

    if (byStrategy.length === 0) {
      // Fuzzy fallback: if only one position for this symbol, use it regardless of strategy
      if (bySymbol.length === 1) {
        log.warn(
          `strategy mismatch for ${symbol}: parse=${parse.strategy}, position=${bySymbol[0].strategy} — using fuzzy fallback`,
        );
        candidates = bySymbol;
        strategyMismatch = true;

        // Block STOCK <-> non-STOCK cross-type mismatches — these are never benign.
        // OPTION <-> SPREAD mismatches ARE benign (e.g., "exit my calls" on a CDS
        // after LEG_OFF, or "exit puts" on a PDS).
        const posIsStock = bySymbol[0].strategy === 'STOCK';
        const parseIsStock = parse.strategy === 'STOCK';
        if (posIsStock !== parseIsStock) {
          return {
            flagReason: `strategy mismatch: parse=${parse.strategy}, ` +
              `position=${bySymbol[0].strategy} — refusing STOCK/non-STOCK cross-type close`,
          };
        }
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
    return { position: candidates[0], strategyMismatch };
  }

  // Multiple candidates — try direction tie-breaking only when direction was explicitly parsed
  if (parse.direction !== null) {
    const byDirection = candidates.filter((p) => p.direction === parse.direction);
    if (byDirection.length === 1) {
      return { position: byDirection[0], strategyMismatch };
    }
  }

  // Fallback: close the most recently opened position (LIFO heuristic).
  // Traders typically reference their most recent entry when posting exits.
  const withTimestamp = candidates.filter(p => p.openedAt != null);
  if (withTimestamp.length > 0) {
    withTimestamp.sort((a, b) => b.openedAt!.localeCompare(a.openedAt!));
    log.warn(
      `multiple positions for ${symbol} — using most-recent heuristic: ` +
      `${withTimestamp[0].id.slice(0, 8)} (${withTimestamp.length} candidates)`,
    );
    return { position: withTimestamp[0], strategyMismatch };
  }

  return {
    flagReason: `multiple positions found for ${symbol}, cannot determine which to close`,
  };
}

/**
 * Build reversal legs for a full CLOSE of the matched position.
 */
function buildCloseLegs(position: TradePosition, underlyingSymbol: string): Leg[] {
  const qty = position.quantity ?? 1;
  return position.legs.map((leg) =>
    buildReversalLeg(leg, underlyingSymbol, qty),
  );
}

/**
 * Build reversal legs for a TRIM of the matched position.
 */
function buildTrimLegs(
  position: TradePosition,
  underlyingSymbol: string,
  exitPercent: number,
): Leg[] | { flagReason: string } {
  const qty = position.quantity ?? 1;
  const trimQuantity = Math.round(qty * exitPercent);
  if (trimQuantity < 1) {
    return {
      flagReason: `trim quantity rounds to 0 (position qty=${qty}, exitPercent=${exitPercent})`,
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
  position: TradePosition,
  underlyingSymbol: string,
  targetStrategy: NonNullable<ParseResult['targetStrategy']>,
): Leg[] | { flagReason: string } {
  const legs = position.legs;
  const qty = position.quantity ?? 1;

  if (legs.length < 2) {
    return { flagReason: `LEG_OFF requires a spread position but found ${legs.length} leg(s)` };
  }

  // Vertical spread fast path: when all option legs share the same type
  // (both PUT for PDS/PCS, both CALL for CDS/CCS), always close the SELL leg.
  // This is deterministic and bypasses any targetStrategy errors.
  const optionLegs = legs.filter(l => l.type !== 'STOCK');
  if (optionLegs.length >= 2 && optionLegs.every(l => l.type === optionLegs[0].type)) {
    const sellLeg = legs.find(l => l.action === 'SELL');
    if (sellLeg) {
      log.debug(
        `LEG_OFF: vertical spread (all ${optionLegs[0].type}), closing SELL leg for ${underlyingSymbol}`,
      );
      return [buildReversalLeg(sellLeg, underlyingSymbol, qty)];
    }
  }

  // Determine the option type we want to KEEP based on targetStrategy
  const keepOptionType: OptionType | null =
    targetStrategy === 'CALL'
      ? 'CALL'
      : targetStrategy === 'PUT'
        ? 'PUT'
        : null;

  if (keepOptionType !== null) {
    // Find the leg to CLOSE: the leg that is NOT the keepOptionType
    // (i.e., the other option type, which is the one being legged off)
    const legToClose = legs.find(
      (l) => l.type !== 'STOCK' && l.type !== keepOptionType,
    );

    if (legToClose) {
      return [buildReversalLeg(legToClose, underlyingSymbol, qty)];
    }

    // Same option type on both legs (e.g. a vertical spread) — close the SELL leg
    const sellLeg = legs.find((l) => l.action === 'SELL');
    if (sellLeg) {
      log.debug(
        `LEG_OFF: both legs are ${keepOptionType}, closing SELL leg for ${underlyingSymbol}`,
      );
      return [buildReversalLeg(sellLeg, underlyingSymbol, qty)];
    }
  } else {
    // targetStrategy is not CALL/PUT (e.g. CDS/PDS/STOCK) — fall back to closing SELL leg
    const sellLeg = legs.find((l) => l.action === 'SELL');
    if (sellLeg) {
      return [buildReversalLeg(sellLeg, underlyingSymbol, qty)];
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
      outcome: 'MANUAL_REVIEW',
      reason: 'position path requires a symbol but none was parsed',
    };
  }

  if (
    parse.action !== 'CLOSE' &&
    parse.action !== 'TRIM' &&
    parse.action !== 'LEG_OFF'
  ) {
    return {
      outcome: 'MANUAL_REVIEW',
      reason: `resolvePositionPath called with invalid action: ${parse.action ?? 'null'}`,
    };
  }

  const symbol = parse.symbol;
  const action = parse.action;

  // Step 2: Look up open positions
  let positions: TradePosition[];
  try {
    positions = await ctx.positions.getPositions(symbol);
  } catch (err) {
    log.error('getPositions failed for', symbol, err);
    return {
      outcome: 'MANUAL_REVIEW',
      reason: `failed to fetch positions for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 3: Match position with fuzzy logic
  const matchResult = matchPosition(positions, parse);

  if ('flagReason' in matchResult) {
    return { outcome: 'MANUAL_REVIEW', reason: matchResult.flagReason };
  }

  const { position, strategyMismatch } = matchResult;

  if (strategyMismatch) {
    await addTradeFlags(position.id, 'strategyMismatch');
  }

  log.debug(
    `${action} matched position id=${position.id} symbol=${position.symbol} strategy=${position.strategy} direction=${position.direction} qty=${position.quantity}`,
  );

  // Step 4: Build reversal legs based on action
  let legs: Leg[];
  let trimExitPercent: number | undefined;

  if (action === 'CLOSE') {
    legs = buildCloseLegs(position, symbol);
  } else if (action === 'TRIM') {
    if (parse.exitPercent === null || parse.exitPercent === undefined) {
      return {
        outcome: 'MANUAL_REVIEW',
        reason: 'TRIM without explicit exit percentage',
      };
    }
    trimExitPercent = parse.exitPercent;
    const result = buildTrimLegs(position, symbol, trimExitPercent);
    if ('flagReason' in result) {
      return { outcome: 'MANUAL_REVIEW', reason: result.flagReason };
    }
    legs = result;
  } else {
    // LEG_OFF
    if (parse.targetStrategy === null) {
      return {
        outcome: 'MANUAL_REVIEW',
        reason: 'LEG_OFF requires knowing which leg to keep (targetStrategy is null)',
      };
    }
    const result = buildLegOffLegs(position, symbol, parse.targetStrategy);
    if ('flagReason' in result) {
      return { outcome: 'MANUAL_REVIEW', reason: result.flagReason };
    }
    legs = result;
  }

  if (legs.length === 0) {
    return {
      outcome: 'MANUAL_REVIEW',
      reason: `no reversal legs could be built for ${symbol} (position has ${position.legs.length} legs)`,
    };
  }

  // Step 5: Build ResolvedSignal
  // Note: limitPrice is NOT set — closing orders use price-chase logic in the execution pipeline
  const signal: ResolvedSignal = {
    orderType: orderTypeFromLegs(legs),
    legs,
    action,
    tradeId: position.id,
    ...(action === 'TRIM' && { exitPercent: trimExitPercent }),
  };

  return { outcome: 'EXECUTE', signals: [signal] };
}
