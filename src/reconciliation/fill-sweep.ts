import { db, schema } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import type { BrokerService } from '../broker/interface.js';
import type { TradeMetadata } from '../db/schema.js';
import { enrichTradeWithFill } from '../tasks/recorder.js';
import { sendSystemAlert } from '../lib/alert.js';

/**
 * Periodically sweep for trades that have a broker order ID but haven't
 * been enriched with fill data yet. This catches fills that were missed
 * by the real-time onFill callback (e.g. immediate fills, restarts).
 */
export class FillSweep {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentRun: Promise<number> | null = null;

  constructor(
    private broker: BrokerService,
    private intervalMs: number = 60_000,
  ) {}

  start(): void {
    this._runSweep();
    this.timer = setInterval(() => this._runSweep(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.currentRun) await this.currentRun;
  }

  private _runSweep(): void {
    this.currentRun = this.sweep().catch((err) => {
      console.warn('Fill sweep error:', err);
      return 0;
    });
  }

  async sweep(): Promise<number> {
    // Find trades with brokerOrderId in metadata but not yet enriched
    const trades = await db.select()
      .from(schema.trades)
      .where(and(
        eq(schema.trades.isBacktest, false),
        sql`json_extract(metadata, '$.brokerOrderId') IS NOT NULL`,
        sql`json_extract(metadata, '$.fillEnriched') IS NOT true`,
      ));

    let enriched = 0;
    for (const trade of trades) {
      const metadata = (trade.metadata ?? {}) as TradeMetadata;
      if (!metadata.brokerOrderId) continue;

      try {
        const status = await this.broker.getOrderStatus(metadata.brokerOrderId);
        if (status.status === 'FILLED' && status.filledPrice != null) {
          await enrichTradeWithFill(trade.id, status);
          enriched++;
        } else if (status.status === 'REJECTED' || status.status === 'CANCELLED') {
          await db.update(schema.trades)
            .set({
              status: 'CANCELLED',
              metadata: {
                ...metadata,
                fillEnriched: true,
                fillEnrichedAt: new Date().toISOString(),
                brokerFinalStatus: status.status,
              },
            })
            .where(eq(schema.trades.id, trade.id));
          sendSystemAlert({
            title: `Order ${status.status}`,
            message: `Order ${metadata.brokerOrderId} for ${trade.symbol} was ${status.status}. Trade marked CANCELLED.`,
            severity: 'warning',
          });
          enriched++;
        }
      } catch (err) {
        console.warn(`Fill sweep: error checking order ${metadata.brokerOrderId}:`, err);
      }
    }

    if (enriched > 0) {
      console.log(`Fill sweep: enriched ${enriched} trade(s)`);
    }
    return enriched;
  }
}
