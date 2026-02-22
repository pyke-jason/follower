import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getStats, getBacktestRunBrief, getRiskSnapshot } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = z.string().uuid().optional().catch(undefined).parse(searchParams.get('run') ?? undefined);

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

export const StatusResponseSchema = z.object({
  openTrades: z.number(),
  todayPnl: z.number(),
  pendingTasks: z.number(),
  tradingBlocked: z.boolean().optional(),
  unresolvedAlertCount: z.number().optional(),
  runBrief: z.object({
    id: z.string(),
    name: z.string().nullable(),
    status: z.string(),
    traders: z.array(z.string()),
    startDate: z.string(),
    endDate: z.string(),
    agentModel: z.string(),
    totalPnl: z.number(),
    winRate: z.number(),
    totalTrades: z.number(),
  }).optional(),
});
