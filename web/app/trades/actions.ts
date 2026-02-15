'use server';

import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

const LOCAL_API_URL = process.env.LOCAL_API_URL ?? 'http://localhost:4000';

export async function forceExitTrade(formData: FormData) {
  const tradeId = formData.get('tradeId') as string;
  if (!tradeId) return;

  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId));

  if (!trade || trade.status !== 'OPEN') return;

  try {
    const legs = (trade.legs as any[]) || [];

    // Build closing legs (reverse each leg's action)
    const closingLegs = legs.map((leg: any) => ({
      ...leg,
      action: leg.action === 'BUY' ? 'SELL' : 'BUY',
    }));

    const res = await fetch(`${LOCAL_API_URL}/trades/force-exit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: trade.symbol,
        strategy: trade.strategy,
        direction: trade.direction,
        legs: closingLegs,
      }),
    });

    if (!res.ok) {
      throw new Error(`Local API error: ${res.status} ${await res.text()}`);
    }

    const result = await res.json() as { orderId: string; status: string; filledPrice: number | null };

    await db
      .update(schema.trades)
      .set({
        status: 'CLOSED',
        exitPrice: result.filledPrice != null ? String(result.filledPrice) : null,
        closedAt: new Date().toISOString(),
        metadata: {
          ...(trade.metadata as any),
          forceExitOrderId: result.orderId,
          forceExitStatus: result.status,
        },
      })
      .where(eq(schema.trades.id, tradeId));
  } catch (err) {
    // If broker call fails, still mark as closed with error metadata
    await db
      .update(schema.trades)
      .set({
        status: 'CLOSED',
        closedAt: new Date().toISOString(),
        metadata: {
          ...(trade.metadata as any),
          forceExitError: err instanceof Error ? err.message : String(err),
        },
      })
      .where(eq(schema.trades.id, tradeId));
  }

  revalidatePath('/trades/open');
  revalidatePath('/trades');
  revalidatePath('/');
}
