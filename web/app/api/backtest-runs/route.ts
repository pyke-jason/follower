import { NextResponse } from 'next/server';
import { getBacktestRuns } from '@/lib/queries';
import { isoToDateKey } from '@/lib/format';

export async function GET() {
  const runs = await getBacktestRuns({ limit: 30 });

  const items = runs
    .filter((r) => r.status === 'COMPLETED' || r.status === 'RUNNING' || r.status === 'CANCELLED')
    .map((r) => {
      const config = r.config;
      const summary = r.summary;
      return {
        id: r.id,
        name: r.name,
        status: r.status,
        traders: config.traders,
        startDate: isoToDateKey(config.startDate),
        endDate: isoToDateKey(config.endDate),
        totalPnl: summary?.totalPnl ?? null,
        winRate: summary?.winRate ?? null,
      };
    });

  return NextResponse.json(items);
}
