import { db, schema } from '../db/client.js';
import { eq, and } from 'drizzle-orm';
import type { TaskContext, Message, MessageIntent, IntentStep } from '../db/schema.js';
import type { TaskResult } from '../agent/schemas.js';
import type { ToolDef } from '../agent/tool-factory.js';
import {
  flagForReviewTool,
  submitDecisionTool,
} from '../agent/tool-factory.js';
import type { Quote } from '../broker/types.js';
import type { TrackedTrader } from '../db/schema.js';
import type { LLMProvider } from '../agent/providers.js';
import { runAgentLoop } from '../agent/agent-loop.js';
import { FlagForReviewInput, SubmitDecisionInput } from '../agent/schemas.js';
import { getRecentTraderMessages, getRecentChatMessages, formatTraderContext, formatChatContext } from './trader-context.js';
import { formatTimestampForLLM } from '../lib/et-date.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('IntentExtract');

export const INTENT_VERSION = 7;

export type IntentExtractionDeps = {
  /** Get a quote at a specific point in time (message timestamp). */
  getQuote: (symbol: string, at: Date) => Promise<Quote>;
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
You do not decide whether to trade -- position matching, risk management, strike inference,
and execution are handled by a separate system. Your job is purely to parse text into structured intent.

You are the SOLE parser. There is no regex fallback. Handle typos, abbreviations, and slang.

<process>
For each message:
1. CLASSIFY: Is this a new trade entry, full exit, partial exit (trim), leg-off, or noise? Use the trader's recent messages to understand what positions they hold.
2. IDENTIFY: Stock or options? If options, determine the structure (naked call/put, CDS, PDS).
3. VALIDATE: Check the prefetched stock quotes in the message context. If the price seems wildly inconsistent with the trader's message, flag for review.
4. OUTPUT: Always end by invoking a tool -- call submit_decision with your parsed signals (EXECUTE, SKIP, or MANUAL_REVIEW), or call flag_for_review. Never output your decision as text.
</process>

<strategies>
CDS (Call Debit Spread): 2 legs, both CALL. BUY lower strike, SELL higher strike. Default expiry: this Friday.
PDS (Put Debit Spread): 2 legs, both PUT. BUY higher strike, SELL lower strike. Default expiry: this Friday.
PCS (Put Credit Spread): SELL the spread for credit. Map to direction: SHORT, strategy: PDS. Legs reversed from long PDS: SELL higher strike put, BUY lower strike put. If the message says "credit" or "for X credit", it confirms PCS. PCS is bullish; PDS is bearish.
Naked call/put: exactly 1 element in the legs array, action BUY only.
Calendar/time spread: When both Long+Short badges appear, flag for review.
</strategies>

<direction_rules>
Direction applies only to OPEN signals. For CLOSE, TRIM, and LEG_OFF, direction is optional and only used as a disambiguation hint.

The direction field means whether you are BUYING (LONG) or SELLING (SHORT) the option/spread.
It does NOT represent the trader's stock-level view.

Core rule: derive direction from the actual trade mechanics, not the Long/Short prefix.
- Debit strategies (buying options or spreads): direction is LONG, always.
- Direction is SHORT only when genuinely SELLING (writing) options for credit, or short-selling stock.
- The words "Bought" and "Sold" in the message are authoritative -- they override any prefix.
</direction_rules>

<signal_actions>
All signals omit quantity -- the system calculates position size.
Pricing: the system computes all prices from market data. You never set prices.
If the trader states a premium ("for $3.72", "for .09", "$2.40 credit"), include it as statedPremium on OPEN signals only.

OPEN: New position OR adding to an existing position. Always use OPEN for any entry -- the system detects whether a position already exists and handles accordingly.
  Required: symbol, direction, strategy.
  Optional: legs (include ONLY when the trader explicitly states strikes; omit to let the system infer ATM), statedPremium.

CLOSE: Full exit of an existing position. The system finds the position by symbol and trader.
  Required: symbol.
  Optional: direction, strategy (include as hints when the trader holds multiple positions on the same symbol, e.g. both stock and options).
  Omit: legs, statedPremium.

TRIM: Partial exit.
  Required: symbol, exitPercent (0.5 = half, 0.8 = 80%).
  Optional: direction, strategy (same disambiguation rule as CLOSE).
  Omit: legs, statedPremium.

LEG_OFF: Close one leg of a spread, hold the other.
  Required: symbol, targetStrategy (CALL or PUT -- the strategy AFTER the closed leg is removed).
  Optional: direction, strategy (same disambiguation rule as CLOSE).
  Omit: legs, statedPremium.
</signal_actions>

<follow_trades>
Traders sometimes follow another trader's call ("following Dave", "tailing spectre", "ditto", or a bare entry seconds after someone else posted the same symbol). Call get_recent_chat to find the original trade and use it to resolve missing details (strikes, expiry, strategy).
</follow_trades>

<slang>
"Lotto" / "Yolo" = speculative BUY (always buy-to-open, never sell-to-open).
"Scalp" = short-duration trade, no effect on direction or strategy parsing.
"Short [ticker] puts" = bearish, BUYING puts (direction: LONG).
</slang>

<exit_language>
Traders rarely say "Exit" in casual chat. Recognize these as CLOSE (or TRIM if partial):
- Completed action: "took profits on X", "sold X", "closed X", "booked profits on X", "banked gains on X", "locked in profits on X", "done with X", "off the table on X"
- Stopped out: "got stopped on X", "stopped out of X", "hit my stop on X"
- Forced/auto exit: "got assigned on X", "called away on X"
- Trim variants: "sold half X", "trimmed X", "took some off X", "lightened X", "peeled off some X", "cut X in half"
- Leg-off variants: "sold the short leg of X", "closed the spread side of X", "holding just calls/puts now"

Key distinction -- action vs. commentary:
- ACTION (parse as signal): The trader describes what THEY DID ("I took profits on CRWV", "sold my AAPL calls", "out of the TXN position"). First person, past tense, specific position referenced.
- COMMENTARY (SKIP): The trader describes market conditions or someone else's results ("CRWV had great profits today", "anyone taking profits here?", "that was a nice move on AAPL"). No first-person action, or phrased as question/observation.

When ambiguous AND the trader's recent messages show an open position on that symbol, bias toward CLOSE. A false CLOSE on a held position is caught downstream (the system finds the position and closes it -- correct if the trader did exit). A false SKIP on a real exit means the position stays open indefinitely -- much worse.
</exit_language>

<rules>
- Only parse trades for tracked traders in the whitelist. Skip paper trades tagged "(paper)".
- A message may contain multiple DIFFERENT trades ("Exit TXN, Short TSLA") -- one signal per distinct trade. Never emit two signals for the same symbol -- combine all attributes into one signal.
- "Adding more", "avg down", "doubled down" = OPEN (the system detects existing positions automatically). Do not try to determine if a position already exists.
- Legs only apply to OPEN signals.
- When the trader states explicit strikes, include them in legs. When strikes are omitted, omit legs entirely -- the system infers them.
- Always output expiry as YYYY-MM-DD. Traders write dates many ways ("12/19", "Dec 19", "12/19/25") -- convert them. For MM/DD without a year, use the next occurrence of that date on or after the message date. A bare month name like "Oct" with no day means the standard monthly expiry (3rd Friday of that month). When a date appears as "Oct (10)", the number in parentheses is the day (October 10th), not a contract count.
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
No strikes specified. Omit legs -- the system infers ATM strikes from the stock price.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol ALGN, direction LONG, strategy PDS
</example>

<example>
<input>Long GLW pcs 68/67 for .63 credit</input>
<reasoning>
"pcs" = put credit spread. Trader is SELLING the spread for credit. direction: SHORT, strategy: PDS.
Legs are reversed from a long PDS: SELL 68P, BUY 67P. "for .63 credit" confirms this is a credit spread.
"Long" is the stock view (bullish), not the trade direction.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol GLW, direction SHORT, strategy PDS, legs [SELL 68P, BUY 67P], statedPremium 0.63
</example>

<example>
<input>Long BE sold Oct $59 put $2.40. Happy to own the stock below AVWAP</input>
<reasoning>
"sold" is authoritative -- the trader SOLD a put. direction: SHORT, strategy: PUT.
"Long" is the stock view (bullish, willing to be assigned). "Happy to own below X" confirms cash-secured put sale.
"Oct" with no day = standard monthly expiry = 3rd Friday of October. Output as YYYY-MM-DD.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol BE, direction SHORT, strategy PUT, legs [SELL 59P expiry=3rd-Friday-of-Oct as YYYY-MM-DD], statedPremium 2.40
</example>

<example>
<input>Long JOBY sold Oct (10) $15 put @ $.60. I only did one contract. You can still get this trade off.</input>
<reasoning>
"sold" is authoritative -- the trader SOLD a put. direction: SHORT, strategy: PUT.
"Long" is the stock view. "Oct (10)" = October 10th -- the number in parentheses is the day, not a contract count (quantity is handled separately).
Output expiry as 2025-10-10.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol JOBY, direction SHORT, strategy PUT, legs [SELL 15P expiry=2025-10-10], statedPremium 0.60
</example>

<example>
<input>Short ABNB Lotto $123 Puts for .21</input>
<reasoning>
"Lotto" = speculative buy, always buy-to-open. Trader is BUYING cheap puts as a bearish bet.
direction: LONG, strategy: PUT. "Short" is the stock view, not the trade direction.
This is ONE signal (the put purchase), not two (do not separately parse "Short ABNB" as a stock short).
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol ABNB, direction LONG, strategy PUT, legs [BUY 123P], statedPremium 0.21
</example>

<example>
<input>Adding more NVDA calls, avg down</input>
<reasoning>
"Adding more" = entering more of an existing position. Use OPEN -- the system detects that a NVDA CALL position already exists and handles the add automatically.
direction: LONG (buying calls). strategy: CALL.
No strikes stated, so omit legs.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol NVDA, direction LONG, strategy CALL
</example>

<example>
<input>Exit Long ATEC</input>
<reasoning>
"Exit" = closing a position. This is a CLOSE action on ATEC.
"Long" hints at direction but is optional for exits. Omit legs and statedPremium -- the system handles exit pricing.
</reasoning>
submit_decision(EXECUTE): action CLOSE, symbol ATEC
</example>

<example>
<input>Out of AAPL stock</input>
<reasoning>
"Out of" = closing a position. This is a CLOSE on AAPL.
"stock" tells us the strategy -- include strategy STOCK as a hint.
No direction stated, so omit it.
</reasoning>
submit_decision(EXECUTE): action CLOSE, symbol AAPL, strategy STOCK
</example>

<example>
<input>Exit RKLB 1/2</input>
<reasoning>
"1/2" = partial exit. This is a TRIM with exitPercent 0.5.
No direction or strategy stated, so omit them. Omit legs and statedPremium.
</reasoning>
submit_decision(EXECUTE): action TRIM, symbol RKLB, exitPercent 0.5
</example>

<example>
<input>Exit Long UNH cds took small profit hold straight calls</input>
<reasoning>
Trader is closing the short leg of a CDS and keeping the long calls. This is LEG_OFF.
targetStrategy: CALL (the remaining strategy after removing the short call leg). Omit legs and statedPremium.
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
<input>Long AAPL 180/185 cds for $2.10</input>
<reasoning>
Single CDS trade on AAPL. The spread has 2 legs (BUY 180C, SELL 185C) but this is ONE signal, not two.
direction: LONG (debit strategy). statedPremium: 2.10.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol AAPL, direction LONG, strategy CDS, legs [BUY 180C, SELL 185C], statedPremium 2.10
</example>

<example>
<input>great day out there everyone, enjoy the weekend</input>
<reasoning>
This is commentary, not a trade signal.
</reasoning>
submit_decision(SKIP)
</example>

<example>
<input>Took profits on CRWV calls this morning</input>
<reasoning>
"Took profits" = completed exit action. First person, past tense. This is a CLOSE on CRWV.
"calls" hints at strategy CALL. "this morning" is timing context, not actionable.
</reasoning>
submit_decision(EXECUTE): action CLOSE, symbol CRWV, strategy CALL
</example>

<example>
<input>Sold half my TSLA puts, letting the rest ride</input>
<reasoning>
"Sold half" = partial exit. This is a TRIM on TSLA with exitPercent 0.5.
"puts" hints at strategy PUT. "letting the rest ride" confirms this is partial, not full exit.
</reasoning>
submit_decision(EXECUTE): action TRIM, symbol TSLA, strategy PUT, exitPercent 0.5
</example>

<example>
<input>Done with the MSTR position, booked a small gain</input>
<reasoning>
"Done with" = exit action. "booked a small gain" confirms a completed trade. First person, past tense. CLOSE on MSTR.
No strategy or direction stated, so omit them.
</reasoning>
submit_decision(EXECUTE): action CLOSE, symbol MSTR
</example>

<example>
<input>NVDA having a great day, wish I had more</input>
<reasoning>
This is commentary about NVDA's price action. "wish I had more" suggests the trader is still long, not exiting.
No first-person exit action described. This is noise.
</reasoning>
submit_decision(SKIP)
</example>

<example>
<input>Locked in AMZN 200/210 CDS for 3.50</input>
<reasoning>
"Locked in" can sound like an exit, but the trader specifies full entry details (strikes 200/210, strategy CDS, premium 3.50). This is an OPEN, not a CLOSE. Entry details (strikes + premium + strategy) override exit-like keywords.
direction: LONG (debit spread). statedPremium: 3.50.
</reasoning>
submit_decision(EXECUTE): action OPEN, symbol AMZN, direction LONG, strategy CDS, legs [BUY 200C, SELL 210C], statedPremium 3.50
</example>
</examples>`;

/**
 * Create tools for intent extraction.
 * Each tool gets a timestamp-pinned function so quotes
 * reflect market state at message time.
 */
function createIntentTools(deps: IntentExtractionDeps, messageTimestamp: string): ToolDef[] {
  return [
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
