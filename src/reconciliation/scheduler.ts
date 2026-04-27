import type { BrokerService } from '../broker/interface.js';
import { runReconciliation, type ReconciliationAlertInput } from './reconciler.js';
import { sendSystemAlert } from '../lib/alert.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ReconScheduler');

const RECON_FAILURE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

export class ReconciliationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResult: ReconciliationAlertInput[] = [];
  private lastPagedKeys: Set<string> = new Set();
  private running = false;
  private currentRun: Promise<void> | null = null;
  private lastFailureAlertAt = 0;

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
    // Skip the run entirely when the broker is unreachable. Otherwise each cycle
    // produces ~10 retry warnings (5× getPositions + 5× getAccountBalance) plus a
    // ReconScheduler error log, all for the same root cause the operator already knows.
    try {
      if (!(await this.broker.isHealthy())) {
        log.debug('Broker unhealthy — skipping reconciliation cycle');
        return;
      }
    } catch {
      // isHealthy throwing is itself a "broker is down" signal — treat the same.
      log.debug('Broker isHealthy() threw — skipping reconciliation cycle');
      return;
    }

    try {
      const newAlerts = await runReconciliation(this.broker, this.channelId);
      this.lastResult = newAlerts;
      // Successful run — reset the failure-alert cooldown so any future failure alerts immediately.
      this.lastFailureAlertAt = 0;

      // State-change page: runReconciliation returns the FULL current drift set (the DB-side
      // dedup happens inside the reconciler), so naive "length > 0" pages every 5-min cycle
      // for the same persistent drift. Only emit Pushover/Discord when at least one drift
      // KEY (type|symbol|tradeId) is newly seen vs the last cycle. Resolved keys silently
      // drop out; persistent BSX/TSCO-style drift pages once and stays quiet until it changes.
      const currentKeys = new Set(
        newAlerts.map((a) => `${a.type}|${a.symbol}|${a.tradeId ?? ''}`),
      );
      const trulyNewKeys = [...currentKeys].filter((k) => !this.lastPagedKeys.has(k));
      this.lastPagedKeys = currentKeys;

      if (trulyNewKeys.length > 0) {
        const fresh = newAlerts.filter((a) =>
          trulyNewKeys.includes(`${a.type}|${a.symbol}|${a.tradeId ?? ''}`),
        );
        const sortedSymbols = Array.from(new Set(fresh.map((a) => a.symbol))).sort();
        const sortedTypes = Array.from(new Set(fresh.map((a) => a.type))).sort();
        const symbols = sortedSymbols.join(', ');
        const types = sortedTypes.join(', ');
        sendSystemAlert({
          title: `Reconciliation drift: ${types}`,
          message: `${fresh.length} new alert(s) on ${symbols}. New OPEN trades are blocked until resolved.`,
          severity: 'critical',
          // Cross-restart backstop: in-memory lastPagedKeys resets on every
          // backend restart, which is what was spamming Jason overnight.
          // The DB cooldown (default 1800s) survives restarts.
          cooldownKey: `recon-drift|${types}|${symbols}|${this.channelId}`,
        });
      }
    } catch (err) {
      log.error('Reconciliation failed:', err);
      // Throttle: when the broker is down, this fires every 5 min cycle.
      // Once per 15 min is enough to know it's still failing.
      const now = Date.now();
      if (now - this.lastFailureAlertAt >= RECON_FAILURE_ALERT_COOLDOWN_MS) {
        this.lastFailureAlertAt = now;
        sendSystemAlert({
          title: 'Reconciliation failed',
          message: `Scheduled reconciliation threw: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'warning',
        });
      }
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
