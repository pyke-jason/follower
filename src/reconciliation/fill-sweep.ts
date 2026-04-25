import { db, schema, runTx } from '../db/client.js';
import { eq, and, sql } from 'drizzle-orm';
import type { BrokerService } from '../broker/interface.js';
import { enrichTradeWithFill } from './fill-enrichment.js';
import { sendSystemAlert } from '../lib/alert.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('FillSweep');

/**
 * Periodically sweep for trades that have a broker order ID but haven't
 * been enriched with fill data yet. This catches fills that were missed
 * by the real-time onFill callback (e.g. immediate fills, restarts).
 */
export class FillSweep {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentRun: Promise<number> | null = null;
  private running = false;

  constructor(
    private broker: BrokerService,
    private channelId: string,
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
    // Mirror the guard in ReconciliationScheduler — skip if a sweep is already
    // in flight. Without this, back-to-back timer ticks could issue duplicate
    // getOrderStatus calls for the same order and race on the metadata update.
    if (this.running) return;
    this.running = true;
    this.currentRun = this.sweep()
      .catch((err) => { log.warn('Sweep error:', err); return 0; })
      .finally(() => { this.running = false; });
  }

  async sweep(): Promise<number> {
    // Find trades with brokerOrderId in metadata but not yet enriched
    const trades = await db.select()
      .from(schema.trades)
      .where(and(
        eq(schema.trades.channelId, this.channelId),
        sql`${schema.trades.metadata} ? 'brokerOrderId'`,
        sql`coalesce((${schema.trades.metadata}->>'fillEnriched')::boolean, false) is not true`,
      ));

    let enriched = 0;
    for (const trade of trades) {
      const metadata = trade.metadata ?? {};
      if (!metadata.brokerOrderId) continue;

      try {
        const status = await this.broker.getOrderStatus(metadata.brokerOrderId);
        if (status.status === 'FILLED' && status.filledPrice != null) {
          await enrichTradeWithFill(trade.id, status);
          enriched++;
        } else if (status.status === 'REJECTED' || status.status === 'CANCELLED') {
          // Re-read metadata inside transaction to avoid stale-spread race
          await runTx(async (tx) => {
            const [fresh] = await tx.select({ metadata: schema.trades.metadata })
              .from(schema.trades)
              .where(eq(schema.trades.id, trade.id))
              .limit(1);
            if (!fresh) return;
            await tx.update(schema.trades)
              .set({
                status: 'CANCELLED',
                metadata: {
                  ...(fresh.metadata ?? {}),
                  fillEnriched: true,
                  fillEnrichedAt: new Date().toISOString(),
                  brokerFinalStatus: status.status,
                },
              })
              .where(eq(schema.trades.id, trade.id));
          });
          sendSystemAlert({
            title: `Order ${status.status}`,
            message: `Order ${metadata.brokerOrderId} for ${trade.symbol} was ${status.status}. Trade marked CANCELLED.`,
            severity: 'warning',
          });
          enriched++;
        }
      } catch (err) {
        log.warn(`Error checking order ${metadata.brokerOrderId}:`, err);
      }
    }

    if (enriched > 0) {
      log.info(`Enriched ${enriched} trade(s)`);
    }
    return enriched;
  }
}
