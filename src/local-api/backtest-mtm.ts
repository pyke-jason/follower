import type { LiveMetrics } from '@/backtest/types.js';
import { roundCents } from '@/lib/numbers.js';

type BacktestMtmSnapshot = {
  date: string;
  unrealizedPnl: number;
};

export function withLiveBacktestMtmSnapshot(params: {
  status: string;
  liveMetrics: LiveMetrics | null | undefined;
  mtmSnapshots: BacktestMtmSnapshot[];
}): BacktestMtmSnapshot[] {
  const { status, liveMetrics, mtmSnapshots } = params;
  const lastProcessedMessageTs = liveMetrics?.lastProcessedMessageTs;
  const unrealizedPnl = liveMetrics?.unrealizedPnl;

  if (status === 'COMPLETED' || !lastProcessedMessageTs || unrealizedPnl == null) {
    return mtmSnapshots;
  }

  const liveDate = lastProcessedMessageTs.split('T')[0];
  const latestSnapshot = mtmSnapshots.at(-1);
  if (latestSnapshot && latestSnapshot.date > liveDate) {
    return mtmSnapshots;
  }

  const liveSnapshot = { date: liveDate, unrealizedPnl: roundCents(unrealizedPnl) };
  let replaced = false;
  const merged = mtmSnapshots.map((snapshot) => {
    if (snapshot.date !== liveDate) return snapshot;
    replaced = true;
    return liveSnapshot;
  });

  if (!replaced) merged.push(liveSnapshot);

  return merged.sort((a, b) => a.date.localeCompare(b.date));
}
