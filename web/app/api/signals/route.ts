import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRecentSignals } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).catch(20),
  run: z.string().uuid().optional().catch(undefined),
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const { limit, run: runId } = QuerySchema.parse({
    limit: searchParams.get('limit') ?? undefined,
    run: searchParams.get('run') ?? undefined,
  });
  const signals = await getRecentSignals(limit, runId);
  return NextResponse.json(signals);
}

export const SignalsResponseSchema = z.array(z.object({
  message: z.object({
    id: z.string(),
    author: z.string(),
    cleanText: z.string().nullable(),
    actionHint: z.string().nullable(),
    directionHint: z.string().nullable(),
    badges: z.array(z.string()).nullable(),
    symbols: z.array(z.unknown()).nullable(),
    timestamp: z.string(),
  }),
  trade: z.object({
    id: z.string().nullable(),
    status: z.string().nullable(),
    pnl: z.string().nullable(),
    symbol: z.string().nullable(),
  }).nullable(),
}));
