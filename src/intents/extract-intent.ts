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
import type { AgentStep } from '../agent/agent-loop.js';
import { FlagForReviewInput, SubmitDecisionInput } from '../agent/schemas.js';
import { getRecentTraderMessages, getRecentChatMessages, formatTraderContext, formatChatContext } from './trader-context.js';
import { formatTimestampForLLM } from '../lib/et-date.js';
import { htmlToLLMText } from '../parsing/html.js';
import { createLogger } from '../lib/logger.js';
import { DEFAULT_VERSION } from './versions.js';
import type { IntentPipelineVersion } from './versions.js';
import type { SignalContext } from './postprocess.js';

const log = createLogger('IntentExtract');

export const INTENT_VERSION = DEFAULT_VERSION.id;

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

export const INTENT_SYSTEM_PROMPT = DEFAULT_VERSION.systemPrompt;

/** Callback for the get_recent_chat tool. */
export type ChatLookup = (author: string | undefined, limit: number) => Promise<string>;

/** Create the standard intent extraction tools with a pluggable chat lookup. */
export function createIntentTools(chat: ChatLookup): ToolDef[] {
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
        return chat(author, limit);
      },
    },
  ];
}

/**
 * Build a user prompt for intent extraction.
 * Like the normal buildUserPrompt but with recent trader messages
 * instead of simulated open positions.
 */
export function buildIntentPrompt(
  context: TaskContext,
  recentMessages: Message[],
  traderProfile: { strategies: string[]; notes: string | null } | null,
  quotes: Record<string, { bid: number; ask: number; last: number }>,
): string {
  const dateStr = context.messageTimestamp
    ? formatTimestampForLLM(context.messageTimestamp)
    : 'unknown';

  // Use inline badge-encoded text when rawHtml is available.
  // Badges are rendered as <LONG BADGE />, <SHORT BADGE />, <EXIT BADGE /> markers
  // so the LLM sees them as metadata, not as trade-direction words.
  const messageText = context.rawHtml
    ? htmlToLLMText(context.rawHtml)
    : (context.cleanText ?? '');

  let prompt = `Review this trade message and decide what to do.

Current Date/Time: ${dateStr}
Message ID: ${context.messageId}
Author: ${context.author}
Text: ${messageText}
Symbols: ${JSON.stringify(context.symbols)}`;

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

// ── Shared pipeline (used by both production and evals) ────────────────

export type IntentPipelineResult = {
  result: TaskResult | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  steps: AgentStep[];
};

/** Shared onToolCall handler for submit_decision and flag_for_review. */
export function intentOnToolCall(name: string, input: Record<string, unknown>): TaskResult | null {
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
}

/** Core intent pipeline: preprocess → agent loop → postprocess. No DB I/O. */
export async function runIntentPipeline(
  signalCtx: SignalContext,
  userPrompt: string,
  tools: ToolDef[],
  version: IntentPipelineVersion,
  provider: LLMProvider,
  temperature?: number,
): Promise<IntentPipelineResult> {
  const preprocessed = version.preprocess?.(signalCtx);
  if (preprocessed) {
    const signals = version.postprocess(preprocessed.signals, signalCtx);
    return {
      result: { ...preprocessed, signals } as unknown as TaskResult,
      model: 'preprocess',
      inputTokens: 0,
      outputTokens: 0,
      steps: [],
    };
  }

  const loopResult = await runAgentLoop(
    {
      systemPrompt: version.systemPrompt,
      tools,
      temperature,
      onToolCall: intentOnToolCall,
    },
    userPrompt,
    provider,
  );

  const result = loopResult.result as TaskResult | null;
  if (result?.signals && result.signals.length > 0) {
    result.signals = version.postprocess(result.signals, signalCtx);
  }

  return {
    result,
    model: loopResult.model.model,
    inputTokens: loopResult.usage.inputTokens,
    outputTokens: loopResult.usage.outputTokens,
    steps: loopResult.steps,
  };
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
    rawHtml: message.rawHtml,
    badges: message.badges as string[],
    symbols: message.symbols as string[],
    actionHint: message.actionHint,
    directionHint: message.directionHint,
    detectedStrategies: message.detectedStrategies as TaskContext['detectedStrategies'],
  };

  const signalCtx: SignalContext = {
    cleanText: message.cleanText,
    badges: (message.badges as string[]) ?? [],
    symbols: (message.symbols as string[]) ?? [],
  };

  const userPrompt = buildIntentPrompt(taskContext, recentMessages, traderProfile, quotes);
  const tools = createIntentTools(async (author, limit) => {
    const messages = await getRecentChatMessages(message.timestamp, author, limit);
    return formatChatContext(messages);
  });

  const pipeline = await runIntentPipeline(signalCtx, userPrompt, tools, DEFAULT_VERSION, provider);

  const durationMs = Date.now() - startMs;
  const intentModel = pipeline.model === 'preprocess' ? model : pipeline.model;

  // Persist intent
  const intentRow = {
    id: crypto.randomUUID(),
    messageId: message.id,
    model: intentModel,
    version,
    decision: pipeline.result?.decision ?? 'SKIP',
    reasoning: pipeline.result?.reasoning ?? 'No result from agent',
    signals: pipeline.result?.signals ?? null,
    durationMs,
    inputTokens: pipeline.inputTokens,
    outputTokens: pipeline.outputTokens,
    turns: pipeline.steps.length,
    steps: pipeline.steps.map((s) => ({
      toolName: s.tool,
      toolInput: s.input,
      toolOutput: s.output,
      reasoning: s.reasoning,
      durationMs: s.durationMs,
    })),
    createdAt: new Date().toISOString(),
  };

  await db.insert(schema.messageIntents).values(intentRow).onConflictDoNothing();

  // Re-read from DB to get the proper typed row
  const saved = await getCachedIntent(message.id, intentModel, version);

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
