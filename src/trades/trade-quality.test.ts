import { describe, expect, test } from 'vitest';
import { computeTradeQuality, computeTradeQualitySummary } from './trade-quality.js';
import type { Trade, TradeMetadata } from '../db/schema.js';

function trade(overrides: {
  id?: string;
  symbol?: string;
  strategy?: Trade['strategy'];
  pnl?: string | null;
  metadata?: TradeMetadata;
}): Trade {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    taskId: null,
    sourceMessageId: null,
    trader: 'tester',
    symbol: overrides.symbol ?? 'SPY',
    direction: 'LONG',
    strategy: overrides.strategy ?? 'CALL',
    legs: [],
    status: 'CLOSED',
    entryPrice: '2',
    exitPrice: '4',
    quantity: 1,
    pnl: overrides.pnl ?? '200',
    openedAt: '2026-04-20T14:00:00.000Z',
    closedAt: '2026-04-20T15:00:00.000Z',
    closeMessageId: null,
    channelId: 'bt:test',
    metadata: overrides.metadata ?? {},
    avgEntryPrice: null,
    brokerFillPrice: null,
    brokerFillQty: null,
    brokerCommission: null,
    brokerFillTime: null,
    brokerLegFills: null,
    realizedPnl: null,
    plannedExitDate: null,
  };
}

describe('computeTradeQuality', () => {
  test('derives R, score, grade, and reasons from finite risk', () => {
    const quality = computeTradeQuality(trade({
      pnl: '240',
      metadata: {
        risk: {
          currentRisk: 100,
          peakRisk: 100,
          basis: 'premium_paid',
          confidence: 'exact',
          multiplier: 100,
          notes: [],
        },
      },
    }), 100);

    expect(quality.rMultiple).toBe(2.4);
    expect(quality.grade).toBe('A');
    expect(quality.reasons).toContain('+2.4R');
  });

  test('penalizes slippage, chase, flags, and oversizing', () => {
    const quality = computeTradeQuality(trade({
      pnl: '100',
      metadata: {
        chaseSteps: 5,
        entrySlippagePct: 0.04,
        flags: ['slippage', 'closeFailed'],
        risk: {
          currentRisk: 400,
          peakRisk: 400,
          basis: 'premium_paid',
          confidence: 'exact',
          multiplier: 100,
          notes: [],
        },
      },
    }), 100);

    expect(quality.rMultiple).toBe(0.25);
    expect(quality.score).toBeLessThan(55);
    expect(quality.reasons).toEqual(expect.arrayContaining(['slippage', 'close failed', 'oversized']));
  });

  test('excludes trades without finite risk from R and grade', () => {
    const quality = computeTradeQuality(trade({ pnl: '50', metadata: {} }), null);

    expect(quality.rMultiple).toBeNull();
    expect(quality.grade).toBeNull();
    expect(quality.reasons).toContain('no finite risk');
  });
});

describe('computeTradeQualitySummary', () => {
  test('builds coverage, R buckets, grade buckets, flag counts, and strategy summaries', () => {
    const summary = computeTradeQualitySummary([
      trade({
        id: 'winner',
        strategy: 'CALL',
        pnl: '250',
        metadata: {
          flags: ['slippage'],
          risk: {
            currentRisk: 100,
            peakRisk: 100,
            basis: 'premium_paid',
            confidence: 'exact',
            multiplier: 100,
            notes: [],
          },
        },
      }),
      trade({
        id: 'loser',
        strategy: 'PCS',
        pnl: '-150',
        metadata: {
          risk: {
            currentRisk: 100,
            peakRisk: 100,
            basis: 'defined_spread',
            confidence: 'exact',
            multiplier: 100,
            notes: [],
          },
        },
      }),
      trade({ id: 'stock', strategy: 'STOCK', pnl: '20', metadata: {} }),
    ]);

    expect(summary.coverage).toMatchObject({
      closedTrades: 3,
      withFiniteRisk: 2,
      excluded: 1,
      medianFiniteRisk: 100,
    });
    expect(summary.rBuckets.find((bucket) => bucket.label === '+2..+3')?.count).toBe(1);
    expect(summary.rBuckets.find((bucket) => bucket.label === '<-1R')?.count).toBe(1);
    expect(summary.gradeBuckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2);
    expect(summary.flagCounts).toEqual([{ flag: 'slippage', count: 1 }]);
    expect(summary.byStrategy.find((row) => row.strategy === 'CALL')?.avgR).toBe(2.5);
  });
});
