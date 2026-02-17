/**
 * Trade Agent — the single decision-making abstraction.
 *
 * Given parsed signals and portfolio state, decides what actions to take.
 * The RuleBasedTradeAgent wraps existing deterministic-skips and risk-check
 * logic so the runner doesn't call them directly.
 */
import type { Signal } from '../agent/schemas.js';
import type { Trade } from '../db/schema.js';
import type { AccountBalance, Quote, OrderParams } from '../broker/types.js';
import { buildOrderFromSignal } from '../pipeline/execute.js';
import type { PositionSize } from '../position-sizing/index.js';
import { shouldSkipDeterministic } from '../agent/deterministic-skips.js';
import type { SkipCheckOpts } from '../agent/deterministic-skips.js';
import type { PrefetchedData } from '../agent/prefetch.js';
import type { TaskContext } from '../db/schema.js';
import { checkRiskLimits } from '../orders/risk-check.js';
import type { RiskCheckConfig, RiskCheckDeps } from '../orders/risk-check.js';

// ─── Value Objects ─────────────────────────────────

export type PortfolioState = {
  positions: Trade[];
  balance: AccountBalance;
  quotes: Map<string, Quote>;
};

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
  ): Promise<Action[]>;

  /** Called at backtest end — force-close all remaining positions. */
  onBacktestEnd(state: PortfolioState): Promise<Action[]>;
}

// ─── Rule-Based Implementation ─────────────────────

export type RuleBasedTradeAgentConfig = {
  skipOpts: SkipCheckOpts;
  riskDeps: RiskCheckDeps;
  riskConfig: RiskCheckConfig;
  calculateSize: (input: {
    trader: string;
    symbol: string;
    entryPrice: number;
    strategy: string;
    spreadMaxRisk?: number;
  }) => Promise<PositionSize>;
};

/**
 * Deterministic trade agent. No LLM calls — applies skip checks, risk limits,
 * and position sizing rules to decide whether a signal should become an order.
 */
export class RuleBasedTradeAgent implements TradeAgent {
  constructor(private config: RuleBasedTradeAgentConfig) {}

  async onSignal(
    signal: Signal,
    trader: string,
    taskContext: TaskContext,
    prefetched: PrefetchedData | undefined,
  ): Promise<Action[]> {
    // 1. Deterministic skip checks
    const skip = shouldSkipDeterministic(taskContext, prefetched, this.config.skipOpts);
    if (skip) {
      return [{ type: 'NO_OP', reasoning: `[deterministic] ${skip.reason}` }];
    }

    // 2. Risk checks (for position-increasing actions)
    if (signal.action === 'OPEN' || signal.action === 'ADD') {
      const risk = await checkRiskLimits(
        { symbol: signal.symbol, strategy: signal.strategy, trader, action: signal.action },
        this.config.riskDeps,
        this.config.riskConfig,
      );
      if (!risk.allowed) {
        return [{ type: 'NO_OP', reasoning: `Risk blocked: ${risk.reason}` }];
      }
    }

    // 3. Position sizing (for OPEN/ADD)
    let quantity = 1;
    if (signal.action === 'OPEN' || signal.action === 'ADD') {
      const size = await this.config.calculateSize({
        trader,
        symbol: signal.symbol,
        entryPrice: signal.limitPrice ?? 0,
        strategy: signal.strategy,
      });
      if (size.quantity <= 0) {
        return [{ type: 'NO_OP', reasoning: `Position sizer returned qty=${size.quantity}` }];
      }
      quantity = size.quantity;
    }

    // 4. Build order from signal
    const order = buildOrderFromSignal(signal, quantity);
    return [{
      type: 'PLACE_ORDER',
      order,
      signal,
      trader,
      reasoning: `${signal.action} ${signal.direction} ${signal.strategy} ${signal.symbol} qty=${quantity}`,
    }];
  }

  async onBacktestEnd(_state: PortfolioState): Promise<Action[]> {
    // Force-close is handled by SimBroker.forceCloseAll directly
    return [{ type: 'NO_OP', reasoning: 'Backtest end — positions closed by broker' }];
  }
}
