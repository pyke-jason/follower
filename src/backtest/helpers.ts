import type { BacktestPriceProvider } from './market-data.js';
import type { DetectedStrategy } from '../db/schema.js';

/**
 * Extract a price from message text using common patterns:
 * "for $X.XX", "at $X.XX", "@X.XX", or trailing number after symbol text.
 */
export function extractPriceFromText(text: string): number | undefined {
  // Try "for $X.XX" or "at $X.XX" patterns first
  const priceMatch = text.match(/(?:for|at|@)\s*\$?([\d,]+\.?\d*)/i);
  if (priceMatch) return parseFloat(priceMatch[1].replace(/,/g, ''));

  // Try trailing number after symbol text (e.g., "Long CSCO 73.41")
  // Negative lookbehind (?<!:) avoids matching timestamps like "10:30"
  const trailingMatch = text.match(/(?<!:)\b(\d+\.?\d+)\s*(?:-|$|\.|!|\s*starter)/i);
  if (trailingMatch) {
    const val = parseFloat(trailingMatch[1]);
    // Skip strike-like numbers and very large numbers
    if (val > 0.01 && val < 10000) return val;
  }

  return undefined;
}

/**
 * Seed option prices into the price provider from detected strategies.
 * Both deterministic-executor and runner agent path need this since
 * Databento DBEQ.BASIC has no options data.
 */
export function seedOptionPrices(
  priceProvider: BacktestPriceProvider,
  strategies: DetectedStrategy[],
  symbols: string[],
  timestamp: Date,
): void {
  for (let i = 0; i < strategies.length; i++) {
    const strat = strategies[i];
    const sym = symbols[i];
    if (!sym || !strat.strikes?.length || !strat.price) continue;
    const optType = (strat.strategy === 'CDS' || strat.strategy === 'CALL') ? 'CALL' : 'PUT';
    for (const strike of strat.strikes) {
      priceProvider.setOptionPrice(`${sym}:${optType}:${strike}`, strat.price, timestamp);
    }
  }
}
