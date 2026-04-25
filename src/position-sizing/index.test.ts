import { describe, expect, test } from 'vitest';
import type { Leg } from '../intents/orchestrator/types.js';
import { buildPositionSizer } from './index.js';

function optLeg(strike: number, side: 'BUY' | 'SELL', optionType: 'CALL' | 'PUT' = 'PUT'): Leg {
  return {
    type: 'option',
    symbol: 'SPY',
    strike,
    expiry: '2026-06-20',
    optionType,
    side,
    quantity: 1,
  };
}

function stockLeg(side: 'BUY' | 'SELL' = 'BUY'): Leg {
  return { type: 'stock', symbol: 'SPY', side, quantity: 1 };
}

const sizer = buildPositionSizer({ strategy: 'notional', maxNotionalPct: 0.05 });
const equity = 100_000;

// ─── Long single options ──────────────────────────────────────────────────────

describe('long call', () => {
  test('sizes by premium paid', () => {
    // 5% of $100k = $5,000 target; premium $2.50 × 100 = $250/contract → 20 contracts
    const { quantity, riskPerTrade } = sizer.calculateSize({
      symbol: 'SPY', strategy: 'CALL', direction: 'LONG', entryPrice: 2.50, equity,
      legs: [optLeg(510, 'BUY', 'CALL')],
    });
    expect(quantity).toBe(20);
    expect(riskPerTrade).toBeCloseTo(5000);
  });

  test('quantity is floored, not rounded up', () => {
    // 5% of $100k = $5,000; premium $3.00 × 100 = $300 → floor(5000/300) = 16
    const { quantity } = sizer.calculateSize({
      symbol: 'SPY', strategy: 'CALL', direction: 'LONG', entryPrice: 3.00, equity,
      legs: [optLeg(510, 'BUY', 'CALL')],
    });
    expect(quantity).toBe(16);
  });
});

describe('long put', () => {
  test('sizes by premium paid', () => {
    // 5% of $100k = $5,000; premium $1.50 × 100 = $150/contract → 33 contracts
    const { quantity } = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PUT', direction: 'LONG', entryPrice: 1.50, equity,
      legs: [optLeg(490, 'BUY')],
    });
    expect(quantity).toBe(33);
  });
});

// ─── Short single options ─────────────────────────────────────────────────────

describe('short call (naked)', () => {
  test('returns quantity 0 with unbounded-risk reason', () => {
    const result = sizer.calculateSize({
      symbol: 'SPY', strategy: 'CALL', direction: 'SHORT', entryPrice: 1.80, equity,
      legs: [optLeg(510, 'SELL', 'CALL')],
    });
    expect(result.quantity).toBe(0);
    expect(result.riskPerTrade).toBe(0);
    expect(result.reasoning).toMatch(/unbounded/i);
  });
});

describe('short put (naked)', () => {
  test('sizes by strike minus premium, not premium alone', () => {
    // strike=490, premium=1.50 → risk/unit = 488.50 × 100 = $48,850/contract
    // 5% of $100k = $5,000; floor(5000/48850) = 0, but min 1 contract
    const result = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PUT', direction: 'SHORT', entryPrice: 1.50, equity,
      legs: [optLeg(490, 'SELL')],
    });
    // Risk per unit = 490 - 1.50 = 488.50 → floor(5000 / 48850) = 0 → min-clamp to 1
    expect(result.quantity).toBe(1);
    expect(result.reasoning).toMatch(/strike.*prem/i);
  });

  test('risk detail shows strike and premium', () => {
    const { reasoning } = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PUT', direction: 'SHORT', entryPrice: 2.00, equity,
      legs: [optLeg(100, 'SELL')],
    });
    // strike=100, premium=2.00 → risk = 98 → floor(5000/9800) = 0, min 1
    expect(reasoning).toContain('100');
  });

  test('short put risk is always > premium-only risk', () => {
    // Sanity: if risk was mistakenly computed as entryPrice, qty would be much higher
    const shortPutResult = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PUT', direction: 'SHORT', entryPrice: 2.00, equity,
      legs: [optLeg(500, 'SELL')],
    });
    const longPutResult = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PUT', direction: 'LONG', entryPrice: 2.00, equity,
      legs: [optLeg(500, 'BUY')],
    });
    // Short put risk per contract = (500-2)×100 = $49,800; long put = 2×100 = $200
    // So short put should have far fewer contracts
    expect(shortPutResult.quantity).toBeLessThan(longPutResult.quantity);
  });
});

// ─── Credit spreads ───────────────────────────────────────────────────────────

describe('put credit spread (PCS)', () => {
  test('max loss = width - credit, width=5 credit=0.30', () => {
    // width=5, credit=0.30 → max loss per contract = 4.70 × 100 = $470
    // target = $5,000; floor(5000/470) = 10
    const { quantity, riskPerTrade } = sizer.calculateSize({
      symbol: 'BSX', strategy: 'PCS', direction: 'SHORT', entryPrice: 0.30, equity,
      legs: [optLeg(60, 'SELL'), optLeg(55, 'BUY')],
    });
    expect(quantity).toBe(10);
    expect(riskPerTrade).toBeCloseTo(4700);
  });

  test('matches the trader example: "BSX 60/55 put credit spread for $0.30"', () => {
    // width=5, credit=0.30 → max-loss=4.70 → $470/contract → 10 contracts at $5k target
    const { quantity, reasoning } = sizer.calculateSize({
      symbol: 'BSX', strategy: 'PCS', direction: 'SHORT', entryPrice: 0.30, equity,
      legs: [optLeg(60, 'SELL'), optLeg(55, 'BUY')],
    });
    expect(quantity).toBe(10);
    // reasoning shows per-contract risk = 4.70 × 100 = $470
    expect(reasoning).toContain('$470');
  });

  test('wider spread = fewer contracts', () => {
    const narrow = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PCS', direction: 'SHORT', entryPrice: 0.50, equity,
      legs: [optLeg(500, 'SELL'), optLeg(495, 'BUY')], // width=5
    });
    const wide = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PCS', direction: 'SHORT', entryPrice: 1.00, equity,
      legs: [optLeg(500, 'SELL'), optLeg(490, 'BUY')], // width=10
    });
    expect(wide.quantity).toBeLessThan(narrow.quantity);
  });
});

describe('call credit spread (CCS)', () => {
  test('max loss = width - credit', () => {
    // width=10, credit=0.80 → max loss = 9.20 × 100 = $920/contract
    // floor(5000/920) = 5
    const { quantity } = sizer.calculateSize({
      symbol: 'QQQ', strategy: 'CCS', direction: 'SHORT', entryPrice: 0.80, equity,
      legs: [optLeg(440, 'SELL', 'CALL'), optLeg(450, 'BUY', 'CALL')],
    });
    expect(quantity).toBe(5);
  });
});

// ─── Debit spreads ────────────────────────────────────────────────────────────

describe('call debit spread (CDS)', () => {
  test('max loss = debit paid', () => {
    // debit=1.80 × 100 = $180/contract; floor(5000/180) = 27
    const { quantity, riskPerTrade } = sizer.calculateSize({
      symbol: 'SPY', strategy: 'CDS', direction: 'LONG', entryPrice: 1.80, equity,
      legs: [optLeg(505, 'BUY', 'CALL'), optLeg(510, 'SELL', 'CALL')],
    });
    expect(quantity).toBe(27);
    expect(riskPerTrade).toBeCloseTo(4860);
  });
});

describe('put debit spread (PDS)', () => {
  test('max loss = debit paid', () => {
    // debit=2.00 × 100 = $200/contract; floor(5000/200) = 25
    const { quantity } = sizer.calculateSize({
      symbol: 'SPY', strategy: 'PDS', direction: 'LONG', entryPrice: 2.00, equity,
      legs: [optLeg(500, 'BUY'), optLeg(495, 'SELL')],
    });
    expect(quantity).toBe(25);
  });
});

// ─── Stock ────────────────────────────────────────────────────────────────────

describe('stock (long)', () => {
  test('sizes by share price with multiplier=1', () => {
    // $180/share; target = $5,000; floor(5000/180) = 27 shares
    const { quantity } = sizer.calculateSize({
      symbol: 'AAPL', strategy: 'STOCK', direction: 'LONG', entryPrice: 180, equity,
      legs: [stockLeg()],
    });
    expect(quantity).toBe(27);
  });
});

// ─── Max-quantity cap ─────────────────────────────────────────────────────────

describe('maxQuantity cap', () => {
  test('caps at maxQuantity when raw qty would exceed it', () => {
    // Cheap option → many contracts; cap at 5
    const { quantity } = sizer.calculateSize({
      symbol: 'SPY', strategy: 'CALL', direction: 'LONG', entryPrice: 0.10, equity,
      legs: [optLeg(510, 'BUY', 'CALL')],
      maxQuantity: 5,
    });
    expect(quantity).toBe(5);
  });
});
