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

  test('stock uses 10% notional proxy; naked short options remain excluded', () => {
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

    // 100 × 10 × 1 (multiplier) × 0.10 = 100
    expect(stock.currentRisk).toBe(100);
    expect(stock.basis).toBe('stock_notional');
    expect(stock.confidence).toBe('estimate');
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

  test('topology change freezes peak at prior value (does not inflate from new currentRisk)', () => {
    // Original CDS: $2 debit × 1 contract × 100 = $200 peak.
    const previous: TradeRiskSnapshot = {
      currentRisk: 200,
      peakRisk: 200,
      basis: 'defined_spread',
      confidence: 'exact',
      multiplier: 100,
      notes: [],
    };

    // Post-LEG_OFF: kept long leg, basis is now $2 entry + $0.5 buyback = $2.5.
    // Without the topology flag, peak would inflate to 250 (the bug).
    const next = updateTradeRiskSnapshot({
      strategy: 'CALL',
      direction: 'LONG',
      entryPrice: 2.5,
      quantity: 1,
      legs: [optionLeg({ strike: 100, type: 'CALL', action: 'BUY' })],
    }, previous, { topologyChanged: true });

    expect(next.currentRisk).toBe(250);
    expect(next.peakRisk).toBe(200);
    expect(next.riskTopologyChanged).toBe(true);
    expect(next.notes.some((n) => n.includes('topology changed'))).toBe(true);
  });

  test('topology change to unbounded clears peak risk', () => {
    // Original CDS: $200 peak.
    const previous: TradeRiskSnapshot = {
      currentRisk: 200,
      peakRisk: 200,
      basis: 'defined_spread',
      confidence: 'exact',
      multiplier: 100,
      notes: [],
    };

    // Post-LEG_OFF: kept short leg → naked short call (unbounded).
    const next = updateTradeRiskSnapshot({
      strategy: 'CALL',
      direction: 'SHORT',
      entryPrice: 1,
      quantity: 1,
      legs: [optionLeg({ strike: 105, type: 'CALL', action: 'SELL' })],
    }, previous, { topologyChanged: true });

    expect(next.currentRisk).toBeNull();
    expect(next.peakRisk).toBeNull();
    expect(next.basis).toBe('unbounded');
    expect(next.riskTopologyChanged).toBe(true);
  });

  test('peak stays frozen on updates after a prior topology change', () => {
    const previous: TradeRiskSnapshot = {
      currentRisk: 250,
      peakRisk: 200,
      basis: 'premium_paid',
      confidence: 'exact',
      multiplier: 100,
      notes: [],
      riskTopologyChanged: true,
    };

    // Subsequent CLOSE re-runs the snapshot with the same long-call structure.
    // Peak must NOT inflate from the post-mutation currentRisk.
    const next = updateTradeRiskSnapshot({
      strategy: 'CALL',
      direction: 'LONG',
      entryPrice: 2.5,
      quantity: 1,
      legs: [optionLeg({ strike: 100, type: 'CALL', action: 'BUY' })],
    }, previous);

    expect(next.currentRisk).toBe(250);
    expect(next.peakRisk).toBe(200);
    expect(next.riskTopologyChanged).toBe(true);
  });
});
