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
export function enrichTradeWithFill(
  tradeId: string,
  fillData: OrderResult,
): void {
  runTx((tx) => {
    const [trade] = tx.select()
      .from(schema.trades)
      .where(eq(schema.trades.id, tradeId))
      .limit(1)
      .all();

    if (!trade) return;

    const metadata = trade.metadata ?? {};

    // Compute slippage if we have both entry and fill prices
    let slippage: number | undefined;
    if (trade.entryPrice && fillData.filledPrice != null) {
      const entry = safeParseFloat(trade.entryPrice);
      slippage = roundCents(fillData.filledPrice - entry);
    }

    // Flag significant slippage: >10% of entry price or >$0.20 absolute
    const slippageFlags: TradeFlag[] = [];
    const effectiveSlippage = slippage ?? metadata.slippage;
    if (effectiveSlippage != null) {
      const entry = safeParseFloat(trade.entryPrice);
      const pct = entry ? Math.abs(effectiveSlippage / entry) : 0;
      if (pct >= 0.10 || Math.abs(effectiveSlippage) >= 0.20) {
        slippageFlags.push('slippage');
      }
    }

    tx.update(schema.trades)
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
      .where(eq(schema.trades.id, tradeId))
      .run();
  });
}
