/**
 * Trade Agent — the single decision-making abstraction.
 *
 * Given parsed signals and portfolio state, decides what actions to take.
 * The RuleBasedTradeAgent wraps deterministic-skips and position sizing
 * logic so the runner doesn't call them directly.
 */
import type { Signal } from '../agent/schemas.js';
import type { OrderParams } from '../broker/types.js';
import { buildOrderFromSignal } from '../pipeline/execute.js';
import type { PositionSize } from '../position-sizing/index.js';
import { shouldSkipDeterministic, shouldSkipSignal } from '../agent/deterministic-skips.js';
import type { SkipCheckOpts } from '../agent/deterministic-skips.js';
import type { PrefetchedData } from '../agent/prefetch.js';
import type { TaskContext } from '../db/schema.js';
// ─── Value Objects ─────────────────────────────────

export type Action =
  | { type: 'PLACE_ORDER'; order: OrderParams; signal: Signal; trader: string; reasoning: string }
  | { type: 'CLOSE_POSITION'; tradeId: string; reasoning: string }
  | { type: 'NO_OP'; reasoning: string };

// ─── Interface ─────────────────────────────────────

export interface TradeAgent {
  /**
   * Given a parsed signal, trader, task context, and prefetched data,
   * decide whether to act and return the actions.
   */
  onSignal(
    signal: Signal,
    trader: string,
    taskContext: TaskContext,
    prefetched: PrefetchedData | undefined,
    allowedStrategies?: string[],
  ): Promise<Action[]>;
}

// ─── Rule-Based Implementation ─────────────────────

export type RuleBasedTradeAgentConfig = {
  skipOpts: SkipCheckOpts;
  calculateSize: (input: {
    trader: string;
    symbol: string;
    entryPrice: number;
    strategy: string;
    spreadMaxRisk?: number;
  }) => Promise<PositionSize>;
};

/**
 * Deterministic trade agent. No LLM calls — applies skip checks and
 * position sizing rules to decide whether a signal should become an order.
 */
export class RuleBasedTradeAgent implements TradeAgent {
  constructor(private config: RuleBasedTradeAgentConfig) {}

  async onSignal(
    signal: Signal,
    trader: string,
    taskContext: TaskContext,
    prefetched: PrefetchedData | undefined,
    allowedStrategies?: string[],
  ): Promise<Action[]> {
    // 1. Deterministic skip checks
    const skip = shouldSkipDeterministic(taskContext, prefetched, this.config.skipOpts);
    if (skip) {
      return [{ type: 'NO_OP', reasoning: `[deterministic] ${skip.reason}` }];
    }

    // 2. Strategy gate — skip before expensive sizing/risk operations
    const strategySkip = shouldSkipSignal(signal, allowedStrategies);
    if (strategySkip) {
      return [{ type: 'NO_OP', reasoning: `[strategy] ${strategySkip.reason}` }];
    }

    // 3. Position sizing (for OPEN/ADD) — skip when legs are missing
    //    (pipeline will re-size with broker quote and resolve legs)
    const hasLegs = signal.strategy === 'STOCK' || (signal.legs && signal.legs.length > 0);
    let quantity = 1;
    if ((signal.action === 'OPEN' || signal.action === 'ADD') && hasLegs) {
      const size = await this.config.calculateSize({
        trader,
        symbol: signal.symbol,
        entryPrice: signal.statedPremium ?? 0,
        strategy: signal.strategy,
      });
      if (size.quantity <= 0) {
        return [{ type: 'NO_OP', reasoning: `Position sizer returned qty=${size.quantity}` }];
      }
      quantity = size.quantity;
    }

    // 4. Build order from signal — skip preview when legs are missing (pipeline resolves them)
    const referenceDate = taskContext.messageTimestamp ? new Date(taskContext.messageTimestamp) : new Date();
    let order: OrderParams;
    if (hasLegs) {
      order = buildOrderFromSignal(signal, quantity, referenceDate);
    } else {
      order = { symbol: signal.symbol, strategy: signal.strategy, direction: signal.direction, legs: [], orderType: 'MARKET' };
    }
    return [{
      type: 'PLACE_ORDER',
      order,
      signal,
      trader,
      reasoning: `${signal.action} ${signal.direction} ${signal.strategy} ${signal.symbol} qty=${quantity}`,
    }];
  }

}
