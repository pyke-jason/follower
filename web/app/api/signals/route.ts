import { NextResponse } from 'next/server';
import { getRecentSignals } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') ?? '20', 10);
  const runId = searchParams.get('run') ?? undefined;
  const signals = await getRecentSignals(limit, runId);
  return NextResponse.json(signals);
}
