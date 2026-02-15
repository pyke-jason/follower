import type { BrokerService } from '../broker/interface.js';
import { runReconciliation, type ReconciliationAlertInput } from './reconciler.js';

export class ReconciliationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResult: ReconciliationAlertInput[] = [];
  private running = false;

  constructor(
    private broker: BrokerService,
    private intervalMs: number = 5 * 60 * 1000, // 5 minutes
  ) {}

  start(): void {
    // Run immediately on start
    this.run();
    this.timer = setInterval(() => this.run(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    if (this.running) return; // prevent overlapping runs
    this.running = true;
    try {
      this.lastResult = await runReconciliation(this.broker);
    } catch (err) {
      console.error('[RECON] Reconciliation failed:', err);
    } finally {
      this.running = false;
    }
  }

  /**
   * Run reconciliation on-demand and return a safety assessment.
   * safe=false if any DB_ONLY alerts exist (we think something is open but broker disagrees).
   */
  async preTradeCheck(): Promise<{ safe: boolean; alerts: ReconciliationAlertInput[] }> {
    try {
      const alerts = await runReconciliation(this.broker);
      this.lastResult = alerts;
      const safe = !alerts.some((a) => a.type === 'DB_ONLY');
      return { safe, alerts };
    } catch (err) {
      console.error('[RECON] Pre-trade check failed:', err);
      // If reconciliation fails, don't block trading
      return { safe: true, alerts: [] };
    }
  }

  getLastResult(): ReconciliationAlertInput[] {
    return this.lastResult;
  }
}
