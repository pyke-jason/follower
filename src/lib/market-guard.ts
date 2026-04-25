/**
 * Market guard — gates order execution against session + halt state.
 *
 * Used by the pipeline executor (execute-resolved.ts) to reject OPEN signals
 * that arrive outside RTH or while a symbol is halted.  CLOSE/TRIM signals
 * bypass the session check (we must be able to exit at any time) but are
 * still blocked during an active symbol halt since halted instruments are
 * not tradeable.
 */

import type { MarketSession } from './et-date.js';
import { getMarketSession } from './et-date.js';
import { HaltTracker } from './halt-tracker.js';

type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: string; session: MarketSession };

export class MarketGuard {
  constructor(
    private readonly haltTracker: HaltTracker,
    private readonly now: () => Date,
    private readonly enabled: boolean = true,
  ) {}

  /** Disabled guard — always allows. Used in backtest where the executor
   * is driven by historical bars and session/halt rules don't apply. */
  static disabled(): MarketGuard {
    return new MarketGuard(new HaltTracker(), () => new Date(), false);
  }

  /**
   * Check whether a signal should proceed.
   * @param symbol          Underlying symbol (e.g. "TSLA", not the OCC string).
   * @param isPositionReducing  True for CLOSE/TRIM/LEG_OFF signals.
   */
  checkSignal(symbol: string, isPositionReducing: boolean): GuardResult {
    if (!this.enabled) return { allowed: true };
    // Halted symbols: block ALL orders — halted instruments can't trade.
    if (this.haltTracker.isHalted(symbol)) {
      return {
        allowed: false,
        reason: `${symbol} is in a trading halt`,
        session: getMarketSession(this.now()),
      };
    }

    // Position-reducing signals bypass session checks — exits should never be blocked.
    if (isPositionReducing) return { allowed: true };

    const session = getMarketSession(this.now());

    if (session === 'holiday') {
      return { allowed: false, reason: 'Market closed (holiday/weekend) — OPEN not executed', session };
    }

    if (session !== 'regular') {
      return { allowed: false, reason: `Outside RTH (${session}-market) — OPEN not executed`, session };
    }

    return { allowed: true };
  }

  /** Mark a symbol as halted (default 15 min cooldown). */
  markHalted(symbol: string): void {
    this.haltTracker.markHalted(symbol);
  }

  /** Current NYSE session. */
  getSession(): MarketSession {
    return getMarketSession(this.now());
  }
}
