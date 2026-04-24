import { db, schema, runTx } from '../db/client.js';
import { eq } from 'drizzle-orm';
import type { OrderResult } from '../broker/types.js';
import type { TradeFlag } from '../db/schema.js';
import { safeParseFloat, roundCents } from '../lib/numbers.js';
import { buildFlags } from '../trades/trade-flags.js';

/**
 * Enrich a trade record with broker fill data.
 * Computes slippage between requested entry price and actual broker fill price.
 *
 * Wrapped in a transaction to prevent read-modify-write races — the fill sweep
 * runs on a 60s interval and can race with recordTrade() updating metadata.
 */
export async function enrichTradeWithFill(
  tradeId: string,
  fillData: OrderResult,
): Promise<void> {
  await runTx(async (tx) => {
    const [trade] = await tx.select()
      .from(schema.trades)
      .where(eq(schema.trades.id, tradeId))
      .limit(1);

    if (!trade) return;

    const metadata = trade.metadata ?? {};

    // Compute slippage (direction-aware: positive = adverse, negative = improvement)
    let slippage: number | undefined;
    if (trade.entryPrice && fillData.filledPrice != null) {
      const entry = safeParseFloat(trade.entryPrice);
      const raw = trade.direction === 'LONG'
        ? fillData.filledPrice - entry   // LONG: paying more is adverse
        : entry - fillData.filledPrice;  // SHORT: receiving less is adverse
      slippage = roundCents(raw);
    }

    // Flag significant adverse slippage: >10% of entry price or >$0.20
    const slippageFlags: TradeFlag[] = [];
    const effectiveSlippage = slippage ?? metadata.slippage;
    if (effectiveSlippage != null && effectiveSlippage > 0) {
      const entry = safeParseFloat(trade.entryPrice);
      const pct = entry ? effectiveSlippage / entry : 0;
      if (pct >= 0.10 || effectiveSlippage >= 0.20) {
        slippageFlags.push('slippage');
      }
    }

    await tx.update(schema.trades)
      .set({
        brokerFillPrice: fillData.filledPrice != null ? String(fillData.filledPrice) : null,
        brokerFillQty: fillData.filledQuantity ?? null,
        brokerCommission: fillData.commission != null ? String(fillData.commission) : null,
        brokerFillTime: fillData.fillTimestamp ?? null,
        brokerLegFills: fillData.legFills ?? null,
        metadata: {
          ...metadata,
          slippage: effectiveSlippage,
          fillEnriched: true,
          fillEnrichedAt: new Date().toISOString(),
          flags: buildFlags(metadata.flags, ...slippageFlags),
        },
      })
      .where(eq(schema.trades.id, tradeId));
  });
}
