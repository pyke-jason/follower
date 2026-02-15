import type { BrokerService } from '../broker/interface.js';
import { runReconciliation, type ReconciliationAlertInput } from './reconciler.js';
import { sendSystemAlert } from '../lib/alert.js';

export class ReconciliationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResult: ReconciliationAlertInput[] = [];
  private running = false;
  private currentRun: Promise<void> | null = null;

  constructor(
    private broker: BrokerService,
    private intervalMs: number = 5 * 60 * 1000, // 5 minutes
  ) {}

  start(): void {
    // Run immediately on start
    this.run();
    this.timer = setInterval(() => this.run(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.currentRun) await this.currentRun;
  }

  private async run(): Promise<void> {
    if (this.running) return; // prevent overlapping runs
    this.running = true;
    this.currentRun = this._run();
    await this.currentRun;
  }

  private async _run(): Promise<void> {
    try {
      this.lastResult = await runReconciliation(this.broker);
    } catch (err) {
      console.error('[RECON] Reconciliation failed:', err);
      sendSystemAlert({
        title: 'Reconciliation failed',
        message: `Scheduled reconciliation threw: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'warning',
      });
    } finally {
      this.running = false;
      this.currentRun = null;
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
      sendSystemAlert({
        title: 'Pre-trade check crashed',
        message: `Safety check itself failed — blocking trades as precaution: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'critical',
      });
      return { safe: false, alerts: [] };
    }
  }

  getLastResult(): ReconciliationAlertInput[] {
    return this.lastResult;
  }
}
