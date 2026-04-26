import type { RiskCheckConfig } from '../orders/risk-check.js';
import type { NotionalSizingConfig } from '../position-sizing/index.js';

export const BACKTEST_RISK_DEFAULTS: RiskCheckConfig = {
  maxOnSymbol: 3,
  maxTotalPositions: 20,
  maxDrawdownPct: 5,
  maxNotionalMultiplier: 2,
  minMarginCushionPct: 0.20,
};

export const LIVE_RISK_DEFAULTS: RiskCheckConfig = {
  maxOnSymbol: 3,
  maxTotalPositions: 10,
  maxDrawdownPct: 3,
  maxNotionalMultiplier: 1.5,
  minMarginCushionPct: 0.25,
};

export const DEFAULT_SIZING_CONFIG: NotionalSizingConfig = {
  strategy: 'notional',
  maxNotionalPct: 0.05,
};

export const MAX_CONTRACTS: Record<string, number> = {
  CALL: 20, PUT: 20, CDS: 20, PDS: 20, PCS: 20, CCS: 20,
};

export const DEFAULT_STARTING_EQUITY = 100_000;

/** Cushion fraction below which naked short options emit a warning alert. */
export const SHORT_OPTION_CUSHION_WARN = 0.10;
/** Cushion fraction below which naked short options are blocked entirely. */
export const SHORT_OPTION_CUSHION_BLOCK = 0.05;
const DEFAULT_FILL_MODEL = 'orats' as const;
export const DEFAULT_COMMISSION_SCHEDULE = {
  option: { perContract: 0.50 },
  stock: { perShare: 0.00 },
} as const;
