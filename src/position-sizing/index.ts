import { DEFAULT_SIZING_CONFIG, MAX_CONTRACTS } from '../config/risk-defaults.js';
import { contractMultiplier } from '../lib/trade.js';

export type NotionalSizingConfig = {
  strategy: 'notional';
  maxNotionalPct: number; // e.g. 0.05 = 5% of equity per position
};

export type PositionSizingConfig = NotionalSizingConfig;

export interface SizingParams {
  symbol: string;
  strategy: string;
  entryPrice: number;
  equity: number;
  spreadMaxRisk?: number;
  maxQuantity?: number;
}

export interface PositionSize {
  quantity: number;
  reasoning: string;
  riskPerTrade: number;
}

function calculateNotionalSize(config: NotionalSizingConfig, params: SizingParams): PositionSize {
  const { entryPrice, equity, strategy, maxQuantity } = params;
  const { maxNotionalPct } = config;
  const multiplier = contractMultiplier(strategy);
  const unit = strategy === 'STOCK' ? 'shares' : 'contracts';

  const targetNotional = equity * maxNotionalPct;

  if (entryPrice <= 0) {
    return { quantity: 0, reasoning: `Entry price $${entryPrice} <= 0, cannot size`, riskPerTrade: 0 };
  }

  const rawQty = Math.floor(targetNotional / (entryPrice * multiplier));
  const quantity = maxQuantity ? Math.min(Math.max(rawQty, 1), maxQuantity) : Math.max(rawQty, 1);
  const actualNotional = quantity * entryPrice * multiplier;

  const reasoning = [
    `Target notional = $${targetNotional.toFixed(0)} (${(maxNotionalPct * 100).toFixed(1)}% of $${equity.toFixed(0)})`,
    `Per-${strategy === 'STOCK' ? 'share' : 'contract'} = $${(entryPrice * multiplier).toFixed(0)}`,
    `Raw qty: ${rawQty}`,
    maxQuantity ? `Max cap: ${maxQuantity}` : null,
    `Final: ${quantity} ${unit} ($${actualNotional.toFixed(0)} = ${((actualNotional / equity) * 100).toFixed(1)}%)`,
  ].filter(Boolean).join('; ');

  return { quantity, reasoning, riskPerTrade: actualNotional };
}

export function buildPositionSizer(
  config: PositionSizingConfig | null | undefined,
): { calculateSize(params: SizingParams): PositionSize } {
  const resolved = config ?? DEFAULT_SIZING_CONFIG;

  switch (resolved.strategy) {
    case 'notional':
      return {
        calculateSize: (params: SizingParams) => calculateNotionalSize(resolved, params),
      };
  }

  throw new Error(`Unknown position sizing strategy: ${(resolved as { strategy: string }).strategy}`);
}
