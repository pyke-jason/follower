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
 * After a LEG_OFF, the trade's legs array shrinks (e.g., PDS 2-leg → CALL 1-leg).
 * To correctly charge the open side, record-trade stores the original leg count in
 * `metadata.openLegCount`. The commission functions use this for the open side when
 * present, falling back to current `legs.length` for trades without LEG_OFF.
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
  metadata?: { openLegCount?: number } | null;
};

function currentLegCount(trade: CommissionableTrade): number {
  return Array.isArray(trade.legs) ? Math.max(trade.legs.length, 1) : 1;
}

function computeSideCommission(
  trade: CommissionableTrade,
  schedule: CommissionSchedule | undefined,
  legCount: number,
): number {
  if (!schedule) return 0;
  const qty = tradeQty(trade.quantity);

  if (trade.strategy === 'STOCK') {
    const perShare = schedule.stock?.perShare ?? 0;
    if (perShare === 0) return 0;
    const min = schedule.stock?.minimum ?? 0;
    const max = schedule.stock?.maximum ?? Infinity;
    if (min > max) {
      throw new Error(`CommissionSchedule: stock minimum (${min}) exceeds maximum (${max})`);
    }
    return roundCents(Math.min(Math.max(perShare * qty, min), max));
  }

  // Options: CALL, PUT, CDS, PDS, etc.
  const perContract = schedule.option?.perContract ?? 0;
  if (perContract === 0) return 0;
  return roundCents(perContract * qty * legCount);
}

/** Round-trip (open + close) commission for a closed trade.
 *  Uses `metadata.openLegCount` for the open side when legs changed via LEG_OFF. */
export function computeTradeCommission(
  trade: CommissionableTrade,
  schedule: CommissionSchedule | undefined,
): number {
  const closeLegCount = currentLegCount(trade);
  const openLegCount = trade.metadata?.openLegCount ?? closeLegCount;
  const openSide = computeSideCommission(trade, schedule, openLegCount);
  const closeSide = computeSideCommission(trade, schedule, closeLegCount);
  return roundCents(openSide + closeSide);
}

/** Entry-only commission (for open positions that haven't exited yet).
 *  Uses `metadata.openLegCount` when present (position already had a LEG_OFF). */
export function computeEntrySideCommission(
  trade: CommissionableTrade,
  schedule: CommissionSchedule | undefined,
): number {
  const openLegCount = trade.metadata?.openLegCount ?? currentLegCount(trade);
  return computeSideCommission(trade, schedule, openLegCount);
}
