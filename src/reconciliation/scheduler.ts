import type { BrokerService } from '../broker/interface.js';
import { runReconciliation, type ReconciliationAlertInput } from './reconciler.js';
import { sendSystemAlert } from '../lib/alert.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ReconScheduler');

export class ReconciliationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResult: ReconciliationAlertInput[] = [];
  private running = false;
  private currentRun: Promise<void> | null = null;

  constructor(
    private broker: BrokerService,
    private channelId: string,
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
      const newAlerts = await runReconciliation(this.broker, this.channelId);
      this.lastResult = newAlerts;

      // Fire critical alert immediately on any new drift — don't wait for the next cycle.
      if (newAlerts.length > 0) {
        const symbols = Array.from(new Set(newAlerts.map((a) => a.symbol))).join(', ');
        const types = Array.from(new Set(newAlerts.map((a) => a.type))).join(', ');
        sendSystemAlert({
          title: `Reconciliation drift: ${types}`,
          message: `${newAlerts.length} new alert(s) on ${symbols}. New OPEN trades are blocked until resolved.`,
          severity: 'critical',
        });
      }
    } catch (err) {
      log.error('Reconciliation failed:', err);
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
   * safe=false if any unresolved alerts exist (any drift type blocks new opens).
   */
  async preTradeCheck(): Promise<{ safe: boolean; alerts: ReconciliationAlertInput[] }> {
    try {
      const alerts = await runReconciliation(this.broker, this.channelId);
      this.lastResult = alerts;
      const safe = alerts.length === 0;
      return { safe, alerts };
    } catch (err) {
      log.error('Pre-trade check failed:', err);
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
