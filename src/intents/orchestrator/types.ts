/**
 * Orchestrator types — the new intent resolution contract.
 *
 * The orchestrator replaces the current skip→LLM→postprocess chain with a
 * field-by-field resolution engine. Each field resolves independently;
 * output is a fully concrete ResolvedSignal or a SKIP/FLAG outcome.
 *
 * See docs/plan-orchestrator-technical.md for the full design.
 */

import { z } from 'zod';
import {
  DirectionSchema,
  LegActionSchema,
  OptionTypeSchema,
  OrderCategorySchema,
  StrategySchema,
  TradeActionSchema,
} from '../../lib/enums.js';
import type { Direction, OptionType, Strategy } from '../../lib/enums.js';
import { SignalSchema } from '../../agent/schemas.js';
import type { Quote, OptionsChain } from '../../broker/types.js';
import type { BrokerService } from '../../broker/interface.js';
import type { SignalEventEmitter } from '../../decisions/emitter.js';
import { TradeLegSchema } from '../../db/schema.js';
import type { Message } from '../../db/schema.js';
import type { TraceContext } from '../../lib/trace.js';
import type { Agent } from '../../agent/result.js';

// ── Output schemas ────────────────────────────────────────────────────────────

export const OptionLegSchema = z.object({
  type: z.literal('option'),
  symbol: z.string().min(1),
  expiry: z.string(),
  optionType: OptionTypeSchema,
  strike: z.number(),
  side: LegActionSchema,
  quantity: z.number(),
});
export type OptionLeg = z.infer<typeof OptionLegSchema>;

export const StockLegSchema = z.object({
  type: z.literal('stock'),
  symbol: z.string().min(1),
  side: LegActionSchema,
  quantity: z.number(),
});
export type StockLeg = z.infer<typeof StockLegSchema>;

export const LegSchema = z.discriminatedUnion('type', [OptionLegSchema, StockLegSchema]);
export type Leg = z.infer<typeof LegSchema>;

/**
 * A fully concrete broker instruction produced by the orchestrator.
 * No ambiguity, no hint legs, no downstream resolution.
 *
 * - limitPrice is signed: positive = debit (paying), negative = credit (receiving).
 * - quantity on each leg is a per-lot ratio; the execution pipeline multiplies
 *   by the sized lot count.
 */
export const ResolvedSignalSchema = z.object({
  orderType: OrderCategorySchema,
  legs: z.array(LegSchema),
  limitPrice: z.number().optional(),
  action: TradeActionSchema,
  tradeId: z.string().optional(),
  exitPercent: z.number().optional(),
});
export type ResolvedSignal = z.infer<typeof ResolvedSignalSchema>;

export type { SignalEventEmitter } from '../../decisions/emitter.js';

// ── Parse-result schemas (must precede OrchestratorResult) ────────────────────

export const ComplexityFlagSchema = z.enum([
  'extra_text',       // significant commentary beyond core trade fields
  'multi_ticker',     // more than one ticker detected
  'relational',       // references another trader's message ("following Dave")
  'mixed_action',     // entry + exit in same message
  'ambiguous_strikes',  // slash pair could be date or strikes (cheap-stock spread)
  'no_badge_exit',    // exit verb detected without Exit badge — needs LLM confirmation
  'ambiguous_strategy',  // badge implies STOCK but no price/qty confirmation — needs LLM
]);
export type ComplexityFlag = z.infer<typeof ComplexityFlagSchema>;

/**
 * JSON-safe projection of ParseResult — what lands in `run_decisions.snapshot`
 * and `PARSED`/`SETTLED` event bodies. `complexityFlags` is an array here
 * (not a Set); `targetStrategy` is excluded because it is internal-only.
 */
export const SerializedParseResultSchema = z.object({
  action: TradeActionSchema.nullable(),
  symbol: z.string().nullable(),
  direction: DirectionSchema.nullable(),
  strategy: StrategySchema.nullable(),
  strikes: z.array(z.number()).nullable(),
  expiryHint: z.string().nullable(),
  premiumHint: z.number().nullable(),
  exitPercent: z.number().nullable(),
  isLotto: z.boolean(),
  isStrangle: z.boolean(),
  hasCanonicalMatch: z.boolean(),
  isHardSkip: z.boolean(),
  skipReason: z.string().nullable(),
  ruleId: z.string().nullable(),
  routeReason: z.string().nullable(),
  complexityFlags: z.array(ComplexityFlagSchema),
});
export type SerializedParseResult = z.infer<typeof SerializedParseResultSchema>;

// ── OrchestratorResult ────────────────────────────────────────────────────────

const ResultExtras = {
  parseResult: SerializedParseResultSchema.optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadInputTokens: z.number().optional(),
    cacheCreationInputTokens: z.number().optional(),
    /** Cost in USD (xAI: billed; Anthropic: computed from rates). */
    costUsd: z.number().optional(),
  }).optional(),
  llmReasoning: z.string().optional(),
  /**
   * Raw classifier output in the flat Signal schema shared with eval labels.
   * - LLM path: the raw `submit_decision.signals` array.
   * - Deterministic path: synthesized from the parse result.
   * - Hard-skip: empty array.
   */
  classifierSignals: z.array(SignalSchema).optional(),
} as const;

// Orchestrator-emitted skipCategory values. Runners layer on additional values
// ('pipeline failure', 'no execution', 'unfollowed_exit', 'flagged', 'skip')
// when building SETTLED events — that's why the column is a loose string.
const OrchestratorSkipCategorySchema = z.enum([
  'no_open_position',
  'parse_missing_symbol',
  'broker_error',
  'trim_missing_percent',
  'legoff_missing_target_strategy',
]);

export const OrchestratorResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('EXECUTE'),
    signals: z.array(ResolvedSignalSchema),
    ...ResultExtras,
  }),
  z.object({
    outcome: z.literal('SKIP'),
    reason: z.string(),
    skipCategory: OrchestratorSkipCategorySchema.optional(),
    ...ResultExtras,
  }),
  z.object({
    outcome: z.literal('MANUAL_REVIEW'),
    reason: z.string(),
    partial: z.array(ResolvedSignalSchema.partial()).optional(),
    ...ResultExtras,
  }),
]);
export type OrchestratorResult = z.infer<typeof OrchestratorResultSchema>;

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

/** Subset of a trade row needed for position matching. Validated at the DB boundary. */
export const TradePositionSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  strategy: StrategySchema,
  direction: DirectionSchema,
  legs: z.array(TradeLegSchema).min(1),
  quantity: z.number().int().positive(),
  openedAt: z.string().nullable(),
});
export type TradePosition = z.infer<typeof TradePositionSchema>;

export const TradePositionListSchema = z.array(TradePositionSchema);

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
  chatHistory?: ChatHistoryProvider;
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

/**
 * Output of the synchronous parse step. Contains everything derivable from
 * the message text and badges alone, before any I/O.
 *
 * This is an internal type — it never crosses a process or storage boundary,
 * so it keeps `Set<ComplexityFlag>` for efficient in-code add/has checks.
 * `SerializedParseResult` is the JSON-safe projection that lands in snapshots.
 */
export type ParseResult = {
  action: z.infer<typeof TradeActionSchema> | null;
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
  hasCanonicalMatch: boolean;      // true when the whole message matched a canonical trade template
  isHardSkip: boolean;             // true when message is definitively not a trade
  skipReason: string | null;
  ruleId: string | null;           // stable deterministic rule/template identifier for attribution
  routeReason: string | null;      // human-readable reason used by eval/replay reports
  complexityFlags: Set<ComplexityFlag>;
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
