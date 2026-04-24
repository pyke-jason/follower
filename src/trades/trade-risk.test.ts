import { describe, expect, test } from 'vitest';
import { computeTradeRiskSnapshot, updateTradeRiskSnapshot } from './trade-risk.js';
import type { TradeLeg, TradeRiskSnapshot } from '../db/schema.js';

function stockLeg(quantity = 1): TradeLeg {
  return {
    symbol: 'AAPL',
    strike: 0,
    expiry: '2099-01-01',
    type: 'STOCK',
    action: 'BUY',
    quantity,
  };
}

function optionLeg(params: {
  strike: number;
  type: 'CALL' | 'PUT';
  action: 'BUY' | 'SELL';
  quantity?: number;
}): TradeLeg {
  return {
    symbol: 'SPY',
    strike: params.strike,
    expiry: '2026-06-19',
    type: params.type,
    action: params.action,
    quantity: params.quantity ?? 1,
  };
}

describe('computeTradeRiskSnapshot', () => {
  test('long calls use premium paid as finite risk', () => {
    const risk = computeTradeRiskSnapshot({
      strategy: 'CALL',
      direction: 'LONG',
      entryPrice: 2.5,
      quantity: 2,
      legs: [optionLeg({ strike: 500, type: 'CALL', action: 'BUY' })],
    });

    expect(risk.currentRisk).toBe(500);
    expect(risk.peakRisk).toBe(500);
    expect(risk.basis).toBe('premium_paid');
    expect(risk.confidence).toBe('exact');
  });

  test('debit spreads use debit paid as finite risk', () => {
    const risk = computeTradeRiskSnapshot({
      strategy: 'CDS',
      direction: 'LONG',
      entryPrice: 1.4,
      quantity: 1,
      legs: [
        optionLeg({ strike: 100, type: 'CALL', action: 'BUY' }),
        optionLeg({ strike: 105, type: 'CALL', action: 'SELL' }),
      ],
    });

    expect(risk.currentRisk).toBe(140);
    expect(risk.basis).toBe('defined_spread');
  });

  test('credit spreads use spread width minus credit as finite risk', () => {
    const risk = computeTradeRiskSnapshot({
      strategy: 'PCS',
      direction: 'LONG',
      entryPrice: 1.25,
      quantity: 3,
      legs: [
        optionLeg({ strike: 95, type: 'PUT', action: 'SELL' }),
        optionLeg({ strike: 90, type: 'PUT', action: 'BUY' }),
      ],
    });

    expect(risk.currentRisk).toBe(1125);
    expect(risk.basis).toBe('defined_spread');
  });

  test('stock and naked short options are excluded from true R', () => {
    const stock = computeTradeRiskSnapshot({
      strategy: 'STOCK',
      direction: 'LONG',
      entryPrice: 100,
      quantity: 10,
      legs: [stockLeg(10)],
    });
    const shortCall = computeTradeRiskSnapshot({
      strategy: 'CALL',
      direction: 'SHORT',
      entryPrice: 2,
      quantity: 1,
      legs: [optionLeg({ strike: 100, type: 'CALL', action: 'SELL' })],
    });

    expect(stock.currentRisk).toBeNull();
    expect(stock.basis).toBe('stock_notional');
    expect(shortCall.currentRisk).toBeNull();
    expect(shortCall.basis).toBe('unbounded');
  });

  test('malformed spreads are visible but excluded from R', () => {
    const risk = computeTradeRiskSnapshot({
      strategy: 'CCS',
      direction: 'SHORT',
      entryPrice: 1,
      quantity: 1,
      legs: [optionLeg({ strike: 100, type: 'CALL', action: 'SELL' })],
    });

    expect(risk.currentRisk).toBeNull();
    expect(risk.confidence).toBe('unknown');
    expect(risk.notes[0]).toContain('width');
  });
});

describe('updateTradeRiskSnapshot', () => {
  test('preserves prior peak risk when current risk decreases', () => {
    const previous: TradeRiskSnapshot = {
      currentRisk: 600,
      peakRisk: 600,
      basis: 'premium_paid',
      confidence: 'exact',
      multiplier: 100,
      notes: [],
    };

    const next = updateTradeRiskSnapshot({
      strategy: 'CALL',
      direction: 'LONG',
      entryPrice: 3,
      quantity: 1,
      legs: [optionLeg({ strike: 500, type: 'CALL', action: 'BUY' })],
    }, previous);

    expect(next.currentRisk).toBe(300);
    expect(next.peakRisk).toBe(600);
    expect(next.notes).toContain('Peak risk preserved from earlier lifecycle state.');
  });
});
