export interface PositionSizingStrategy {
  name: string;
  calculateSize(params: SizingParams): Promise<PositionSize>;
}

export interface SizingParams {
  symbol: string;
  entryPrice: number;
  equity: number;
  maxAllocation: number;
  spreadMaxRisk?: number; // For options spreads: width - credit received
  maxQuantity?: number;   // Hard cap on quantity (e.g., 20 contracts for options)
}

export interface PositionSize {
  quantity: number;
  reasoning: string;
  riskPerTrade: number;
  atr: number;
  effectiveRisk: number;
}

// --- Discriminated union for position sizing configs ---

export type ATRSizingConfig = {
  strategy: 'atr';
  riskPercent: number;   // e.g. 0.02 = 2%
  atrMultiplier: number; // e.g. 2.0
  atrPeriod?: number;    // default 14
};

// Add new strategy config types here as the union grows:
// export type FixedSizingConfig = { strategy: 'fixed'; quantity: number };

export type PositionSizingConfig = ATRSizingConfig;
// When adding strategies: PositionSizingConfig = ATRSizingConfig | FixedSizingConfig;

// Re-export for convenience
export type { BarFetcher } from './atr.js';

import { ATRPositionSizer } from './atr.js';
import type { BarFetcher } from './atr.js';

/**
 * Build a PositionSizingStrategy from a config using the discriminated union.
 * Falls back to ATR defaults if no config is provided.
 */
export function buildPositionSizer(
  config: PositionSizingConfig | null | undefined,
  fetchBars: BarFetcher,
): PositionSizingStrategy {
  const defaultConfig: ATRSizingConfig = { strategy: 'atr', riskPercent: 0.05, atrMultiplier: 2.0 };
  const resolved: PositionSizingConfig = config ?? defaultConfig;

  switch (resolved.strategy) {
    case 'atr':
      return new ATRPositionSizer(
        {
          riskPercent: resolved.riskPercent,
          atrMultiplier: resolved.atrMultiplier,
          atrPeriod: resolved.atrPeriod ?? 14,
        },
        fetchBars,
      );
  }

  // Exhaustive check — TS will error here if a new union member isn't handled above
  throw new Error(`Unknown position sizing strategy: ${(resolved as { strategy: string }).strategy}`);
}
