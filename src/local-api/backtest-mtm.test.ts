import { describe, expect, test } from 'vitest';
import { withLiveBacktestMtmSnapshot } from './backtest-mtm.js';
import type { LiveMetrics } from '@/backtest/types.js';

function liveMetrics(overrides: Partial<LiveMetrics> = {}): LiveMetrics {
  return {
    unrealizedPnl: 123.456,
    openPositionCount: 3,
    databentoApiFetches: 0,
    databentoApiBytesRead: 0,
    updatedAt: '2026-04-24T15:00:00.000Z',
    lastProcessedMessageTs: '2025-09-29T19:02:50.000Z',
    phase: 'REPLAYING',
    extractedMessages: 0,
    totalExtractMessages: 0,
    ...overrides,
  };
}

describe('withLiveBacktestMtmSnapshot', () => {
  test('appends the current live MTM point for an active run', () => {
    const result = withLiveBacktestMtmSnapshot({
      status: 'RUNNING',
      liveMetrics: liveMetrics(),
      mtmSnapshots: [
        { date: '2025-09-26', unrealizedPnl: -10 },
        { date: '2025-09-27', unrealizedPnl: -5 },
      ],
    });

    expect(result).toEqual([
      { date: '2025-09-26', unrealizedPnl: -10 },
      { date: '2025-09-27', unrealizedPnl: -5 },
      { date: '2025-09-29', unrealizedPnl: 123.46 },
    ]);
  });

  test('replaces an existing same-day snapshot with the live value', () => {
    const result = withLiveBacktestMtmSnapshot({
      status: 'RUNNING',
      liveMetrics: liveMetrics({ unrealizedPnl: -42 }),
      mtmSnapshots: [
        { date: '2025-09-28', unrealizedPnl: 10 },
        { date: '2025-09-29', unrealizedPnl: 11 },
      ],
    });

    expect(result).toEqual([
      { date: '2025-09-28', unrealizedPnl: 10 },
      { date: '2025-09-29', unrealizedPnl: -42 },
    ]);
  });

  test('does not add a live point for completed runs', () => {
    const mtmSnapshots = [{ date: '2025-09-27', unrealizedPnl: -5 }];

    const result = withLiveBacktestMtmSnapshot({
      status: 'COMPLETED',
      liveMetrics: liveMetrics(),
      mtmSnapshots,
    });

    expect(result).toBe(mtmSnapshots);
  });

  test('does not add a stale live point before the latest persisted snapshot', () => {
    const mtmSnapshots = [{ date: '2025-09-30', unrealizedPnl: 10 }];

    const result = withLiveBacktestMtmSnapshot({
      status: 'RUNNING',
      liveMetrics: liveMetrics({ lastProcessedMessageTs: '2025-09-29T19:02:50.000Z' }),
      mtmSnapshots,
    });

    expect(result).toBe(mtmSnapshots);
  });
});
