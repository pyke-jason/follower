import { DEFAULT_SIZING_CONFIG, MAX_CONTRACTS } from '../config/risk-defaults.js';

export type NotionalSizingConfig = {
  strategy: 'notional';
  maxNotionalPct: number; // e.g. 0.05 = 5% of equity per position
};

export type PositionSizingConfig = NotionalSizingConfig;

export interface SizingParams {
  symbol: string;
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

const OPTIONS_MULTIPLIER = 100;

function calculateNotionalSize(config: NotionalSizingConfig, params: SizingParams): PositionSize {
  const { entryPrice, equity, maxQuantity } = params;
  const { maxNotionalPct } = config;

  const targetNotional = equity * maxNotionalPct;
  const riskPerTrade = targetNotional;

  if (entryPrice <= 0) {
    return { quantity: 0, reasoning: `Entry price $${entryPrice} <= 0, cannot size`, riskPerTrade: 0 };
  }

  const rawQty = Math.floor(targetNotional / (entryPrice * OPTIONS_MULTIPLIER));
  const quantity = maxQuantity ? Math.min(Math.max(rawQty, 1), maxQuantity) : Math.max(rawQty, 1);
  const actualNotional = quantity * entryPrice * OPTIONS_MULTIPLIER;

  const reasoning = [
    `Target notional = $${targetNotional.toFixed(0)} (${(maxNotionalPct * 100).toFixed(1)}% of $${equity.toFixed(0)})`,
    `Per-contract = $${(entryPrice * OPTIONS_MULTIPLIER).toFixed(0)}`,
    `Raw qty: ${rawQty}`,
    maxQuantity ? `Max cap: ${maxQuantity}` : null,
    `Final: ${quantity} contracts ($${actualNotional.toFixed(0)} = ${((actualNotional / equity) * 100).toFixed(1)}%)`,
  ].filter(Boolean).join('; ');

  return { quantity, reasoning, riskPerTrade };
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
