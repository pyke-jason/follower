import type { ToolDef } from './tool-factory.js';
import type { TaskContext } from '../db/schema.js';
import type { TaskResult } from './schemas.js';
import type { LLMProvider } from './providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from './providers.js';
import { FlagForReviewInput, SubmitDecisionInput } from './schemas.js';
import { runAgentLoop } from './agent-loop.js';
import type { AgentStep } from './agent-loop.js';
import type { ModelIdentity, LLMUsage } from './providers.js';
import type { PrefetchedData } from './prefetch.js';
import { formatTimestampForLLM } from '../lib/et-date.js';
import { createLogger } from '../lib/logger.js';
import {
  STRATEGY_KNOWLEDGE,
  DIRECTION_RULES,
  STRIKE_INFERENCE,
  SIGNAL_ACTIONS,
  FLAG_CRITERIA,
  SLANG_GUIDE,
  GENERAL_RULES,
} from './classification-knowledge.js';

const log = createLogger('SignalClassifier');

export type { AgentStep };

export type AgentRunResult = {
  steps: AgentStep[];
  result: TaskResult | null;
  model: ModelIdentity;
  usage: LLMUsage;
};

export const SYSTEM_PROMPT = `You are a trade signal classifier monitoring a live trading chat room.

You review incoming messages from tracked traders and extract structured trade signals.
Position sizing, risk management, and order execution are handled deterministically by the
system — you cannot and should not attempt to control them.

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
4. OUTPUT: Return your classification as a JSON block with signals.

Do NOT include quantity — the system calculates position size.
Do NOT attempt to place orders — you have no execution tools.

## Compound Messages
Messages may contain multiple trade signals (e.g. "Exit TXN, Short TSLA").
Return ALL signals in the \`signals\` array. Each signal is processed independently
by the execution pipeline.

## Strategy Knowledge
${STRATEGY_KNOWLEDGE}

## Direction Rules
${DIRECTION_RULES}

## Inferring Missing Strikes
${STRIKE_INFERENCE}

## Signal Actions
${SIGNAL_ACTIONS}

## Slang
${SLANG_GUIDE}

## Flag Criteria
${FLAG_CRITERIA}

## Rules
${GENERAL_RULES}
- If an exit arrives but we have no matching open position (check with get_open_positions), skip.

After using tools, call **submit_decision** with your classification. For EXECUTE, include a signals array. For SKIP or MANUAL_REVIEW, omit signals.

**IMPORTANT**: For options trades (CALL, PUT, CDS, PDS) with action OPEN or ADD, the \`legs\` array is REQUIRED. Each leg must include \`strike\`, \`expiry\`, \`optionType\`, and \`action\`. Without legs, the signal will be rejected by the execution pipeline. For CLOSE and TRIM, do NOT include \`legs\` — the system uses the existing position's legs automatically.`;


/**
 * Build the user prompt for the trade agent.
 * When prefetched data is available, appends it to the prompt so the agent
 * can skip get_quote and get_open_positions calls for those symbols.
 *
 * NOTE: The system prompt step 3 says "Use get_quote / get_options_chain".
 * The agent may still re-fetch despite having the data — this is expected
 * and harmless (wasteful, not wrong). The instruction is deliberately soft.
 */
export function buildUserPrompt(
  context: TaskContext,
  prefetched?: PrefetchedData,
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

  // Show detected strategies (already in TaskContext but not previously shown)
  if (context.detectedStrategies && context.detectedStrategies.length > 0) {
    prompt += `\nDetected Strategies: ${JSON.stringify(context.detectedStrategies)}`;
  }

  if (!prefetched) {
    prompt += `\n\nUse your tools to gather context, validate the trade, and make a decision.`;
    return prompt;
  }

  prompt += `\n\n--- Pre-fetched Context ---`;

  // Trader profile
  if (prefetched.traderProfile) {
    const tp = prefetched.traderProfile;
    prompt += `\n\nTrader Profile:`;
    if (tp.strategies.length > 0) {
      prompt += `\n  Known strategies: ${tp.strategies.join(', ')}`;
    }
    if (tp.notes) {
      prompt += `\n  Notes: ${tp.notes}`;
    }
  }

  // Quotes
  const quoteEntries = Object.entries(prefetched.quotes);
  if (quoteEntries.length > 0) {
    prompt += `\n\nQuotes:`;
    for (const [sym, q] of quoteEntries) {
      if ('error' in q) {
        prompt += `\n  ${sym}: unavailable (${q.error})`;
      } else {
        prompt += `\n  ${sym}: bid=${q.bid} ask=${q.ask} last=${q.last}`;
      }
    }
  }

  // Open positions
  const pos = prefetched.positions;
  if (!pos.failed) {
    prompt += `\n\nOpen Positions for ${context.author}:`;
    if (pos.forSymbol.length > 0) {
      for (const t of pos.forSymbol) {
        prompt += `\n  ${t.direction} ${t.strategy} ${t.symbol} qty=${t.quantity} @$${t.entryPrice} [${t.id.slice(0, 8)}]`;
      }
    } else {
      prompt += `\n  No open positions on ${(context.symbols ?? []).join(', ') || 'these symbols'}`;
    }
    prompt += `\n  Total open positions for ${context.author}: ${pos.totalCount}`;
  }

  prompt += `\n\nThe above data is already fetched. You can use it directly — no need to call get_quote or get_open_positions for these symbols unless you need fresher data. Proceed to classify the signal.`;

  return prompt;
}

export async function runAgent(
  taskContext: TaskContext,
  injectedTools: ToolDef[],
  provider?: LLMProvider,
  prefetched?: PrefetchedData,
): Promise<AgentRunResult> {

  if (!provider) {
    provider = await createProvider(DEFAULT_TRADE_MODEL);
  }

  const userPrompt = buildUserPrompt(taskContext, prefetched);
  const activeTools = injectedTools;

  const loopResult = await runAgentLoop(
    {
      systemPrompt: SYSTEM_PROMPT,
      tools: activeTools,
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

  return {
    steps: loopResult.steps,
    result: loopResult.result as TaskResult | null,
    model: loopResult.model,
    usage: loopResult.usage,
  };
}
