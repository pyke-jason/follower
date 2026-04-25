#!/usr/bin/env tsx
/**
 * Backfill `metadata.risk` on every trade by re-running the risk model
 * against the trade's current strategy/direction/entry/quantity/legs.
 *
 * Why: the risk model was added to `recordTrade()` after these rows were
 * written, so they have no `risk` snapshot. Without this they show as
 * "excluded" in the Trade Quality panel forever.
 *
 * For trades that have been through LEG_OFF, this approximates by replaying
 * the event log so `riskTopologyChanged` and the frozen peak come out right.
 *
 * Usage:
 *   npx tsx scripts/backfill-trade-risk.ts                  # write
 *   npx tsx scripts/backfill-trade-risk.ts --dry-run        # preview
 *   npx tsx scripts/backfill-trade-risk.ts --channel bt:abc # scope
 *   npx tsx scripts/backfill-trade-risk.ts --limit 50       # bound
 */

import { eq, asc } from 'drizzle-orm';
import { db, schema } from '../src/db/client.js';
import { updateTradeRiskSnapshot } from '../src/trades/trade-risk.js';
import { roundCents, safeParseFloat } from '../src/lib/numbers.js';
import type {
  Direction,
  Strategy,
  TradeLeg,
  TradeMetadata,
  TradeRiskSnapshot,
} from '../src/db/schema.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit'));
  if (!a) return undefined;
  const v = a.includes('=') ? a.split('=')[1] : args[args.indexOf(a) + 1];
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
})();
const CHANNEL = (() => {
  const a = args.find((x) => x.startsWith('--channel'));
  if (!a) return undefined;
  return a.includes('=') ? a.split('=')[1] : args[args.indexOf(a) + 1];
})();

async function main(): Promise<void> {
  console.log(
    `[backfill-risk] mode=${DRY_RUN ? 'DRY-RUN' : 'WRITE'}` +
      `${LIMIT ? ` limit=${LIMIT}` : ''}` +
      `${CHANNEL ? ` channel=${CHANNEL}` : ''}`,
  );

  const trades = CHANNEL
    ? await db.select().from(schema.trades).where(eq(schema.trades.channelId, CHANNEL))
    : await db.select().from(schema.trades);
  const target = LIMIT ? trades.slice(0, LIMIT) : trades;
  console.log(`[backfill-risk] processing ${target.length} of ${trades.length} trades`);

  let updated = 0;
  let unchanged = 0;
  let errors = 0;

  for (const trade of target) {
    try {
      const events = await db
        .select()
        .from(schema.tradeEvents)
        .where(eq(schema.tradeEvents.tradeId, trade.id))
        .orderBy(asc(schema.tradeEvents.timestamp));

      const risk = events.length > 0
        ? replayRiskFromEvents(trade, events)
        : recomputeRiskFromTradeRow(trade);

      if (!risk) { unchanged++; continue; }

      const before = trade.metadata.risk;
      const same = before
        && before.peakRisk === risk.peakRisk
        && before.currentRisk === risk.currentRisk
        && before.basis === risk.basis
        && before.riskTopologyChanged === risk.riskTopologyChanged;
      if (same) { unchanged++; continue; }

      if (DRY_RUN) {
        console.log(
          `[dry-run] ${trade.id.slice(0, 8)} ${trade.strategy}/${trade.direction} ` +
            `peak ${before?.peakRisk ?? 'null'} -> ${risk.peakRisk ?? 'null'} ` +
            `basis ${before?.basis ?? '-'} -> ${risk.basis}` +
            `${risk.riskTopologyChanged ? ' [topology changed]' : ''}`,
        );
        updated++;
        continue;
      }

      const nextMetadata: TradeMetadata = { ...trade.metadata, risk };
      await db
        .update(schema.trades)
        .set({ metadata: nextMetadata })
        .where(eq(schema.trades.id, trade.id));
      updated++;
    } catch (e) {
      errors++;
      console.error(`[backfill-risk] error ${trade.id}:`, (e as Error).message);
    }
  }

  console.log(
    `[backfill-risk] done. updated=${updated} unchanged=${unchanged} errors=${errors}`,
  );
}

type TradeRow = typeof schema.trades.$inferSelect;
type TradeEvent = typeof schema.tradeEvents.$inferSelect;

function recomputeRiskFromTradeRow(trade: TradeRow): TradeRiskSnapshot | null {
  return updateTradeRiskSnapshot({
    strategy: trade.strategy,
    direction: trade.direction,
    entryPrice: trade.entryPrice,
    quantity: trade.quantity ?? 1,
    legs: trade.legs ?? [],
  });
}

function replayRiskFromEvents(trade: TradeRow, events: TradeEvent[]): TradeRiskSnapshot | null {
  let risk: TradeRiskSnapshot | undefined;
  let strategy: Strategy = trade.strategy;
  let direction: Direction = trade.direction;
  let entryPrice: number = safeParseFloat(trade.entryPrice);
  let quantity: number = trade.quantity ?? 1;
  let legs: TradeLeg[] = trade.legs ?? [];

  for (const event of events) {
    if (event.action === 'OPEN') {
      strategy = (event.strategy as Strategy) ?? strategy;
      direction = (event.direction as Direction) ?? direction;
      entryPrice = safeParseFloat(event.price);
      quantity = event.quantity ?? quantity;
      legs = (event.legs as TradeLeg[]) ?? legs;
      risk = updateTradeRiskSnapshot({ strategy, direction, entryPrice, quantity, legs }, risk);
    } else if (event.action === 'ADD') {
      const addQty = event.quantity ?? 1;
      const addPrice = safeParseFloat(event.price);
      const totalQty = quantity + addQty;
      entryPrice = totalQty > 0
        ? roundCents((entryPrice * quantity + addPrice * addQty) / totalQty)
        : entryPrice;
      quantity = totalQty;
      risk = updateTradeRiskSnapshot({ strategy, direction, entryPrice, quantity, legs }, risk);
    } else if (event.action === 'TRIM') {
      const trimQty = event.quantity ?? 0;
      quantity = Math.max(0, quantity - trimQty);
      risk = updateTradeRiskSnapshot({ strategy, direction, entryPrice, quantity, legs }, risk);
    } else if (event.action === 'LEG_OFF') {
      const meta = event.metadata as Record<string, unknown> | null;
      const targetStrategy = (meta?.targetStrategy as Strategy | undefined) ?? undefined;
      const keptLeg = (meta?.keptLeg as TradeLeg | undefined) ?? undefined;
      if (!targetStrategy || !keptLeg) {
        if (risk) risk = { ...risk, riskTopologyChanged: true };
        continue;
      }
      const buyback = safeParseFloat(event.price);
      const newDirection: Direction = keptLeg.action === 'SELL' ? 'SHORT' : 'LONG';
      const newEntryPrice = keptLeg.action === 'SELL'
        ? roundCents(entryPrice - buyback)
        : roundCents(entryPrice + buyback);
      strategy = targetStrategy;
      direction = newDirection;
      entryPrice = newEntryPrice;
      legs = [keptLeg];
      risk = updateTradeRiskSnapshot(
        { strategy, direction, entryPrice, quantity, legs },
        risk,
        { topologyChanged: true },
      );
    } else if (event.action === 'CLOSE') {
      risk = updateTradeRiskSnapshot({ strategy, direction, entryPrice, quantity, legs }, risk);
    }
  }

  return risk ?? null;
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('[backfill-risk] fatal:', e); process.exit(1); });
