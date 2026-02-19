/**
 * Commission computation at stats time (not stored on trades).
 *
 * Design: Instead of threading commission through SimBroker → pipeline → recordTrade,
 * we compute it from trade metadata (strategy, quantity, leg count) when generating
 * stats. This works because commission = qty × legs × rate × sides, which naturally
 * handles TRIM/ADD since child trades carry their own quantity.
 *
 * For open positions, we compute entry-only commission (one side) since the exit
 * hasn't happened yet.
 *
 * Stock min/max is applied per side (not per ticket). Negligible difference since
 * most users will use $0.00 for stocks (TradeStation is commission-free for equities).
 */

import type { CommissionSchedule } from '../db/schema.js';
import { roundCents } from './numbers.js';
import { tradeQty } from './trade.js';

type CommissionableTrade = {
  strategy: string;
  quantity: number | null;
  legs: unknown[] | null;
};

function computeOneSideCommission(
  trade: CommissionableTrade,
  schedule: CommissionSchedule | undefined,
): number {
  if (!schedule) return 0;
  const qty = tradeQty(trade.quantity);

  if (trade.strategy === 'STOCK') {
    const perShare = schedule.stock?.perShare ?? 0;
    if (perShare === 0) return 0;
    const min = schedule.stock?.minimum ?? 0;
    const max = schedule.stock?.maximum ?? Infinity;
    return roundCents(Math.min(Math.max(perShare * qty, min), max));
  }

  // Options: CALL, PUT, CDS, PDS, etc.
  const perContract = schedule.option?.perContract ?? 0;
  if (perContract === 0) return 0;
  // Naked CALL/PUT always has legs.length >= 1 (execute.ts throws if empty).
  // Spreads (CDS/PDS) have 2+ legs. Stock trades don't reach here.
  const legCount = Array.isArray(trade.legs) ? Math.max(trade.legs.length, 1) : 1;
  return roundCents(perContract * qty * legCount);
}

/** Round-trip (open + close) commission for a closed trade. */
export function computeTradeCommission(
  trade: CommissionableTrade,
  schedule: CommissionSchedule | undefined,
): number {
  return roundCents(computeOneSideCommission(trade, schedule) * 2);
}

/** Entry-only commission (for open positions that haven't exited yet). */
export function computeEntrySideCommission(
  trade: CommissionableTrade,
  schedule: CommissionSchedule | undefined,
): number {
  return computeOneSideCommission(trade, schedule);
}
