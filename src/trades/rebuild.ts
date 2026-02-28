/**
 * Diagnostic utility: replay trade_events to reconstruct expected trade row state.
 * Used for consistency checks, NOT for live reads.
 */
import { db, schema } from '../db/client.js';
import { eq, asc } from 'drizzle-orm';
import { safeParseFloat, roundCents } from '../lib/numbers.js';
import { computeTradePnl } from '../lib/pnl.js';
import { contractMultiplier } from '../lib/trade.js';
import type { TradeLeg } from '../db/schema.js';
import type { Direction } from '../lib/enums.js';

export type RebuiltState = {
  status: string;
  direction: string;
  strategy: string;
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  realizedPnl: number;
  pnl: number | null;
  legs: TradeLeg[];
  openedAt: string | null;
  closedAt: string | null;
};

export type RebuildResult = {
  tradeId: string;
  expected: RebuiltState;
  actual: {
    status: string;
    direction: string;
    strategy: string;
    entryPrice: string | null;
    exitPrice: string | null;
    quantity: number | null;
    realizedPnl: string | null;
    pnl: string | null;
    openedAt: string | null;
    closedAt: string | null;
  };
  discrepancies: string[];
};

export async function rebuildFromEvents(tradeId: string): Promise<RebuildResult> {
  const events = await db.select().from(schema.tradeEvents)
    .where(eq(schema.tradeEvents.tradeId, tradeId))
    .orderBy(asc(schema.tradeEvents.timestamp));

  if (events.length === 0) {
    throw new Error(`rebuildFromEvents: no events found for tradeId ${tradeId}`);
  }

  const state: RebuiltState = {
    status: 'OPEN',
    direction: 'LONG',
    strategy: 'STOCK',
    entryPrice: 0,
    exitPrice: null,
    quantity: 0,
    realizedPnl: 0,
    pnl: null,
    legs: [],
    openedAt: null,
    closedAt: null,
  };

  for (const event of events) {
    const price = safeParseFloat(event.price);
    const qty = event.quantity ?? 0;
    const meta = event.metadata;

    switch (event.action) {
      case 'OPEN':
        state.direction = event.direction ?? 'LONG';
        state.strategy = event.strategy ?? 'STOCK';
        state.entryPrice = price;
        state.quantity = qty;
        state.legs = (event.legs as TradeLeg[]) ?? [];
        state.openedAt = event.timestamp;
        break;

      case 'ADD': {
        const totalQty = state.quantity + qty;
        state.entryPrice = roundCents(
          (state.entryPrice * state.quantity + price * qty) / totalQty,
        );
        state.quantity = totalQty;
        break;
      }

      case 'TRIM': {
        const trimPnl = computeTradePnl({
          entryPrice: state.entryPrice,
          exitPrice: price,
          direction: state.direction as Direction,
          strategy: state.strategy,
          quantity: qty,
        });
        state.realizedPnl = roundCents(state.realizedPnl + trimPnl);
        state.quantity -= qty;
        if (state.quantity <= 0) {
          state.status = 'CLOSED';
          state.pnl = state.realizedPnl;
          state.exitPrice = price;
          state.closedAt = event.timestamp;
        }
        break;
      }

      case 'LEG_OFF': {
        const targetStrategy = meta?.targetStrategy as string;
        const keptLeg = meta?.keptLeg as TradeLeg | undefined;
        if (targetStrategy) state.strategy = targetStrategy;
        if (keptLeg) state.legs = [keptLeg];
        state.entryPrice = roundCents(state.entryPrice + price);
        break;
      }

      case 'CLOSE': {
        const closePnl = computeTradePnl({
          entryPrice: state.entryPrice,
          exitPrice: price,
          direction: state.direction as Direction,
          strategy: state.strategy,
          quantity: state.quantity,
        });
        state.pnl = roundCents(closePnl + state.realizedPnl);
        state.exitPrice = price;
        state.status = 'CLOSED';
        state.closedAt = event.timestamp;
        break;
      }
    }
  }

  // Fetch actual trade row for comparison
  const [actual] = await db.select().from(schema.trades)
    .where(eq(schema.trades.id, tradeId));

  if (!actual) {
    throw new Error(`rebuildFromEvents: trade row not found for ${tradeId}`);
  }

  const discrepancies: string[] = [];

  const check = (field: string, expected: unknown, got: unknown) => {
    const e = typeof expected === 'number' ? String(expected) : expected;
    const g = typeof got === 'number' ? String(got) : got;
    if (e !== g && !(e == null && g == null)) {
      discrepancies.push(`${field}: expected=${JSON.stringify(e)}, actual=${JSON.stringify(g)}`);
    }
  };

  check('status', state.status, actual.status);
  check('strategy', state.strategy, actual.strategy);
  check('quantity', state.quantity, actual.quantity);
  check('entryPrice', String(state.entryPrice), actual.entryPrice);
  if (state.exitPrice != null) check('exitPrice', String(state.exitPrice), actual.exitPrice);
  if (state.pnl != null) check('pnl', String(state.pnl), actual.pnl);
  if (state.realizedPnl !== 0) check('realizedPnl', String(state.realizedPnl), actual.realizedPnl);

  return {
    tradeId,
    expected: state,
    actual: {
      status: actual.status,
      direction: actual.direction,
      strategy: actual.strategy,
      entryPrice: actual.entryPrice,
      exitPrice: actual.exitPrice,
      quantity: actual.quantity,
      realizedPnl: actual.realizedPnl,
      pnl: actual.pnl,
      openedAt: actual.openedAt,
      closedAt: actual.closedAt,
    },
    discrepancies,
  };
}
