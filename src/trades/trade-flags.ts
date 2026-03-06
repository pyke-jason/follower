import { db, schema, runTx } from '../db/client.js';
import { and, eq, ne } from 'drizzle-orm';

import { isOpen, forChannel, forSymbol, forTrader } from './filters.js';
import type { TradeFlag, TradeMetadata } from '../db/schema.js';

/** Merge + dedup trade flags. Pure function — no I/O. */
export function buildFlags(existing: TradeFlag[] | undefined, ...newFlags: (TradeFlag | undefined)[]): TradeFlag[] {
  const set = new Set(existing ?? []);
  for (const f of newFlags) {
    if (f) set.add(f);
  }
  return [...set];
}

/** Read a trade's metadata, append flags, write back atomically. For async updaters outside recordTrade. */
export function addTradeFlags(tradeId: string, ...flags: TradeFlag[]): void {
  runTx((tx) => {
    const [row] = tx.select({ metadata: schema.trades.metadata })
      .from(schema.trades)
      .where(eq(schema.trades.id, tradeId))
      .limit(1)
      .all();
    if (!row) return;
    const meta = row.metadata;
    const merged = buildFlags(meta.flags, ...flags);
    tx.update(schema.trades)
      .set({ metadata: { ...meta, flags: merged } satisfies TradeMetadata })
      .where(eq(schema.trades.id, tradeId))
      .run();
  });
}

/**
 * Stamp `hasUpdate` on every open trade matching any of the given symbols
 * for this trader+channel, excluding the trade opened by this very message.
 * Called from processTask AFTER execution (EXECUTE path) or before return (SKIP path)
 * so that trades just closed by this message are excluded by the isOpen filter.
 */
export async function stampHasUpdate(params: {
  symbols: string[];
  trader: string;
  channelId: string;
  messageId: string;
}): Promise<void> {
  const { symbols, trader, channelId, messageId } = params;
  if (symbols.length === 0) return;

  for (const symbol of symbols) {
    const rows = await db
      .select({ id: schema.trades.id, metadata: schema.trades.metadata })
      .from(schema.trades)
      .where(and(
        isOpen,
        forSymbol(symbol),
        forTrader(trader),
        forChannel(channelId),
        ne(schema.trades.sourceMessageId, messageId),
      ));

    for (const row of rows) {
      const meta = row.metadata;
      if (meta.flags?.includes('hasUpdate')) continue;
      const merged = buildFlags(meta.flags, 'hasUpdate');
      await db.update(schema.trades)
        .set({ metadata: { ...meta, flags: merged } satisfies TradeMetadata })
        .where(eq(schema.trades.id, row.id));
    }
  }
}
