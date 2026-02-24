/**
 * Signal → OrderLeg[] construction.
 *
 * This module owns the full transformation from what the LLM emitted to the
 * exact legs the broker/sim-broker will use. The key design rule:
 *
 *   The LLM handles irreducible ambiguity only — action, symbol, strategy,
 *   direction, strikes, expiry. Everything derivable from first principles
 *   is computed here, never trusted from the model output.
 *
 * For two-leg spreads (PDS/CDS), `action` and `optionType` on each leg are
 * fully determined by strategy + direction + two strikes. We ignore whatever
 * the model emitted for those fields and recompute via `spreadLegs()`.
 *
 * See .claude/rules/llm-complexity-boundary.md for the full design rationale
 * and real-world message examples that motivated these rules.
 */

import type { BrokerService } from '../broker/interface.js';
import type { OrderLeg, Quote } from '../broker/types.js';
import type { Signal } from '../agent/schemas.js';
import { formatOccSymbol, normalizeExpiry, inferATMSpread, inferATMStrike } from '../backtest/occ-symbology.js';
import { nextFriday } from '../lib/et-date.js';
import { spreadLegs } from '../lib/spread-legs.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Pipeline');

/**
 * Build the exact OrderLeg[] for a signal whose strikes are already known.
 *
 * - STOCK: single BUY/SELL leg based on direction.
 * - PDS/CDS with 2 strikes: fully deterministic via spreadLegs(). LLM's
 *   action/optionType fields on individual legs are ignored.
 * - Naked CALL/PUT, or spreads where the LLM only emitted one hint-leg:
 *   trusts the LLM's action/optionType (strike must be > 0).
 */
export function buildOrderLegs(signal: Signal, quantity: number, referenceDate: Date): OrderLeg[] {
  if (signal.strategy === 'STOCK') {
    return [{
      symbol: signal.symbol,
      strike: 0,
      expiry: '',
      type: 'STOCK' as const,
      action: signal.direction === 'LONG' ? 'BUY' as const : 'SELL' as const,
      quantity,
    }];
  }

  if (!signal.legs || signal.legs.length === 0) {
    throw new Error(`Options signal for ${signal.symbol} (${signal.action} ${signal.strategy}) missing legs`);
  }

  // Deduplicate legs by strike+expiry — LLM occasionally emits duplicates
  const seen = new Set<string>();
  const uniqueLegs = signal.legs.filter(l => {
    const key = `${l.strike}|${l.expiry}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (uniqueLegs.length < signal.legs.length) {
    log.info(`${signal.symbol} ${signal.action}: deduped ${signal.legs.length} legs → ${uniqueLegs.length}`);
  }

  // Two-leg spreads: derive action + optionType deterministically.
  // The LLM only needs to emit the two strike numbers.
  if ((signal.strategy === 'PDS' || signal.strategy === 'CDS') && uniqueLegs.length === 2) {
    const strikes = uniqueLegs.map(l => l.strike).filter(s => s > 0);
    if (strikes.length === 2) {
      const expiryRaw = uniqueLegs.find(l => l.expiry && l.expiry !== '-')?.expiry;
      const expiry = expiryRaw ? normalizeExpiry(expiryRaw, referenceDate) : nextFriday(referenceDate);
      return spreadLegs(signal.strategy, signal.direction, strikes[0], strikes[1]).map(({ strike, action, optionType }) => ({
        symbol: formatOccSymbol({ underlying: signal.symbol, expiration: expiry, type: optionType, strike }),
        strike,
        expiry,
        type: optionType,
        action,
        quantity,
      }));
    }
  }

  // Naked CALL/PUT, or degenerate spread (< 2 valid strikes): trust the LLM
  return uniqueLegs.map(l => {
    const expiry = l.expiry && l.expiry !== '-' ? normalizeExpiry(l.expiry, referenceDate) : nextFriday(referenceDate);
    return {
      symbol: formatOccSymbol({
        underlying: signal.symbol,
        expiration: expiry,
        type: l.optionType,
        strike: l.strike,
      }),
      strike: l.strike,
      expiry,
      type: l.optionType as 'CALL' | 'PUT',
      action: l.action as 'BUY' | 'SELL',
      quantity,
    };
  });
}

/**
 * If the LLM omitted strikes (trader didn't state them), infer ATM legs from
 * the current stock price and return a resolved signal with concrete legs.
 *
 * Also strips any hint-legs that have strike=0 but carry an expiry, so
 * callers always see legs with real strikes after this call.
 */
export async function resolveSignalLegs(
  signal: Signal,
  broker: BrokerService,
  messageTimestamp?: string,
): Promise<{ signal: Signal; stockQuote: Quote | null }> {
  if (signal.strategy === 'STOCK') return { signal, stockQuote: null };

  const validLegs = signal.legs?.filter(l => l.strike > 0);
  if (validLegs && validLegs.length > 0) return { signal: { ...signal, legs: validLegs }, stockQuote: null };

  const quote = await broker.getQuote(signal.symbol);
  const stockPrice = (quote.bid + quote.ask) / 2;
  const refDate = messageTimestamp ? new Date(messageTimestamp) : new Date();

  // Preserve expiry hint from any strike=0 leg (e.g. model emits expiry:"LEAP" with no strike)
  const expiryHintLeg = signal.legs?.find(l => l.strike === 0 && l.expiry && l.expiry !== '-');
  const expiry = expiryHintLeg ? normalizeExpiry(expiryHintLeg.expiry!, refDate) : nextFriday(refDate);

  if (signal.strategy === 'CDS' || signal.strategy === 'PDS') {
    const { longStrike, shortStrike } = inferATMSpread(stockPrice, signal.strategy);
    // Use spreadLegs() so direction is respected even for ATM-inferred positions
    return {
      signal: {
        ...signal,
        legs: spreadLegs(signal.strategy, signal.direction, longStrike, shortStrike)
          .map(({ strike, action, optionType }) => ({ strike, expiry, optionType, action })),
      },
      stockQuote: quote,
    };
  }

  // Naked CALL or PUT
  const strike = inferATMStrike(stockPrice);
  const action = signal.direction === 'LONG' ? 'BUY' as const : 'SELL' as const;
  return {
    signal: {
      ...signal,
      legs: [{ strike, expiry, optionType: signal.strategy as 'CALL' | 'PUT', action }],
    },
    stockQuote: quote,
  };
}
