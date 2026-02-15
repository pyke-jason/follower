import { NextResponse } from 'next/server';
import { getStats, getBacktestRunBrief, getRiskSnapshot } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('run') ?? undefined;

  const stats = await getStats(runId);

  if (runId) {
    // Backtest mode: attach run brief
    const runBrief = await getBacktestRunBrief(runId);
    return NextResponse.json({
      ...stats,
      runBrief: runBrief ?? undefined,
    });
  } else {
    // Live mode: attach risk snapshot fields
    const risk = await getRiskSnapshot();
    return NextResponse.json({
      ...stats,
      tradingBlocked: risk.tradingBlocked,
      unresolvedAlertCount: risk.unresolvedAlerts,
    });
  }
}
