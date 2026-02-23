import type { BrokerService } from '../broker/interface.js';
import type { OrderLeg } from '../broker/types.js';
import { roundCents } from '../lib/numbers.js';

/**
 * Computes the spread midpoint price from leg quotes.
 *
 * Uses the same netting logic as SimBroker.getOptionSpreadQuote():
 * - BUY legs add to the net cost (buy at ask, sell at bid)
 * - SELL legs subtract (sell at bid, buy at ask)
 * - Net values are normalized to positive bid <= ask
 * - Midpoint is (bid + ask) / 2, rounded to cents
 *
 * The legs must already have correct `.symbol` properties
 * (OCC symbol for options, ticker for stocks).
 */
export async function getSpreadMidpoint(
  broker: BrokerService,
  legs: OrderLeg[],
): Promise<number> {
  let netBid = 0;
  let netAsk = 0;

  for (const leg of legs) {
    const quote = await broker.getQuote(leg.symbol);

    if (leg.action === 'BUY') {
      netBid += quote.bid;
      netAsk += quote.ask;
    } else {
      netBid -= quote.ask;
      netAsk -= quote.bid;
    }
  }

  // Normalize to positive values with bid <= ask.
  // SELL legs produce negative net values (credit spreads);
  // normalize so the midpoint is always a positive price.
  const absBid = Math.abs(netBid);
  const absAsk = Math.abs(netAsk);
  netBid = Math.min(absBid, absAsk);
  netAsk = Math.max(absBid, absAsk);

  return roundCents((netBid + netAsk) / 2);
}
