/**
 * Orchestrator types — the new intent resolution contract.
 *
 * The orchestrator replaces the current skip→LLM→postprocess chain with a
 * field-by-field resolution engine. Each field resolves independently;
 * output is a fully concrete ResolvedSignal or a SKIP/FLAG outcome.
 *
 * See docs/plan-orchestrator-technical.md for the full design.
 */

import type { Direction, LegAction, OptionType, OrderCategory, Strategy, TradeAction } from '../../lib/enums.js';
import type { Quote, OptionsChain } from '../../broker/types.js';
import type { BrokerService } from '../../broker/interface.js';
import type { SignalEventEmitter } from '../../decisions/emitter.js';
import type { Message, TradeLeg } from '../../db/schema.js';
import type { TraceContext } from '../../lib/trace.js';
import type { Agent } from '../../agent/result.js';

// ── Output types ──────────────────────────────────────────────────────────────

export type OptionLeg = {
  type: 'option';
  symbol: string;           // underlying ticker, e.g. "AAPL"
  expiry: string;           // YYYY-MM-DD
  optionType: OptionType;
  strike: number;
  side: LegAction;
  quantity: number;         // ratio per lot (1 = standard, 2 = ratio spread)
};

export type StockLeg = {
  type: 'stock';
  symbol: string;
  side: LegAction;
  quantity: number;         // ratio per lot
};

export type Leg = OptionLeg | StockLeg;

/**
 * A fully concrete broker instruction produced by the orchestrator.
 * No ambiguity, no hint legs, no downstream resolution.
 *
 * - limitPrice is signed: positive = debit (paying), negative = credit (receiving).
 * - quantity on each leg is a per-lot ratio; the execution pipeline multiplies
 *   by the sized lot count.
 */
export type ResolvedSignal = {
  orderType: OrderCategory;
  legs: Leg[];
  limitPrice?: number;
  /** The trade action resolved by the orchestrator. Required — no implicit defaults. */
  action: TradeAction;
  /** For position-reducing signals: the trade ID matched by the orchestrator. */
  tradeId?: string;
  /** For TRIM signals: the exit fraction (0.0–1.0) from the orchestrator parse. */
  exitPercent?: number;
};

export type { SignalEventEmitter } from '../../decisions/emitter.js';

export type OrchestratorResult =
  | { outcome: 'EXECUTE'; signals: ResolvedSignal[]; parseResult?: SerializedParseResult; usage?: { inputTokens: number; outputTokens: number }; llmReasoning?: string }
  | { outcome: 'SKIP'; reason: string; parseResult?: SerializedParseResult; usage?: { inputTokens: number; outputTokens: number }; llmReasoning?: string }
  | { outcome: 'MANUAL_REVIEW'; reason: string; partial?: Partial<ResolvedSignal>[]; parseResult?: SerializedParseResult; usage?: { inputTokens: number; outputTokens: number }; llmReasoning?: string };

// ── Provider interfaces ───────────────────────────────────────────────────────

/**
 * Market data capabilities required by the orchestrator.
 * Extended beyond the existing BacktestMarketDataProvider to include
 * option chain access for strike/expiry resolution.
 */
export interface OrchestratorMarketDataProvider {
  /**
   * Get a stock or option quote. For stock tickers, returns current mid price.
   * For OCC-format option symbols, returns current option quote.
   */
  getQuote(symbol: string): Promise<Quote>;

  /**
   * Get an option chain for a specific symbol, expiry date, and option type.
   * Returns null if chain data is unavailable for this expiry.
   */
  getOptionChain(
    symbol: string,
    expiry: string,
    optionType: OptionType,
  ): Promise<OptionsChain | null>;

  /**
   * Get available expiry dates for a symbol (sorted ascending YYYY-MM-DD).
   * Returns an empty array if not available.
   */
  getExpiryDates(symbol: string): Promise<string[]>;
}

/** Subset of a trade row needed for position matching. Uses TradeLeg directly — no field renaming. */
export type TradePosition = {
  id: string;
  symbol: string;
  strategy: Strategy;
  direction: Direction;
  legs: TradeLeg[];
  quantity: number | null;
  openedAt: string | null;
};

export interface PositionProvider {
  /** Get open positions, optionally filtered by underlying symbol. */
  getPositions(symbol?: string): Promise<TradePosition[]>;
}

export interface ChatHistoryProvider {
  /**
   * Get recent chat messages as formatted text for LLM context.
   * @param author - optional author filter
   * @param limit  - max messages to return
   */
  getRecentMessages(author?: string, limit?: number): Promise<string>;
}

/** Dependencies the orchestrator needs from the caller's environment. */
export type OrchestratorEnv = {
  getPositions: (symbol?: string) => Promise<TradePosition[]>;
  agent: Agent;
  broker: BrokerService;
  emitter: SignalEventEmitter;
  trace?: TraceContext;
};

/** Everything the orchestrator might need, injected at the call site. */
export type OrchestratorContext = {
  message: Message;
  marketData: OrchestratorMarketDataProvider;
  positions: PositionProvider;
  chatHistory: ChatHistoryProvider;
  /**
   * Set when retrying after a 422 symbol-not-found error at execution time.
   * Presence of this field forces the LLM path so it can correct the bad strike.
   */
  failureContext?: { error: string };
};

// ── Internal parse types ──────────────────────────────────────────────────────

export type ComplexityFlag =
  | 'extra_text'     // significant commentary beyond core trade fields
  | 'multi_ticker'   // more than one ticker detected
  | 'relational'     // references another trader's message ("following Dave")
  | 'mixed_action'   // entry + exit in same message
  | 'ambiguous_strikes'  // slash pair could be date or strikes (cheap-stock spread)
  | 'no_badge_exit'      // exit verb detected without Exit badge — needs LLM confirmation
  | 'ambiguous_strategy';  // badge implies STOCK but no price/qty confirmation — needs LLM

/**
 * Output of the synchronous parse step. Contains everything derivable from
 * the message text and badges alone, before any I/O.
 *
 * This is an internal type — it never appears in the orchestrator's output.
 */
export type ParseResult = {
  action: TradeAction | null;
  symbol: string | null;
  direction: Direction | null;
  strategy: Strategy | null;
  strikes: number[] | null;        // explicit strikes from text
  expiryHint: string | null;       // raw text hint ("next week", "LEAP", "Oct")
  premiumHint: number | null;      // stated premium (absolute value)
  exitPercent: number | null;      // for TRIM: 0.0–1.0
  targetStrategy: Strategy | null; // for LEG_OFF: strategy to keep
  isLotto: boolean;                // true when lotto/yolo detected
  isStrangle: boolean;             // true when strangle/straddle detected
  isHardSkip: boolean;             // true when message is definitively not a trade
  skipReason: string | null;
  complexityFlags: Set<ComplexityFlag>;
};

/**
 * Serializable subset of ParseResult — complexityFlags as array, minus
 * internal-only fields (targetStrategy, skipReason).
 * New ParseResult fields auto-flow through the Omit without changes here.
 */
export type SerializedParseResult = Omit<ParseResult, 'complexityFlags' | 'targetStrategy' | 'skipReason'> & {
  complexityFlags: ComplexityFlag[];
};

/**
 * How strikes will be selected when not explicit in the message text.
 * Internal to the orchestrator; not exposed in ResolvedSignal.
 */
export type StrikeSelection =
  | { method: 'explicit'; strikes: number[] }
  | { method: 'delta'; target: number; bias: 'nearest' | 'otm' | 'itm' }
  | { method: 'atm' }
  | { method: 'premium_match'; statedPremium: number };
