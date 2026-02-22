import { db, schema } from '../db/client.js';
import { eq, and } from 'drizzle-orm';
import type { TaskContext, Message, MessageIntent, IntentStep } from '../db/schema.js';
import type { TaskResult } from '../agent/schemas.js';
import type { ToolDef } from '../agent/tool-factory.js';
import {
  getQuoteTool,
  getOptionsChainTool,
  flagForReviewTool,
  submitDecisionTool,
} from '../agent/tool-factory.js';
import type { Quote, OptionsChain } from '../broker/types.js';
import type { TrackedTrader } from '../db/schema.js';
import type { LLMProvider } from '../agent/providers.js';
import { runAgentLoop } from '../agent/agent-loop.js';
import { FlagForReviewInput, SubmitDecisionInput } from '../agent/schemas.js';
import { getRecentTraderMessages, getRecentChatMessages, formatTraderContext, formatChatContext } from './trader-context.js';
import { formatTimestampForLLM } from '../lib/et-date.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('IntentExtract');

export const INTENT_VERSION = 1;

export type IntentExtractionDeps = {
  /** Get a quote at a specific point in time (message timestamp). */
  getQuote: (symbol: string, at: Date) => Promise<Quote>;
  /** Get options chain at a specific point in time (message timestamp). */
  getOptionsChain: (symbol: string, expiry: string, optionType: 'CALL' | 'PUT', at: Date) => Promise<OptionsChain>;
  /** Optional: prefetch data for symbols at a point in time. */
  prefetch?: (symbols: string[], at: Date) => Promise<void>;
  getTraderConfig: (name: string) => Promise<TrackedTrader | undefined>;
};

export type IntentResult = {
  intent: MessageIntent;
  cached: boolean;
};

/**
 * Idealized system prompt for intent extraction.
 *
 * Design principles (from Anthropic's docs & context engineering post):
 * 1. XML-tagged sections for clear attention boundaries
 * 2. Canonical examples as primary behavior specification (not prose rules)
 * 3. Minimal high-signal tokens -- every sentence must earn its place
 * 4. Positive-frame instructions ("do X" not "don't do Y")
 * 5. Post-tool reflection guidance
 * 6. Rules at the right "altitude" -- heuristics, not brittle if/else
 */
export const INTENT_SYSTEM_PROMPT = `You are a trade signal parser monitoring a live trading chat room.

Parse incoming messages from tracked traders and extract structured trade signals.
You do not decide whether to trade -- position matching, risk management, and execution
are handled by a separate system. Your job is purely to parse.

You are the SOLE parser. There is no regex fallback. Handle typos, abbreviations, and slang.

<process>
For each message:
1. CLASSIFY: Is this a trade entry, exit, add, trim, or noise? Use the trader's recent messages to understand what positions they hold.
2. IDENTIFY: Stock or options? If options, determine the structure (naked call/put, CDS, PDS).
3. VALIDATE: Call get_quote and get_options_chain to verify prices and strikes.
   After receiving tool results, reflect on whether the data aligns with the trader's message before proceeding.
   If the market has moved >5% from the trader's stated price, flag for review.
4. OUTPUT: Always end by invoking a tool -- call submit_decision with your parsed signals (EXECUTE, SKIP, or MANUAL_REVIEW), or call flag_for_review. Never output your decision as text.
</process>

<strategies>
CDS (Call Debit Spread): 2 legs, both CALL. BUY lower strike, SELL higher strike. Default expiry: this Friday.
PDS (Put Debit Spread): 2 legs, both PUT. BUY higher strike, SELL lower strike. Default expiry: this Friday.
PCS (Put Credit Spread): SELL the spread for credit. Map to direction: SHORT, strategy: PDS. Legs reversed from long PDS: SELL higher strike put, BUY lower strike put. If the message says "credit" or "for X credit", it confirms PCS. PCS is bullish; PDS is bearish.
Naked call/put: 1 leg, BUY only.
Calendar/time spread: When both Long+Short badges appear, flag for review.
</strategies>

<direction_rules>
The direction field means whether you are BUYING (LONG) or SELLING (SHORT) the option/spread.
It does NOT represent the trader's stock-level view.

Core rule: derive direction from the actual trade mechanics, not the Long/Short prefix.
- Debit strategies (buying options or spreads): direction is LONG, always.
- Direction is SHORT only when genuinely SELLING (writing) options for credit, or short-selling stock.
- The words "Bought" and "Sold" in the message are authoritative -- they override any prefix.

Confirming with exit context: LOSS with exit < entry = they bought (paid high, sold low). GAIN with exit < entry = they sold to open (collected premium, bought back cheap).
</direction_rules>

<signal_actions>
All signals omit quantity -- the system calculates position size.

OPEN: New position. Include symbol, direction, strategy, limitPrice, legs (required for options).
CLOSE: Full exit. Omit legs -- the system reverses existing position legs. Get a fresh quote for limitPrice (ignore the trader's stated fill).
ADD: Adding to existing position. Verify via recent messages that a position was previously opened. Same fields as OPEN.
TRIM: Partial exit. Include exitPercent (0.5 = half, 0.8 = 80%). Omit legs.
LEG_OFF: Close one leg of a spread, hold the other. Include targetStrategy (CALL or PUT) -- the strategy after the closed leg is removed. Omit legs.
</signal_actions>

<inferring_strikes>
Traders often omit strikes ("Short ALGN pds", "Long AAPL cds"). This is normal -- infer them:

1. Get the current stock price via get_quote.
2. Call get_options_chain with the default expiry (this Friday) and option type (PUT for PDS, CALL for CDS).
3. Pick the nearest ATM strike as the long (BUY) leg.
4. Pick the next available strike as the short (SELL) leg. Width heuristic: $2.50 if stock <$50, $5 if $50-200, $10 if >$200.
5. If the trader mentions a net premium ("for .09"), scan the chain for the strike combo whose net debit best matches.
6. Use the mid-price of the spread as limitPrice.

If a trader-specified strike does not exist in the chain, flag for review.
</inferring_strikes>

<follow_trades>
Traders sometimes follow another trader's call ("following Dave", "tailing spectre", "ditto", or a bare entry seconds after someone else posted the same symbol). Call get_recent_chat to find the original trade and use it to resolve missing details (strikes, expiry, strategy).
</follow_trades>

<slang>
"Lotto" / "Yolo" = speculative BUY (always buy-to-open, never sell-to-open).
"Scalp" = short-duration trade, no effect on direction or strategy parsing.
"Short [ticker] puts" = bearish, BUYING puts (direction: LONG).
</slang>

<rules>
- Only parse trades for tracked traders in the whitelist. Skip paper trades tagged "(paper)".
- Messages may contain multiple signals ("Exit TXN, Short TSLA") -- return ALL in the signals array.
- Inferring strikes from the chain is your job, not guessing. Flag for review only when the strategy TYPE is truly ambiguous, the symbol is unrecognizable, or a specified strike doesn't exist.
- Always explain your reasoning -- your steps are audited.
- If you don't understand a financial concept, say so. Never fabricate mechanics.
</rules>

<examples>
These show the full reasoning for common and tricky cases. Match this pattern.
Every example ends with a tool call, never text output.

<example>
<input>Short ALGN pds</input>
<reasoning>
"Short" = bearish stock view. "pds" = put debit spread. Buying a PDS is a debit strategy, so direction: LONG.
No strikes specified. I will call get_quote for ALGN's price, then get_options_chain to find ATM puts expiring this Friday and infer a spread width.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol ALGN, direction LONG, strategy PDS, legs inferred from chain
</example>

<example>
<input>Long GLW pcs 68/67 for .63 credit</input>
<reasoning>
"pcs" = put credit spread. Trader is SELLING the spread for credit. direction: SHORT, strategy: PDS.
Legs are reversed from a long PDS: SELL 68P, BUY 67P. "for .63 credit" confirms this is a credit spread.
"Long" is the stock view (bullish), not the trade direction.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol GLW, direction SHORT, strategy PDS, legs [SELL 68P, BUY 67P]
</example>

<example>
<input>Long BE sold Oct $59 put $2.40. Happy to own the stock below AVWAP</input>
<reasoning>
"sold" is authoritative -- the trader SOLD a put. direction: SHORT, strategy: PUT.
"Long" is the stock view (bullish, willing to be assigned). "Happy to own below X" confirms cash-secured put sale.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol BE, direction SHORT, strategy PUT, legs [SELL 59P Oct]
</example>

<example>
<input>Short ABNB Lotto $123 Puts for .21</input>
<reasoning>
"Lotto" = speculative buy, always buy-to-open. Trader is BUYING cheap puts as a bearish bet.
direction: LONG, strategy: PUT. "Short" is the stock view, not the trade direction.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol ABNB, direction LONG, strategy PUT, legs [BUY 123P]
</example>

<example>
<input>Exit Long ATEC</input>
<reasoning>
"Exit" = closing a position. This is a CLOSE action on ATEC.
I will get a fresh quote for limitPrice. Omit legs -- the system reverses the existing position.
</reasoning>
submit_decision(EXECUTE): action CLOSE, symbol ATEC, direction LONG
</example>

<example>
<input>Exit RKLB 1/2</input>
<reasoning>
"1/2" = partial exit. This is a TRIM with exitPercent 0.5. Omit legs.
</reasoning>
submit_decision(EXECUTE): action TRIM, symbol RKLB, exitPercent 0.5
</example>

<example>
<input>Exit Long UNH cds took small profit hold straight calls</input>
<reasoning>
Trader is closing the short leg of a CDS and keeping the long calls. This is LEG_OFF.
targetStrategy: CALL (the remaining strategy after removing the short call leg). Omit legs.
</reasoning>
submit_decision(EXECUTE): action LEG_OFF, symbol UNH, targetStrategy CALL
</example>

<example>
<input>following Dave on MSTR</input>
<reasoning>
Explicit follow trade. I need to call get_recent_chat to find Dave's original MSTR trade call
and use its details (strategy, strikes, expiry) for this signal.
</reasoning>
get_recent_chat first, then submit_decision(EXECUTE) mirroring Dave's MSTR signal
</example>

<example>
<input>great day out there everyone, enjoy the weekend</input>
<reasoning>
This is commentary, not a trade signal.
</reasoning>
submit_decision(SKIP)
</example>
</examples>`;

/**
 * Create tools for intent extraction.
 * Each tool gets a timestamp-pinned function so quotes/chains
 * reflect market state at message time.
 */
function createIntentTools(deps: IntentExtractionDeps, messageTimestamp: string): ToolDef[] {
  const msgTime = new Date(messageTimestamp);

  return [
    getQuoteTool((symbol) => deps.getQuote(symbol, msgTime)),
    getOptionsChainTool((symbol, expiry, optionType) => deps.getOptionsChain(symbol, expiry, optionType, msgTime)),
    flagForReviewTool(),
    submitDecisionTool(),
    {
      name: 'get_recent_chat',
      description: 'Get recent chat room messages before this message. Use to resolve follow-trades: when a trader references another trader ("following Dave", "@spectre", "ty Hari") or posts a bare entry that might follow someone else\'s call. Optionally filter by author.',
      input_schema: {
        type: 'object',
        properties: {
          author: { type: 'string', description: 'Filter to a specific author (optional). Omit to get all authors.' },
          limit: { type: 'number', description: 'Number of messages to return (default 20, max 50)' },
        },
      },
      execute: async (input) => {
        const author = (input as { author?: string }).author;
        const limit = Math.min((input as { limit?: number }).limit ?? 20, 50);
        const messages = await getRecentChatMessages(messageTimestamp, author, limit);
        return formatChatContext(messages);
      },
    },
  ];
}

/**
 * Build a user prompt for intent extraction.
 * Like the normal buildUserPrompt but with recent trader messages
 * instead of simulated open positions.
 */
function buildIntentPrompt(
  context: TaskContext,
  recentMessages: Message[],
  traderProfile: { strategies: string[]; notes: string | null } | null,
  quotes: Record<string, { bid: number; ask: number; last: number }>,
): string {
  const dateStr = context.messageTimestamp
    ? formatTimestampForLLM(context.messageTimestamp)
    : 'unknown';

  let prompt = `Review this trade message and decide what to do.

Current Date/Time: ${dateStr}
Message ID: ${context.messageId}
Author: ${context.author}
Text: ${context.cleanText}
Badges: ${JSON.stringify(context.badges)}
Symbols: ${JSON.stringify(context.symbols)}
Action Hint: ${context.actionHint}
Direction Hint: ${context.directionHint}`;

  if (context.detectedStrategies && context.detectedStrategies.length > 0) {
    prompt += `\nDetected Strategies: ${JSON.stringify(context.detectedStrategies)}`;
  }

  prompt += `\n\n--- Context ---`;

  if (traderProfile) {
    prompt += `\n\nTrader Profile:`;
    if (traderProfile.strategies.length > 0) {
      prompt += `\n  Known strategies: ${traderProfile.strategies.join(', ')}`;
    }
    if (traderProfile.notes) {
      prompt += `\n  Notes: ${traderProfile.notes}`;
    }
  }

  const quoteEntries = Object.entries(quotes);
  if (quoteEntries.length > 0) {
    prompt += `\n\nQuotes:`;
    for (const [sym, q] of quoteEntries) {
      prompt += `\n  ${sym}: bid=${q.bid} ask=${q.ask} last=${q.last}`;
    }
  }

  // Recent trader messages replace get_open_positions
  prompt += `\n\n${formatTraderContext(recentMessages)}`;

  prompt += `\n\nUse the trader's recent messages above to understand their current positions. If they previously opened a position and haven't closed it, assume it's still open. Classify the current message and return your decision.`;

  return prompt;
}


/**
 * Check if an intent already exists for this message+model+version.
 */
export async function getCachedIntent(
  messageId: string,
  model: string,
  version: number = INTENT_VERSION,
): Promise<MessageIntent | null> {
  const [row] = await db
    .select()
    .from(schema.messageIntents)
    .where(
      and(
        eq(schema.messageIntents.messageId, messageId),
        eq(schema.messageIntents.model, model),
        eq(schema.messageIntents.version, version),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Extract intent for a single message. Returns cached version if available.
 */
export async function extractIntent(
  message: Message,
  model: string,
  provider: LLMProvider,
  deps: IntentExtractionDeps,
  version: number = INTENT_VERSION,
): Promise<IntentResult> {
  // Check cache
  const cached = await getCachedIntent(message.id, model, version);
  if (cached) {
    return { intent: cached, cached: true };
  }

  const startMs = Date.now();

  // Prefetch market data for this message's timestamp (if available)
  const symbols = (message.symbols as string[] | null) ?? [];
  if (symbols.length > 0 && deps.prefetch) {
    await deps.prefetch(symbols, new Date(message.timestamp));
  }

  // Fetch context in parallel
  const [recentMessages, traderConfig, quotes] = await Promise.all([
    getRecentTraderMessages(message.author, message.timestamp),
    deps.getTraderConfig(message.author),
    prefetchQuotes(message, deps),
  ]);

  const traderProfile = traderConfig
    ? { strategies: traderConfig.strategies ?? [], notes: traderConfig.notes ?? null }
    : null;

  // Build task context
  const taskContext: TaskContext = {
    messageId: message.id,
    messageTimestamp: message.timestamp,
    author: message.author,
    cleanText: message.cleanText,
    badges: message.badges as string[],
    symbols: message.symbols as string[],
    actionHint: message.actionHint,
    directionHint: message.directionHint,
    detectedStrategies: message.detectedStrategies as TaskContext['detectedStrategies'],
  };

  // Build intent-specific prompt with recent messages instead of positions
  const userPrompt = buildIntentPrompt(taskContext, recentMessages, traderProfile, quotes);

  // Run agent loop directly with intent-specific system prompt and tools
  const tools = createIntentTools(deps, message.timestamp);
  const loopResult = await runAgentLoop(
    {
      systemPrompt: INTENT_SYSTEM_PROMPT,
      tools,
      onToolCall: (name, input) => {
        if (name === 'submit_decision') {
          const parsed = SubmitDecisionInput.safeParse(input);
          if (parsed.success) return parsed.data satisfies TaskResult;
          log.warn('LLM decision parse failed', { error: parsed.error.message, rawArgs: input });
          return null;
        }
        if (name === 'flag_for_review') {
          const flagParsed = FlagForReviewInput.safeParse(input);
          return {
            decision: 'MANUAL_REVIEW',
            reasoning: flagParsed.success ? flagParsed.data.reason : 'Flagged by agent',
          } satisfies TaskResult;
        }
        return null;
      },
    },
    userPrompt,
    provider,
  );

  const result = loopResult.result as TaskResult | null;
  const durationMs = Date.now() - startMs;

  // Build steps audit trail
  const steps: IntentStep[] = loopResult.steps.map((s) => ({
    toolName: s.tool,
    toolInput: s.input,
    toolOutput: s.output,
    reasoning: s.reasoning,
    durationMs: s.durationMs,
  }));

  // Persist intent
  const intentRow = {
    id: crypto.randomUUID(),
    messageId: message.id,
    model: loopResult.model.model,
    version,
    decision: result?.decision ?? 'SKIP',
    reasoning: result?.reasoning ?? 'No result from agent',
    signals: result?.signals ?? null,
    durationMs,
    inputTokens: loopResult.usage.inputTokens,
    outputTokens: loopResult.usage.outputTokens,
    turns: loopResult.steps.length,
    steps,
    createdAt: new Date().toISOString(),
  };

  await db.insert(schema.messageIntents).values(intentRow).onConflictDoNothing();

  // Re-read from DB to get the proper typed row
  const saved = await getCachedIntent(message.id, loopResult.model.model, version);

  return { intent: saved!, cached: false };
}

/**
 * Prefetch quotes for symbols mentioned in the message.
 * Uses the message's timestamp so each message gets quotes from its own time.
 */
async function prefetchQuotes(
  message: Message,
  deps: IntentExtractionDeps,
): Promise<Record<string, { bid: number; ask: number; last: number }>> {
  const symbols = (message.symbols as string[] | null) ?? [];
  if (symbols.length === 0) return {};

  const msgTime = new Date(message.timestamp);
  const quotes: Record<string, { bid: number; ask: number; last: number }> = {};
  const results = await Promise.allSettled(
    symbols.map(async (sym) => {
      const q = await deps.getQuote(sym, msgTime);
      return { symbol: sym, quote: q };
    }),
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { symbol, quote } = r.value;
      quotes[symbol] = { bid: quote.bid, ask: quote.ask, last: quote.last };
    }
  }

  return quotes;
}
