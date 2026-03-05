/**
 * Reg-T Margin Model for the backtest simulator.
 *
 * Pure functions — no DB, no side effects. Computes initial margin (required
 * to open), maintenance margin (ongoing requirement), and cash effect
 * (debit/credit) for each supported strategy.
 *
 * Strategies:
 *   STOCK  (LONG/SHORT)
 *   CALL   (LONG = buy call, SHORT = naked short call)
 *   PUT    (LONG = buy put, SHORT = naked short put)
 *   CDS    (LONG = call debit spread, SHORT = call credit spread)
 *   PDS    (LONG = put debit spread, SHORT = put credit spread)
 */

import type { TradeLeg } from '../db/schema.js';
import type { Direction } from '../lib/enums.js';
import { contractMultiplier, getSpreadWidth } from '../lib/trade.js';

// ─── Types ──────────────────────────────────────────

export type MarginParams = {
  strategy: string;
  direction: Direction;
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

/**
 * Naked call margin per contract (Reg T):
 *   max(20% × underlying − OTM amount + premium, 10% × underlying + premium,
 *       $0.50 + premium)  ← FINRA Rule 4210 floor ($50/contract in per-share terms)
 */
function nakedCallMarginPerContract(
  underlyingPrice: number,
  strike: number,
  premium: number,
): number {
  const otm = Math.max(0, strike - underlyingPrice);
  const a = 0.20 * underlyingPrice - otm + premium;
  const b = 0.10 * underlyingPrice + premium;
  const finraMin = 0.50 + premium; // $50/contract + premium (per-share basis)
  return Math.max(a, b, finraMin);
}

/**
 * Naked put margin per contract (Reg T):
 *   max(20% × underlying − OTM amount + premium, 10% × strike + premium,
 *       $0.50 + premium)  ← FINRA Rule 4210 floor ($50/contract in per-share terms)
 */
function nakedPutMarginPerContract(
  underlyingPrice: number,
  strike: number,
  premium: number,
): number {
  const otm = Math.max(0, underlyingPrice - strike);
  const a = 0.20 * underlyingPrice - otm + premium;
  const b = 0.10 * strike + premium;
  const finraMin = 0.50 + premium; // $50/contract + premium (per-share basis)
  return Math.max(a, b, finraMin);
}

// ─── Main ───────────────────────────────────────────

export function computeMarginRequirement(params: MarginParams): MarginRequirement {
  const { strategy, direction, entryPrice, quantity, legs, underlyingPrice } = params;
  const contractMult = contractMultiplier(strategy);

  switch (strategy) {
    // ── Equities ──────────────────────────────────────
    case 'STOCK': {
      const marketValue = entryPrice * quantity;
      if (direction === 'LONG') {
        return {
          initial: marketValue * 0.50,
          maintenance: underlyingPrice * quantity * 0.25,
          cashEffect: -marketValue,
        };
      }
      return {
        initial: marketValue * 0.50,
        maintenance: underlyingPrice * quantity * 0.30,
        cashEffect: marketValue,
      };
    }

    // ── Single-leg options ────────────────────────────
    case 'CALL': {
      const premium = entryPrice * quantity * contractMult;
      if (direction === 'LONG') {
        return { initial: premium, maintenance: 0, cashEffect: -premium };
      }
      const perContract = nakedCallMarginPerContract(
        underlyingPrice, legs[0]?.strike ?? 0, entryPrice,
      );
      const margin = perContract * quantity * contractMult;
      return { initial: margin, maintenance: margin, cashEffect: premium };
    }

    case 'PUT': {
      const premium = entryPrice * quantity * contractMult;
      if (direction === 'LONG') {
        return { initial: premium, maintenance: 0, cashEffect: -premium };
      }
      const perContract = nakedPutMarginPerContract(
        underlyingPrice, legs[0]?.strike ?? 0, entryPrice,
      );
      const margin = perContract * quantity * contractMult;
      return { initial: margin, maintenance: margin, cashEffect: premium };
    }

    // ── Vertical spreads ─────────────────────────────
    case 'CDS':
    case 'PDS':
    case 'PCS':
    case 'CCS': {
      const width = getSpreadWidth(legs); 
      if (direction === 'LONG') {
        const debit = entryPrice * quantity * contractMult;
        return { initial: debit, maintenance: 0, cashEffect: -debit };
      }
      const credit = entryPrice * quantity * contractMult;
      // Reg-T net margin: spread width minus credit received (the actual capital at risk)
      const netMargin = Math.max(0, (width - entryPrice) * quantity * contractMult);
      return { initial: netMargin, maintenance: netMargin, cashEffect: credit };
    }

    default: {
      const notional = Math.abs(entryPrice * quantity * contractMult);
      return {
        initial: notional,
        maintenance: notional,
        cashEffect: direction === 'LONG' ? -notional : notional,
      };
    }
  }
}
