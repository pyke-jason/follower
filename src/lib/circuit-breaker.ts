/**
 * Broker circuit breaker with exponential backoff and tiered alerting.
 *
 * Generic infrastructure — not live-specific. Both runners can use it.
 * The only injected dependency is `isHealthy` (from BrokerService) and
 * an optional `sendAlert` for operational notifications.
 */

import { BrokerTransientError } from './errors.js';

type CircuitBreakerConfig = {
  /** How often to probe health when circuit is closed (ms). Default: 30_000. */
  healthCheckCacheMs?: number;
  /** Consecutive failures before opening circuit. Default: 3. */
  openThreshold?: number;
  /** Initial backoff when circuit is open (ms). Default: 10_000. */
  backoffBaseMs?: number;
  /** Max backoff cap (ms). Default: 300_000. */
  backoffMaxMs?: number;
};

type CircuitBreakerDeps = {
  isHealthy: () => Promise<boolean>;
  sendAlert?: (params: { title: string; message: string; severity: 'critical' | 'warning' | 'info' }) => Promise<void> | void;
};

const DEFAULTS = {
  healthCheckCacheMs: 30_000,
  openThreshold: 3,
  backoffBaseMs: 10_000,
  backoffMaxMs: 300_000,
} as const;

export class BrokerCircuitBreaker {
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private lastHealthCheckAt = 0;
  private circuitOpenedAt = 0;

  private readonly healthCheckCacheMs: number;
  private readonly openThreshold: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly deps: CircuitBreakerDeps;

  constructor(deps: CircuitBreakerDeps, config: CircuitBreakerConfig = {}) {
    this.deps = deps;
    this.healthCheckCacheMs = config.healthCheckCacheMs ?? DEFAULTS.healthCheckCacheMs;
    this.openThreshold = config.openThreshold ?? DEFAULTS.openThreshold;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
    this.backoffMaxMs = config.backoffMaxMs ?? DEFAULTS.backoffMaxMs;
  }

  /**
   * Check broker health gate before claiming work.
   * Returns true if the broker is healthy and work can proceed.
   * Returns false if the circuit is open and the broker is still unhealthy.
   */
  async checkHealth(): Promise<boolean> {
    if (this.circuitOpen) {
      const backoff = Math.min(
        this.backoffBaseMs * 2 ** (this.consecutiveFailures - this.openThreshold),
        this.backoffMaxMs,
      );
      if (Date.now() - this.circuitOpenedAt < backoff) return false;
      // Probe to see if broker is back
      if (await this.probeHealth()) {
        this.closeCircuit();
        return true;
      }
      this.circuitOpenedAt = Date.now(); // reset backoff timer
      return false;
    }

    if (Date.now() - this.lastHealthCheckAt > this.healthCheckCacheMs) {
      if (!await this.probeHealth()) {
        this.openCircuit('Broker health check failed');
        return false;
      }
    }

    return true;
  }

  /** Record a successful operation — resets failure counter. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** Record a failed operation — increments counter, manages circuit state and alerting. */
  recordFailure(err: unknown): void {
    this.consecutiveFailures++;
    const errMsg = err instanceof Error ? err.message : String(err);

    if (err instanceof BrokerTransientError) {
      console.warn(`[CircuitBreaker] Broker transient error (${this.consecutiveFailures}): ${errMsg}`);
    } else {
      console.error('[CircuitBreaker] Error:', err);
    }

    // Tiered escalation
    if (this.consecutiveFailures >= 30) {
      this.deps.sendAlert?.({
        title: 'Task runner critical — 30+ consecutive failures',
        message: `${this.consecutiveFailures} failures. Last: ${errMsg}`,
        severity: 'critical',
      });
    } else if (this.consecutiveFailures >= 10) {
      this.deps.sendAlert?.({
        title: 'Task runner degraded — 10+ consecutive failures',
        message: `${this.consecutiveFailures} failures. Last: ${errMsg}`,
        severity: 'critical',
      });
    } else if (this.consecutiveFailures >= this.openThreshold) {
      this.openCircuit(`${this.consecutiveFailures} consecutive task failures`);
    } else {
      this.deps.sendAlert?.({
        title: 'Task runner poll error',
        message: `Poll loop threw (${this.consecutiveFailures}/${this.openThreshold}): ${errMsg}`,
        severity: 'warning',
      });
    }
  }

  isOpen(): boolean {
    return this.circuitOpen;
  }

  private async probeHealth(): Promise<boolean> {
    this.lastHealthCheckAt = Date.now();
    return this.deps.isHealthy();
  }

  private openCircuit(reason: string): void {
    if (!this.circuitOpen) {
      this.circuitOpen = true;
      this.circuitOpenedAt = Date.now();
      console.warn(`[CircuitBreaker] OPEN: ${reason}`);
      this.deps.sendAlert?.({
        title: 'Broker circuit breaker OPEN',
        message: `${reason}. Task claiming paused until broker is healthy.`,
        severity: 'warning',
      });
    }
  }

  private closeCircuit(): void {
    if (this.circuitOpen) {
      console.log('[CircuitBreaker] CLOSED — broker healthy');
      this.deps.sendAlert?.({
        title: 'Broker circuit breaker CLOSED',
        message: 'Broker is healthy again. Task claiming resumed.',
        severity: 'info',
      });
    }
    this.circuitOpen = false;
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = 0;
  }
}
