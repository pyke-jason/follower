/**
 * Retroactive closeMessageId linking for backtest CLOSE signals.
 *
 * When a CLOSE signal fails to execute in the pipeline (e.g. position already
 * closed by sim-broker), the message that triggered it still semantically
 * "belongs" to the close. This function links the message to the most recently
 * closed trade that matches the signal's symbol/trader/run and has no
 * closeMessageId set.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { isClosed, forRun, forSymbol, forTrader } from '../trades/filters.js';
import type { trades as TradesTable } from '../db/schema.js';

type PipelineResult = {
  executed: boolean;
  orderId?: string;
  signal: { action: string; symbol: string };
};

type DbLike = {
  select: () => any;
  update: (table: any) => any;
};

type SchemaLike = {
  trades: typeof TradesTable;
};

export async function retroactiveLinkCloseMessage(
  pipelineResults: PipelineResult[],
  messageId: string,
  author: string,
  runId: string,
  db: DbLike,
  schema: SchemaLike,
): Promise<string[]> {
  const linked: string[] = [];
  for (const r of pipelineResults) {
    if (!r.executed && !r.orderId && r.signal.action === 'CLOSE') {
      const [target] = await db.select()
        .from(schema.trades)
        .where(and(
          isClosed,
          forRun(runId),
          forSymbol(r.signal.symbol),
          forTrader(author),
          isNull(schema.trades.closeMessageId),
        ))
        .orderBy(desc(schema.trades.closedAt))
        .limit(1);
      if (target) {
        await db.update(schema.trades)
          .set({ closeMessageId: messageId })
          .where(eq(schema.trades.id, target.id));
        linked.push(target.id);
      }
    }
  }
  return linked;
}
