import type { Leg } from '../intents/orchestrator/types.js';
import { DEFAULT_SIZING_CONFIG, MAX_CONTRACTS } from '../config/risk-defaults.js';
import { contractMultiplier } from '../lib/trade.js';

export type NotionalSizingConfig = {
  strategy: 'notional';
  maxNotionalPct: number; // e.g. 0.05 = 5% of equity per position
};

export type AtrSizingConfig = {
  strategy: 'atr';
  riskPercent: number;
  atrMultiplier: number;
  atrPeriod?: number;
};

export type PositionSizingConfig = NotionalSizingConfig | AtrSizingConfig;

interface SizingParams {
  symbol: string;
  strategy: string;
  entryPrice: number;
  equity: number;
  legs: Leg[];
  maxQuantity?: number;
}

export interface PositionSize {
  quantity: number;
  reasoning: string;
  riskPerTrade: number;
}

function getStrikeWidth(legs: Leg[]): number | undefined {
  const strikes = legs.filter((l): l is Extract<Leg, { type: 'option' }> => l.type === 'option').map(l => l.strike);
  if (strikes.length !== 2) return undefined;
  return Math.abs(strikes[0] - strikes[1]);
}

function riskPerUnit(strategy: string, entryPrice: number, legs: Leg[]): { value: number; detail?: string } {
  const isCredit = strategy === 'PCS' || strategy === 'CCS';
  if (!isCredit) return { value: entryPrice };

  const width = getStrikeWidth(legs);
  if (!width) return { value: entryPrice };

  const risk = Math.max(0.01, width - entryPrice);
  return { value: risk, detail: `width $${width} - prem $${entryPrice.toFixed(2)}` };
}

function calculateNotionalSize(config: NotionalSizingConfig, params: SizingParams): PositionSize {
  const { entryPrice, equity, strategy, maxQuantity, legs } = params;
  const { maxNotionalPct } = config;
  const multiplier = contractMultiplier(strategy);
  const unit = strategy === 'STOCK' ? 'shares' : 'contracts';

  const targetNotional = equity * maxNotionalPct;

  if (entryPrice <= 0) {
    return { quantity: 0, reasoning: `Entry price $${entryPrice} <= 0, cannot size`, riskPerTrade: 0 };
  }

  const risk = riskPerUnit(strategy, entryPrice, legs);
  const rawQty = Math.floor(targetNotional / (risk.value * multiplier));
  const quantity = maxQuantity ? Math.min(Math.max(rawQty, 1), maxQuantity) : Math.max(rawQty, 1);
  const actualNotional = quantity * risk.value * multiplier;

  const reasoning = [
    `Target notional = $${targetNotional.toFixed(0)} (${(maxNotionalPct * 100).toFixed(1)}% of $${equity.toFixed(0)})`,
    `Per-${unit} risk = $${(risk.value * multiplier).toFixed(0)}${risk.detail ? ` (${risk.detail})` : ''}`,
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
