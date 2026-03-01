import { db, schema } from '../db/client.js';
import { eq } from 'drizzle-orm';
import type { OrderResult } from '../broker/types.js';
import { safeParseFloat, roundCents } from '../lib/numbers.js';

/**
 * Enrich a trade record with broker fill data.
 * Computes slippage between requested entry price and actual broker fill price.
 */
export async function enrichTradeWithFill(
  tradeId: string,
  fillData: OrderResult,
): Promise<void> {
  const [trade] = await db.select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId))
    .limit(1);

  if (!trade) return;

  const metadata = trade.metadata ?? {};

  // Compute slippage if we have both entry and fill prices
  let slippage: number | undefined;
  if (trade.entryPrice && fillData.filledPrice != null) {
    const entry = safeParseFloat(trade.entryPrice);
    slippage = roundCents(fillData.filledPrice - entry);
  }

  await db.update(schema.trades)
    .set({
      brokerFillPrice: fillData.filledPrice != null ? String(fillData.filledPrice) : null,
      brokerFillQty: fillData.filledQuantity ?? null,
      brokerCommission: fillData.commission != null ? String(fillData.commission) : null,
      brokerFillTime: fillData.fillTimestamp ?? null,
      brokerLegFills: fillData.legFills ?? null,
      metadata: {
        ...metadata,
        slippage: slippage ?? metadata.slippage,
        fillEnriched: true,
        fillEnrichedAt: new Date().toISOString(),
      },
    })
    .where(eq(schema.trades.id, tradeId));
}
