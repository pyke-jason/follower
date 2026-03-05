/**
 * Adapters for converting DB trade rows to domain types.
 */
import type { LegAction } from '../lib/enums.js';
import type { OpenPosition } from '../intents/orchestrator/types.js';
import { trades } from '../db/schema.js';

export function tradeToOpenPosition(row: typeof trades.$inferSelect): OpenPosition {
  const legs = row.legs.map(leg => ({
    symbol: leg.symbol,
    side: leg.action as LegAction,
    quantity: leg.quantity ?? 1,
    expiry: leg.expiry ?? '',
    strike: leg.strike ?? 0,
    type: (leg.type === 'STOCK' ? 'stock' : 'option') as 'stock' | 'option',
    ...(leg.type !== 'STOCK' && { optionType: leg.type as 'CALL' | 'PUT' }),
  }));

  return {
    id: row.id,
    symbol: row.symbol,
    strategy: row.strategy,
    direction: row.direction,
    legs,
    quantity: row.quantity ?? 1,
  };
}
