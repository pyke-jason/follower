import type { TaskContext } from '../db/schema.js';
import type { PrefetchedData } from './prefetch.js';

export type SkipResult = { category: string; reason: string };

export type SkipCheckOpts = {
  /** Max open positions per symbol before blocking. Live: 5, backtest: 3. */
  maxOnSymbol: number;
  /** Max total open positions before blocking. Both: 20. */
  maxTotalPositions: number;
  /** Current agent calls used (backtest budget tracking). */
  agentCallsUsed?: number;
  /** Max agent calls allowed (backtest budget cap). */
  maxAgentCalls?: number;
};

/** Check if message ONLY references futures symbols (e.g. /ES, /NQ) */
function onlyFutures(context: TaskContext): boolean {
  const symbols = context.symbols ?? [];
  const text = context.cleanText ?? '';
  const hasFutures = symbols.some((s) => s.startsWith('/')) || /(?:^|\s)\/[A-Z]{2,4}\b/.test(text);
  if (!hasFutures) return false;
  // If there are non-futures symbols, let the agent handle it
  const nonFutures = symbols.filter((s) => !s.startsWith('/'));
  return nonFutures.length === 0;
}

/**
 * Shared deterministic pre-checks for both live and backtest runners.
 * Returns { category, reason } if the message should be skipped, or null to proceed.
 *
 * All position-dependent checks guard on !positions.failed — if the position
 * fetch failed, we let the agent run and call get_open_positions itself.
 *
 * The position count checks are a CONSERVATIVE SUBSET of what the full risk
 * service checks. The prefetch filters by trader, but the risk service may
 * count across all traders. Worst case: agent runs and gets blocked by
 * check_risk_limits. We never skip a message that should have been allowed.
 */
export function shouldSkipDeterministic(
  context: TaskContext,
  prefetched: PrefetchedData | undefined,
  opts: SkipCheckOpts,
): SkipResult | null {
  // 1. Agent budget exhausted (backtest only)
  if (
    opts.agentCallsUsed != null &&
    opts.agentCallsUsed >= (opts.maxAgentCalls ?? Infinity)
  ) {
    return {
      category: 'budget exhausted',
      reason: `Agent budget exhausted (${opts.agentCallsUsed}/${opts.maxAgentCalls ?? '∞'} calls used)`,
    };
  }

  // 2. Futures-only messages
  if (onlyFutures(context)) {
    return { category: 'futures', reason: 'Futures symbols not supported' };
  }

  const symbols = context.symbols ?? [];
  const hasPositions = prefetched && !prefetched.positions.failed;

  // 3. CLOSE with no open position for symbol+trader
  // Guard: only when single symbol. Compound messages (e.g. "Exit TXN, Short TSLA")
  // have multiple symbols and the message-level actionHint may not apply to all of them.
  // Let the agent parse compound messages.
  if (context.actionHint === 'CLOSE' && symbols.length === 1 && hasPositions) {
    if (prefetched.positions.forSymbol.length === 0) {
      return {
        category: 'no open position',
        reason: `No open position for ${symbols[0]}/${context.author}`,
      };
    }
  }

  // 4. OPEN + max positions on symbol reached
  // Same compound-message guard: with multiple symbols, some may be fine.
  if (context.actionHint === 'OPEN' && symbols.length === 1 && hasPositions) {
    if (prefetched.positions.forSymbol.length >= opts.maxOnSymbol) {
      return {
        category: 'max on symbol',
        reason: `Already ${prefetched.positions.forSymbol.length} positions open on ${symbols[0]} (max ${opts.maxOnSymbol})`,
      };
    }
  }

  // 5. OPEN + max total positions reached
  if (context.actionHint === 'OPEN' && hasPositions) {
    if (prefetched.positions.totalCount >= opts.maxTotalPositions) {
      return {
        category: 'max total positions',
        reason: `${prefetched.positions.totalCount} total open positions (max ${opts.maxTotalPositions})`,
      };
    }
  }

  return null;
}
