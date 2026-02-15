import { NextResponse } from 'next/server';
import { getBacktestRuns } from '@/lib/queries';
import type { BacktestRunConfig, BacktestRunSummary } from '../../../../src/db/schema';

export async function GET() {
  const runs = await getBacktestRuns({ limit: 30 });

  const items = runs
    .filter((r) => r.status === 'COMPLETED' || r.status === 'RUNNING' || r.status === 'CANCELLED')
    .map((r) => {
      const config = r.config as BacktestRunConfig;
      const summary = r.summary as BacktestRunSummary | null;
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        traders: config.traders,
        startDate: config.startDate.split('T')[0],
        endDate: config.endDate.split('T')[0],
        totalPnl: summary?.totalPnl ?? null,
        winRate: summary?.winRate ?? null,
      };
    });

  return NextResponse.json(items);
}
