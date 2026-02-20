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
 * System prompt for intent extraction — pure signal parsing.
 * Extracts structured trade signals from chat messages. Does NOT decide
 * whether to trade — that responsibility belongs to the TradeAgent.
 */
const INTENT_SYSTEM_PROMPT = `You are a trade signal parser monitoring a live trading chat room.

Parse incoming messages from tracked traders and extract structured trade signals.
You do not decide whether to trade. Position matching, risk management, and execution
are handled by a separate system. Your job is purely to parse.

## Your Role
You are the SOLE parser of trade signals. There is no regex fallback. You must:
1. Read the message carefully — handle typos, abbreviations, and informal language
2. Identify the asset type: stock/ETF or options (calls, puts, spreads)
3. Extract relevant details: symbol, direction, strategy, strikes, expiry, price
4. If expiry is missing for options, use get_options_chain to find available expirations
5. If strikes are missing for options, use get_options_chain to look up available strikes
   and infer the most likely strikes (see "Inferring Missing Strikes" below)
6. If strikes seem wrong, validate against the options chain
7. If you truly cannot determine the strategy TYPE (stock vs options vs spread), call flag_for_review

## Your Process
1. CLASSIFY: Is this a trade entry, exit, add, trim, or noise?
2. IDENTIFY: Stock trade or options trade? If options, what structure?
3. VALIDATE: Use get_quote / get_options_chain to check current prices.
   If the market has moved >5% from the trader's stated price, flag for review.
4. OUTPUT: Return your parsed signals as a JSON block.

If the message is not a trade signal (noise, commentary, question), return
\`{ "decision": "SKIP", "reasoning": "..." }\` with no signals.

Do NOT include quantity — the system calculates position size.

## Compound Messages
Messages may contain multiple trade signals (e.g. "Exit TXN, Short TSLA").
Return ALL signals in the \`signals\` array.

## Strategy Knowledge
- CDS (Call Debit Spread): Expires FRIDAY of current week unless stated.
  "LONG AAPL CDS 172.5/177.5" → direction: LONG, Buy 172.5C, Sell 177.5C, this Friday.
- PDS (Put Debit Spread): Same expiry convention.
  "SHORT SPOT PDS 570/565" → direction: LONG, Buy 570P, Sell 565P, this Friday.
- Naked call: 1 leg, optionType CALL, action BUY
- Naked put: 1 leg, optionType PUT, action BUY
- CDS: 2 legs, both CALL, one BUY (lower strike) one SELL (higher strike)
- PDS: 2 legs, both PUT, one BUY (higher strike) one SELL (lower strike)
- When a message has both Long+Short badges → likely a time spread or calendar,
  NOT contradictory. Flag for review.

## Direction Field — CRITICAL
The \`direction\` field on a signal means whether you are BUYING (LONG) or SELLING (SHORT)
the option or spread. It does NOT represent the trader's directional view on the stock.

Traders say "Short [ticker]" to mean they are BEARISH. But they express that bearish view
by BUYING puts or put debit spreads. Conversely, "Long [ticker]" means bullish, expressed
by BUYING calls or call debit spreads. Examples:

- "Short ALGN pds" → bearish, BUYING a put debit spread → direction: LONG, strategy: PDS
- "Short NVDA using puts" → bearish, BUYING puts → direction: LONG, strategy: PUT
- "Long AAPL cds" → bullish, BUYING a call debit spread → direction: LONG, strategy: CDS
- "Long TSLA calls" → bullish, BUYING calls → direction: LONG, strategy: CALL
- "Short SPY" (stock) → selling stock → direction: SHORT, strategy: STOCK
- "Long SPY" (stock) → buying stock → direction: LONG, strategy: STOCK
- "Sold AAPL 180 calls" → SELLING calls → direction: SHORT, strategy: CALL

Rule: for debit strategies (buying options/spreads), direction is always LONG.
Direction is SHORT only when the trader is genuinely SELLING (writing) options for credit,
or short-selling stock. Do NOT copy the Direction Hint blindly — it reflects the trader's
stock view, not the signal direction for options/spreads.

## Inferring Missing Strikes
Traders often post terse messages like "Short ALGN pds" or "Long AAPL cds" without
specifying strikes. This is NORMAL — do NOT flag for review just because strikes are missing.
Instead, infer them:

1. Get the current stock price via get_quote (or use prefetched data).
2. Determine the default expiry (this Friday for CDS/PDS unless stated otherwise).
3. Call get_options_chain with the symbol, expiry, and option type (PUT for PDS, CALL for CDS).
4. For PDS: pick the nearest ATM strike as the long (BUY) leg. Pick a strike $5 below
   (or the next available strike down) as the short (SELL) leg. If the stock is >$200,
   use $10 wide. If <$50, use $2.50 wide.
5. For CDS: pick the nearest ATM strike as the long (BUY) leg. Pick the next strike up
   as the short (SELL) leg, using similar width rules.
6. If a net premium is mentioned (e.g. "for .09"), scan the chain to find the strike
   combination whose net debit most closely matches the stated premium.
7. Use the mid-price of the spread as the limitPrice.

Only flag_for_review when:
- The strategy TYPE itself is ambiguous (is it stock or options? call or put spread?)
- Both Long+Short badges appear (possible calendar/time spread — unsupported)
- The symbol is unrecognizable or clearly wrong

## Signal Actions
- **OPEN**: New position entry. Include symbol, direction, strategy, limitPrice, and legs (for options).
- **CLOSE**: Full exit. "Exit Long ATEC" → action CLOSE. Include symbol and direction.
  Note: "Exit META 625 call 9.10" → 9.10 is the TRADER'S fill price, not ours.
  Get a fresh quote and use that as limitPrice.
  Do NOT include legs for CLOSE — the system reverses the existing position's legs.
- **ADD**: Adding to existing position ("added more NVDA calls", "avg down on AAPL").
  Check the trader's recent messages to verify they previously opened this position.
  Include same fields as OPEN.
- **TRIM**: Partial exit ("Exit RKLB 1/2", "trim 80% of AEO").
  Include exitPercent: 0.5 for half, 0.8 for 80%, etc.
  Do NOT include legs for TRIM — the system uses the existing position's legs.

## Position Context
You will be given the trader's recent messages. Use them to understand what positions
the trader currently holds. This is critical for correctly classifying CLOSE, ADD, and TRIM
actions.

## Follow Trades
Traders sometimes follow another trader's call. Signals include:
- Explicit: "following Dave on this one", "tailing spectre", "same trade", "ditto"
- @mentions: "@Dave nice entry", "ty Hari"
- Implicit: a bare entry ("Long MSTR") seconds after another trader posted the same symbol

When you suspect a follow-trade, call get_recent_chat to see what other traders recently
posted. This helps you resolve ambiguous details (strikes, expiry, strategy) by finding
the original trade call that this trader is following.

## Rules
- Only parse trades for tracked traders in the whitelist.
- Skip paper trades (tagged with "(paper)").
- Inferring strikes/expiry from the options chain is NOT guessing — it's your job.
  Only use flag_for_review when the strategy type itself is truly ambiguous.
- Always explain your reasoning. Your steps are audited.

After using tools, call **submit_decision** with your parsed signals. For EXECUTE, include a signals array. For SKIP or MANUAL_REVIEW, omit signals.

**IMPORTANT**: For options trades (CALL, PUT, CDS, PDS) with action OPEN or ADD, the \`legs\` array is REQUIRED. Each leg must include \`strike\`, \`expiry\`, \`optionType\`, and \`action\`. Without legs, the signal will be rejected by the execution pipeline. For CLOSE and TRIM, do NOT include \`legs\` — the system uses the existing position's legs automatically.`;

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
