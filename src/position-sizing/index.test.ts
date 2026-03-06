import { describe, test, expect } from 'vitest';
import type { Leg } from '../intents/orchestrator/types.js';
import { buildPositionSizer } from './index.js';

const sizer = buildPositionSizer({ strategy: 'notional', maxNotionalPct: 0.05 });

const pcsLegs: Leg[] = [
  { type: 'option', symbol: 'SPY', expiry: '2026-03-20', optionType: 'PUT', strike: 260, side: 'SELL', quantity: 1 },
  { type: 'option', symbol: 'SPY', expiry: '2026-03-20', optionType: 'PUT', strike: 255, side: 'BUY', quantity: 1 },
];

const callLegs: Leg[] = [
  { type: 'option', symbol: 'SPY', expiry: '2026-03-20', optionType: 'CALL', strike: 450, side: 'BUY', quantity: 1 },
];

const stockLegs: Leg[] = [
  { type: 'stock', symbol: 'AAPL', side: 'BUY', quantity: 1 },
];

describe('buildPositionSizer (notional)', () => {
  test('naked option — sizes by entry price', () => {
    const result = sizer.calculateSize({
      symbol: 'SPY', strategy: 'CALL', entryPrice: 5.0, equity: 100_000, legs: callLegs,
    });
    // floor(5000 / (5 * 100)) = 10
    expect(result.quantity).toBe(10);
    expect(result.riskPerTrade).toBe(10 * 5.0 * 100);
  });

  test('credit spread (PCS) — sizes by strike width minus premium', () => {
    const result = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PCS', entryPrice: 1.2, equity: 100_000, legs: pcsLegs,
    });
    // riskPerUnit = 5 - 1.20 = 3.80, floor(5000 / 380) = 13
    expect(result.quantity).toBe(13);
    expect(result.riskPerTrade).toBe(13 * 3.8 * 100);
  });

  test('credit spread vs naive sizing demonstrates the fix', () => {
    // Debit spread uses entryPrice directly
    const debit = sizer.calculateSize({
      symbol: 'SPY', strategy: 'CDS', entryPrice: 1.2, equity: 100_000, legs: pcsLegs,
    });
    // Credit spread uses width - premium
    const credit = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PCS', entryPrice: 1.2, equity: 100_000, legs: pcsLegs,
    });
    // Debit (entryPrice): floor(5000 / 120) = 41
    expect(debit.quantity).toBe(41);
    // Credit (width - prem): floor(5000 / 380) = 13
    expect(credit.quantity).toBe(13);
    expect(credit.quantity).toBeLessThan(debit.quantity);
  });

  test('maxQuantity cap applies', () => {
    const result = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PCS', entryPrice: 1.2, equity: 100_000, legs: pcsLegs, maxQuantity: 5,
    });
    expect(result.quantity).toBe(5);
    expect(result.riskPerTrade).toBe(5 * 3.8 * 100);
  });

  test('stock — sizes by share price', () => {
    const result = sizer.calculateSize({
      symbol: 'AAPL', strategy: 'STOCK', entryPrice: 150.0, equity: 100_000, legs: stockLegs,
    });
    // multiplier=1, floor(5000 / 150) = 33
    expect(result.quantity).toBe(33);
    expect(result.riskPerTrade).toBe(33 * 150 * 1);
  });

  test('credit spread with single leg falls back to entry price', () => {
    const result = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PCS', entryPrice: 1.2, equity: 100_000, legs: callLegs,
    });
    // Only 1 option leg — can't compute width, falls back to entryPrice
    expect(result.quantity).toBe(41);
  });

  test('reasoning shows spread risk breakdown for credit spreads', () => {
    const result = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PCS', entryPrice: 1.2, equity: 100_000, legs: pcsLegs,
    });
    expect(result.reasoning).toContain('width $5');
    expect(result.reasoning).toContain('prem $1.20');
  });

  test('reasoning has no spread detail for non-spreads', () => {
    const result = sizer.calculateSize({
      symbol: 'SPY', strategy: 'CALL', entryPrice: 5.0, equity: 100_000, legs: callLegs,
    });
    expect(result.reasoning).not.toContain('width');
  });
});
