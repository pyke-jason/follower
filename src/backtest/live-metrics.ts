import type { LiveMetrics } from './types.js';
import { getApiStats } from './databento-tape.js';

/** Construct a LiveMetrics snapshot from the current backtest state. */
export function buildLiveMetrics(params: {
  unrealizedPnl: number | null;
  openPositionCount: number;
  lastProcessedMessageTs: string | null;
}): LiveMetrics {
  const apiStats = getApiStats();
  return {
    unrealizedPnl: params.unrealizedPnl,
    openPositionCount: params.openPositionCount,
    databentoApiFetches: apiStats.fetches,
    databentoApiBytesRead: apiStats.bytesRead,
    updatedAt: new Date().toISOString(),
    lastProcessedMessageTs: params.lastProcessedMessageTs,
  };
}
