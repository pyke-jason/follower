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
    this.currentRun = this.sweep().catch((err) => {
      log.warn('Sweep error:', err);
      return 0;
    });
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
          const partialQty = status.filledQuantity ?? 0;
          const hasPartialFill = partialQty > 0 && status.filledPrice != null;

          // Re-read metadata inside transaction to avoid stale-spread race
          await runTx(async (tx) => {
            const [fresh] = await tx.select({ metadata: schema.trades.metadata })
              .from(schema.trades)
              .where(eq(schema.trades.id, trade.id))
              .limit(1);
            if (!fresh) return;

            if (hasPartialFill) {
              // Partial fill — keep trade OPEN with the actual filled quantity/price.
              // The reconciler will catch any remaining broker/DB discrepancy on next cycle.
              await tx.update(schema.trades)
                .set({
                  quantity: partialQty,
                  brokerFillPrice: String(status.filledPrice!),
                  brokerFillQty: partialQty,
                  brokerFillTime: status.fillTimestamp ?? new Date().toISOString(),
                  metadata: {
                    ...(fresh.metadata ?? {}),
                    fillEnriched: true,
                    fillEnrichedAt: new Date().toISOString(),
                    brokerFinalStatus: status.status,
                    partialFill: true,
                    originalQuantity: trade.quantity ?? undefined,
                  },
                })
                .where(eq(schema.trades.id, trade.id));
            } else {
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
            }
          });

          if (hasPartialFill) {
            sendSystemAlert({
              title: `Partial fill — ${trade.symbol} order ${status.status.toLowerCase()}`,
              message: `Order ${metadata.brokerOrderId} partially filled ${partialQty}/${trade.quantity ?? '?'} @ $${status.filledPrice}. Trade kept OPEN at actual quantity. Verify position at broker.`,
              severity: 'critical',
            });
          } else {
            sendSystemAlert({
              title: `Order ${status.status}`,
              message: `Order ${metadata.brokerOrderId} for ${trade.symbol} was ${status.status}. Trade marked CANCELLED.`,
              severity: 'warning',
            });
          }
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
