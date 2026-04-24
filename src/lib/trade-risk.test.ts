import { describe, expect, test } from 'vitest';
import type { TradeLeg } from '../db/schema.js';
import { getTradeMaxLossAtEntry, summarizeTradeRiskAtEntry, type TradeRiskInput } from './trade-risk.js';

function makeTrade(overrides: Partial<TradeRiskInput> = {}): TradeRiskInput {
  return {
    strategy: 'STOCK',
    direction: 'LONG',
    entryPrice: '100',
    quantity: 2,
    legs: [] satisfies TradeLeg[],
    ...overrides,
  };
}

describe('getTradeMaxLossAtEntry', () => {
  test('long stock uses full share cost', () => {
    expect(getTradeMaxLossAtEntry(makeTrade())).toBe(200);
  });

  test('short stock is unbounded', () => {
    expect(getTradeMaxLossAtEntry(makeTrade({ direction: 'SHORT' }))).toBeNull();
  });

  test('long call uses premium paid', () => {
    expect(getTradeMaxLossAtEntry(makeTrade({
      strategy: 'CALL',
      entryPrice: '2.15',
      quantity: 3,
      legs: [{ symbol: 'NVDA', strike: 900, expiry: '2026-04-24', type: 'CALL', action: 'BUY', quantity: 1 }],
    }))).toBeCloseTo(645);
  });

  test('short put assumes underlying goes to zero', () => {
    expect(getTradeMaxLossAtEntry(makeTrade({
      strategy: 'PUT',
      direction: 'SHORT',
      entryPrice: '1.25',
      quantity: 2,
      legs: [{ symbol: 'AAPL', strike: 180, expiry: '2026-04-24', type: 'PUT', action: 'SELL', quantity: 1 }],
    }))).toBeCloseTo(35750);
  });

  test('debit spread max loss is the debit', () => {
    expect(getTradeMaxLossAtEntry(makeTrade({
      strategy: 'CDS',
      direction: 'LONG',
      entryPrice: '1.80',
      quantity: 2,
      legs: [
        { symbol: 'SPY', strike: 505, expiry: '2026-04-24', type: 'CALL', action: 'BUY', quantity: 1 },
        { symbol: 'SPY', strike: 510, expiry: '2026-04-24', type: 'CALL', action: 'SELL', quantity: 1 },
      ],
    }))).toBeCloseTo(360);
  });

  test('credit spread max loss is width minus credit', () => {
    expect(getTradeMaxLossAtEntry(makeTrade({
      strategy: 'PCS',
      direction: 'SHORT',
      entryPrice: '1.40',
      quantity: 3,
      legs: [
        { symbol: 'SPY', strike: 500, expiry: '2026-04-24', type: 'PUT', action: 'SELL', quantity: 1 },
        { symbol: 'SPY', strike: 495, expiry: '2026-04-24', type: 'PUT', action: 'BUY', quantity: 1 },
      ],
    }))).toBeCloseTo(1080);
  });
});

describe('summarizeTradeRiskAtEntry', () => {
  test('labels short calls as unbounded', () => {
    expect(summarizeTradeRiskAtEntry(makeTrade({
      strategy: 'CALL',
      direction: 'SHORT',
      entryPrice: '1.10',
      legs: [{ symbol: 'TSLA', strike: 250, expiry: '2026-04-24', type: 'CALL', action: 'SELL', quantity: 1 }],
    }))).toEqual({
      maxLoss: null,
      bounded: false,
      note: 'Short call risk is theoretically unbounded.',
    });
  });
});
