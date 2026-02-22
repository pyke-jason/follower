'use server';

import { db, schema } from '@/lib/db';
import { TradeLeg } from '@db/schema';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const LOCAL_API_URL = process.env.LOCAL_API_URL ?? 'http://localhost:4000';

export async function forceExitTrade(formData: FormData) {
  const tradeId = z.string().uuid('tradeId must be a UUID').parse(formData.get('tradeId'));

  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId));

  if (!trade || trade.status !== 'OPEN') return;

  const legs = trade.legs;
  const closingLegs = legs.map((leg: TradeLeg) => ({
    ...leg,
    action: leg.action === 'BUY' ? 'SELL' : 'BUY',
  }));

  // The API route handles both the broker order AND the recordTrade call
  // (emits trade_events, updates trades row through the canonical write path).
  const res = await fetch(`${LOCAL_API_URL}/trades/force-exit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tradeId: trade.id,
      symbol: trade.symbol,
      trader: trade.trader,
      strategy: trade.strategy,
      direction: trade.direction,
      legs: closingLegs,
    }),
  });

  if (!res.ok) {
    throw new Error(`Force exit failed: ${res.status} ${await res.text()}`);
  }

  revalidatePath('/trades/open');
  revalidatePath('/trades');
  revalidatePath('/');
}
