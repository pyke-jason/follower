/**
 * Reg-T Margin Model for the backtest simulator.
 *
 * Computes initial margin (required to open), maintenance margin (ongoing
 * requirement), and the cash effect (debit/credit) for each supported strategy.
 *
 * Strategies:
 *   STOCK  (LONG/SHORT)
 *   CALL   (LONG = buy call, SHORT = naked short call)
 *   PUT    (LONG = buy put, SHORT = naked short put)
 *   CDS    (LONG = call debit spread, SHORT = call credit spread)
 *   PDS    (LONG = put debit spread, SHORT = put credit spread)
 */

import type { TradeLeg } from '../db/schema.js';

// ─── Types ──────────────────────────────────────────

export type MarginParams = {
  strategy: string;
  direction: 'LONG' | 'SHORT';
  /** Fill price (net premium for options/spreads, stock price for equities). */
  entryPrice: number;
  quantity: number;
  legs: TradeLeg[];
  /** Current market price of the underlying stock (used for naked option margin). */
  underlyingPrice: number;
};

export type MarginRequirement = {
  /** Capital required to open the position. */
  initial: number;
  /** Ongoing requirement — equity must exceed this or margin call triggers. */
  maintenance: number;
  /**
   * Cash effect when opening the position.
   * Negative = cash paid (debit), positive = cash received (credit).
   */
  cashEffect: number;
};

// ─── Helpers ────────────────────────────────────────

/** Get absolute difference between the two strikes of a vertical spread. */
export function getSpreadWidth(legs: TradeLeg[]): number {
  const strikes = legs.filter(l => l.type !== 'STOCK').map(l => l.strike);
  if (strikes.length < 2) return 0;
  return Math.abs(strikes[0] - strikes[1]);
}

/**
 * Naked call margin (Reg T):
 *   max(20% × underlying − OTM amount + premium, 10% × underlying + premium)
 * per contract (×100 × qty applied by caller).
 */
function nakedCallMarginPerContract(
  underlyingPrice: number,
  strike: number,
  premium: number,
): number {
  const otm = Math.max(0, strike - underlyingPrice);
  const a = 0.20 * underlyingPrice - otm + premium;
  const b = 0.10 * underlyingPrice + premium;
  return Math.max(a, b);
}

/**
 * Naked put margin (Reg T):
 *   max(20% × underlying − OTM amount + premium, 10% × strike + premium)
 * per contract (×100 × qty applied by caller).
 */
function nakedPutMarginPerContract(
  underlyingPrice: number,
  strike: number,
  premium: number,
): number {
  const otm = Math.max(0, underlyingPrice - strike);
  const a = 0.20 * underlyingPrice - otm + premium;
  const b = 0.10 * strike + premium;
  return Math.max(a, b);
}

// ─── Main ───────────────────────────────────────────

export function computeMarginRequirement(params: MarginParams): MarginRequirement {
  const { strategy, direction, entryPrice, quantity, legs, underlyingPrice } = params;
  const contractMult = 100;

  switch (strategy) {
    // ── Equities ──────────────────────────────────────
    case 'STOCK': {
      const marketValue = entryPrice * quantity;
      if (direction === 'LONG') {
        // Reg T: 50% initial, 25% maintenance
        return {
          initial: marketValue * 0.50,
          maintenance: underlyingPrice * quantity * 0.25,
          cashEffect: -marketValue,
        };
      }
      // SHORT stock: 50% initial margin, 30% maintenance
      return {
        initial: marketValue * 0.50,
        maintenance: underlyingPrice * quantity * 0.30,
        cashEffect: marketValue, // short sale proceeds held
      };
    }

    // ── Single-leg options ────────────────────────────
    case 'CALL': {
      const premium = entryPrice * quantity * contractMult;
      if (direction === 'LONG') {
        // Long call: fully funded, no ongoing maintenance
        return { initial: premium, maintenance: 0, cashEffect: -premium };
      }
      // Naked short call
      const perContract = nakedCallMarginPerContract(underlyingPrice, legs[0]?.strike ?? 0, entryPrice);
      const margin = perContract * quantity * contractMult;
      return { initial: margin, maintenance: margin, cashEffect: premium };
    }
    case 'PUT': {
      const premium = entryPrice * quantity * contractMult;
      if (direction === 'LONG') {
        return { initial: premium, maintenance: 0, cashEffect: -premium };
      }
      // Naked short put
      const perContract = nakedPutMarginPerContract(underlyingPrice, legs[0]?.strike ?? 0, entryPrice);
      const margin = perContract * quantity * contractMult;
      return { initial: margin, maintenance: margin, cashEffect: premium };
    }

    // ── Vertical spreads ─────────────────────────────
    case 'CDS':
    case 'PDS': {
      const width = getSpreadWidth(legs);
      if (direction === 'LONG') {
        // Debit spread: pay net debit. Max loss = debit paid. Fully funded.
        const debit = entryPrice * quantity * contractMult;
        return { initial: debit, maintenance: 0, cashEffect: -debit };
      }
      // Credit spread: receive net credit. Margin = spread width (max loss).
      const credit = entryPrice * quantity * contractMult;
      const maxLoss = width * quantity * contractMult;
      return { initial: maxLoss, maintenance: maxLoss, cashEffect: credit };
    }

    default:
      // Unknown strategy — treat as fully margined at notional value
      return {
        initial: Math.abs(entryPrice * quantity * contractMult),
        maintenance: Math.abs(entryPrice * quantity * contractMult),
        cashEffect: direction === 'LONG'
          ? -(entryPrice * quantity * contractMult)
          : entryPrice * quantity * contractMult,
      };
  }
}

/**
 * Compute the cash effect when closing a position.
 * This reverses the opening cash flow and adds the realized PnL.
 */
export function computeCloseCashEffect(params: {
  strategy: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  legs: TradeLeg[];
}): number {
  const { strategy, direction, entryPrice, exitPrice, quantity } = params;
  const contractMult = strategy === 'STOCK' ? 1 : 100;

  if (strategy === 'STOCK') {
    if (direction === 'LONG') {
      // Sell the shares: get back proceeds
      return exitPrice * quantity;
    }
    // Cover short: pay to buy back
    return -(exitPrice * quantity);
  }

  // Options & spreads
  if (direction === 'LONG') {
    // Sell to close: receive exit premium
    return exitPrice * quantity * contractMult;
  }
  // Buy to close short position: pay exit premium
  return -(exitPrice * quantity * contractMult);
}
