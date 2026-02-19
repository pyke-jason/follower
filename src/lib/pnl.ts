/**
 * Trade PnL computation.
 *
 * Single source of truth — used by SimBroker, runner, report, and anywhere
 * else that needs direction-aware PnL from entry/exit prices.
 */

export function computeTradePnl(params: {
  entryPrice: number;
  exitPrice: number;
  direction: 'LONG' | 'SHORT';
  strategy: string;
  quantity: number;
}): number {
  const diff = params.exitPrice - params.entryPrice;
  const multiplier = params.direction === 'LONG' ? 1 : -1;
  const contractMultiplier = params.strategy === 'STOCK' ? 1 : 100;
  const raw = Math.round(diff * multiplier * params.quantity * contractMultiplier * 100) / 100;
  if (Number.isNaN(raw)) {
    throw new Error(
      `computeTradePnl produced NaN (entry=${params.entryPrice}, exit=${params.exitPrice}, dir=${params.direction}, qty=${params.quantity})`,
    );
  }
  // Normalise -0 → +0 (JS quirk when diff=0 and multiplier=-1)
  return raw || 0;
}
