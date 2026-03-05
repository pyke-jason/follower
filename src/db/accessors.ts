import type { TradeMetadata, TradeFlag } from './schema.js';

/** Extract materialized flags from trade metadata. */
export function getTradeFlags(row: { metadata: TradeMetadata }): TradeFlag[] {
  return row.metadata.flags ?? [];
}
