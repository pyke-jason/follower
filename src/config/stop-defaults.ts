/**
 * Server-side stop order configuration.
 *
 * Stops are GTC STP / STP LMT orders placed at IBKR immediately after entry fills.
 * They survive bot restarts: if the process dies, IBKR continues to protect positions.
 *
 * Supported strategies: STOCK, CALL, PUT (single-leg).
 * Not supported: CDS, PDS, CCS, PCS (spreads) — complex multi-leg close logic
 * required; tracked in backlog.
 *
 * Default stop levels (applied when the trader's signal has no explicit stop):
 *   STOCK  LONG : SELL STP at 5% below entry
 *   STOCK  SHORT: BUY  STP at 5% above entry
 *   OPTION LONG : SELL STP LMT at 50% of entry premium (lose half, preserve tail)
 *   OPTION SHORT: BUY  STP LMT at 3× entry premium (bail if buyback triples cost)
 *
 * STP LMT buffer: limit price is 10% worse than the stop trigger to avoid
 * missing fills in fast markets while still bounding extreme slippage.
 */

import type { Direction, Strategy } from '@/lib/enums.js';
import type { OrderLeg, StopOrderParams } from '@/broker/types.js';
import { roundCents } from '@/lib/numbers.js';

export const STOP_DEFAULTS = {
  /** Maximum loss fraction for long stock before stop triggers. */
  STOCK_LOSS_PCT: 0.05,
  /** Maximum loss fraction of premium for long options. */
  OPTION_LONG_LOSS_PCT: 0.50,
  /** Maximum buyback multiple for short options (stop when cost = 3× received). */
  OPTION_SHORT_GAIN_MULT: 3.0,
  /** STP LMT: limit is this fraction worse than the trigger (prevents gap-slippage void). */
  STP_LMT_BUFFER_PCT: 0.10,
} as const;

/** Returns true when server-side stops are supported for this strategy. */
export function isStopSupportedStrategy(strategy: Strategy): boolean {
  return strategy === 'STOCK' || strategy === 'CALL' || strategy === 'PUT';
}

/**
 * Compute stop order parameters for a newly-filled OPEN trade.
 *
 * Returns null for unsupported strategies (spreads) — caller should log + skip.
 * entryPrice is per-share / per-unit (the fill price from the order).
 */
export function computeStopParams(
  strategy: Strategy,
  direction: Direction,
  entryPrice: number,
  legs: OrderLeg[],
  quantity: number,
): StopOrderParams | null {
  if (!isStopSupportedStrategy(strategy)) return null;
  if (legs.length !== 1) return null;

  const leg = legs[0];
  const symbol = legs[0].symbol.split(' ')[0]; // extract underlying from OCC symbol

  if (strategy === 'STOCK') {
    const isLong = direction === 'LONG';
    const stopPrice = isLong
      ? roundCents(entryPrice * (1 - STOP_DEFAULTS.STOCK_LOSS_PCT))
      : roundCents(entryPrice * (1 + STOP_DEFAULTS.STOCK_LOSS_PCT));

    return {
      symbol,
      strategy,
      legs,
      stopAction: isLong ? 'SELL' : 'BUY',
      quantity,
      stopPrice,
      // Pure STP for stocks — tight spreads make market stop acceptable
    };
  }

  // Single-leg option (CALL or PUT)
  const isLong = direction === 'LONG';
  let stopPrice: number;

  if (isLong) {
    // Long option: stop when premium loses 50%
    stopPrice = roundCents(entryPrice * (1 - STOP_DEFAULTS.OPTION_LONG_LOSS_PCT));
  } else {
    // Short option: stop when buyback price reaches 3× what we received
    stopPrice = roundCents(entryPrice * STOP_DEFAULTS.OPTION_SHORT_GAIN_MULT);
  }

  // STP LMT: limit is 10% worse than trigger to survive fast markets
  const limitPrice = isLong
    ? roundCents(stopPrice * (1 - STOP_DEFAULTS.STP_LMT_BUFFER_PCT))
    : roundCents(stopPrice * (1 + STOP_DEFAULTS.STP_LMT_BUFFER_PCT));

  // Floor: option price can't go below $0.01
  const clampedStop = Math.max(0.01, stopPrice);
  const clampedLimit = Math.max(0.01, limitPrice);

  return {
    symbol,
    strategy,
    legs,
    stopAction: isLong ? 'SELL' : 'BUY',
    quantity,
    stopPrice: clampedStop,
    limitPrice: clampedLimit,
  };
}
