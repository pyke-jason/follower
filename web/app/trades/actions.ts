'use server';

import { db, schema } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export async function forceExitTrade(formData: FormData) {
  const tradeId = formData.get('tradeId') as string;
  if (!tradeId) return;

  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId));

  if (!trade || trade.status !== 'OPEN') return;

  // Import the broker dynamically to avoid loading it at module level
  try {
    const { placeOrder } = await import('../../../src/broker/tradestation.js');
    const legs = (trade.legs as any[]) || [];

    // Build closing legs (reverse each leg's action)
    const closingLegs = legs.map((leg: any) => ({
      ...leg,
      action: leg.action === 'BUY' ? 'SELL' : 'BUY',
    }));

    const result = await placeOrder({
      symbol: trade.symbol,
      strategy: trade.strategy,
      direction: trade.direction as 'LONG' | 'SHORT',
      legs: closingLegs,
      orderType: 'MARKET' as const,
    });

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
