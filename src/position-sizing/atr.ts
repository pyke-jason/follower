import type { Bar } from '../broker/types.js';
import type { PositionSizingStrategy, SizingParams, PositionSize } from './index.js';
import { ATR_FALLBACK_FACTOR } from '../config/risk-defaults.js';

export type ATRConfig = {
  riskPercent: number;   // e.g. 0.02 = 2%
  atrMultiplier: number; // e.g. 2.0
  atrPeriod: number;     // e.g. 14
};

export type BarFetcher = (symbol: string, barsBack: number) => Promise<Bar[]>;

/**
 * Compute ATR (Average True Range) from OHLC bars.
 * True Range = max(high - low, |high - prevClose|, |low - prevClose|)
 * ATR = SMA of True Range over `period` bars.
 */
export function computeATR(bars: Bar[], period: number): number {
  if (bars.length < 2) {
    throw new Error(`Need at least 2 bars to compute ATR, got ${bars.length}`);
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trueRanges.push(tr);
  }

  // Use the last `period` true ranges (or all available if fewer)
  const usable = trueRanges.slice(-period);
  const sum = usable.reduce((a, b) => a + b, 0);
  return sum / usable.length;
}

export class ATRPositionSizer implements PositionSizingStrategy {
  name = 'atr';

  constructor(
    private config: ATRConfig,
    private fetchBars: BarFetcher,
  ) {}

  async calculateSize(params: SizingParams): Promise<PositionSize> {
    const { symbol, entryPrice, equity, spreadMaxRisk, maxQuantity } = params;
    const { riskPercent, atrMultiplier, atrPeriod } = this.config;

    // Fetch enough bars to compute ATR (need period + 1 for true range calc)
    const bars = await this.fetchBars(symbol, atrPeriod + 1);

    let atr: number;
    let atrFallback = false;
    if (bars.length < 2) {
      // Insufficient data — use synthetic ATR of entry price * fallback factor
      atr = entryPrice * ATR_FALLBACK_FACTOR;
      atrFallback = true;
    } else {
      atr = computeATR(bars, atrPeriod);
    }

    // riskPerTrade = equity × riskPercent
    const riskPerTrade = equity * riskPercent;

    // effectiveRisk per share/contract = ATR × atrMultiplier
    const effectiveRisk = atr * atrMultiplier;

    // shares = floor(riskPerTrade / effectiveRisk)
    const sharesFromRisk = Math.floor(riskPerTrade / effectiveRisk);

    const quantity = maxQuantity ? Math.min(sharesFromRisk, maxQuantity) : sharesFromRisk;

    const reasoning = [
      atrFallback
        ? `ATR fallback: ${(ATR_FALLBACK_FACTOR * 100).toFixed(0)}% of $${entryPrice.toFixed(2)} (only ${bars.length} bar${bars.length === 1 ? '' : 's'} available)`
        : `ATR(${atrPeriod}) = $${atr.toFixed(2)}`,
      `Risk/trade = $${riskPerTrade.toFixed(0)} (${(riskPercent * 100).toFixed(1)}% of $${equity.toFixed(0)})`,
      `Per-unit risk = $${effectiveRisk.toFixed(2)} (ATR × ${atrMultiplier})`,
      `From risk: ${sharesFromRisk} units`,
      maxQuantity ? `Max quantity cap: ${maxQuantity}` : null,
      `Final: ${quantity} units`,
    ].filter(Boolean).join('; ');

    return {
      quantity: Math.max(0, quantity),
      reasoning,
      riskPerTrade,
      atr,
      effectiveRisk,
    };
  }
}
