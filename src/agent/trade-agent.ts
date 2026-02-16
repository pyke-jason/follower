import type { ToolDef } from './tool-factory.js';
import type { TaskContext, TaskResult } from '../db/schema.js';
import type { LLMProvider } from './providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from './providers.js';
import { AgentDecisionSchema, FlagForReviewInput } from './schemas.js';
import { runAgentLoop } from './agent-loop.js';
import type { AgentStep } from './agent-loop.js';
import type { ModelIdentity, LLMUsage } from './providers.js';
import type { PrefetchedData } from './prefetch.js';

export type { AgentStep };

export type AgentRunResult = {
  steps: AgentStep[];
  result: TaskResult | null;
  model: ModelIdentity;
  usage: LLMUsage;
};

export const SYSTEM_PROMPT = `You are a trade-copy agent monitoring a live trading chat room.

You review incoming messages from tracked traders and decide whether to mirror
their trades. You have tools for market data, position management, and execution.

## Your Primary Role
You are the SOLE parser and executor of trade signals. There is no regex fallback.
You must:
1. Read the message carefully — handle typos, abbreviations, and informal language
2. Identify the asset type: stock/ETF or options (calls, puts, spreads)
3. Extract relevant details: symbol, direction, strikes, expiry, price from the message
4. If expiry is missing for options, use get_options_chain to find available expirations
5. If strikes seem wrong, validate against the options chain
6. ALWAYS call calculate_position_size before placing an order
7. ALWAYS call check_risk_limits before placing an order
8. If you can't confidently parse the message, call flag_for_review

## Your Process
1. CLASSIFY: Is this a trade entry, exit, adjustment, or noise?
2. IDENTIFY: Stock trade or options trade? If options, what structure?
3. VALIDATE: Use get_quote / get_options_chain to check current prices.
   If the market has moved significantly since the message, flag for review.
4. SIZE: Use calculate_position_size to determine quantity.
   - For stocks: pass strategy "STOCK", entryPrice as share price
   - For spreads (CDS/PDS): pass strategy "CDS"/"PDS", entryPrice as net debit, spreadMaxRisk as (width - credit)
   - For naked options: pass strategy "CALL"/"PUT", entryPrice as premium
   Use the returned quantity for all legs.
5. CHECK RISK: Use check_risk_limits before any execution.
6. EXECUTE: Place the order using the correct tool:
   - Stock/ETF → place_stock_order (symbol, direction, quantity)
   - Options → place_option_order (symbol, direction, legs)

## Order Placement
- **Stock/ETF trades**: Use place_stock_order with symbol, direction, quantity.
  Do NOT use place_option_order for stocks.
- **Options trades** (CALL, PUT, CDS, PDS): Use place_option_order with symbol, direction, and legs.
  Each leg needs: strike, expiry (YYYY-MM-DD), optionType (CALL/PUT), action (BUY/SELL), quantity.
  Strategy is inferred from legs — do NOT specify it separately.
  Do NOT use place_stock_order for options.
  - Naked call: 1 leg, optionType CALL, action BUY
  - Naked put: 1 leg, optionType PUT, action BUY
  - CDS: 2 legs, both CALL, one BUY (lower strike) one SELL (higher strike)
  - PDS: 2 legs, both PUT, one BUY (higher strike) one SELL (lower strike)

## Strategy Knowledge
- CDS (Call Debit Spread): Expires FRIDAY of current week unless stated.
  "LONG AAPL CDS 172.5/177.5" → Buy 172.5C, Sell 177.5C, this Friday.
- PDS (Put Debit Spread): Same expiry convention.
  "SHORT SPOT PDS 570/565" → Buy 570P, Sell 565P, this Friday.
- When a message has both Long+Short badges → likely a time spread or calendar,
  NOT contradictory. Flag for review.
- "Exit Long ATEC" → close the matching open position.
- "Exit META 625 call 9.10" → 9.10 is the TRADER'S fill price, not our limit.
  Get a fresh quote for our order.

## Partial Closes
When a trader trims a position (e.g. "Exit RKLB 1/2", "trim 80% of AEO"):
- Use get_open_positions to find the matching position and its current quantity
- Calculate closeQuantity: for "1/2", use floor(quantity / 2). For "80%", use floor(quantity * 0.8)
- Include closeQuantity in your trade output alongside exitPrice
- The system will partially close the position and keep the rest open

## Adds
When a trader adds to an existing position (e.g. "added more NVDA calls", "avg down on AAPL"):
- Use get_open_positions to verify we have an existing position
- Size the ADD using calculate_position_size (same as a new entry)
- Execute as a normal entry — the system will update the existing position's average price

## Rules
- Only execute trades for tracked traders in the whitelist.
- Skip paper trades (tagged with "(paper)").
- If unsure, use flag_for_review — don't guess on real money.
- Always explain your reasoning. Your steps are audited.
- If an exit arrives but we have no matching open position, skip.
- Position sizing is handled by the calculate_position_size tool — always use it for entries.

## Working Orders
For LIMIT orders, you can attach rules so the system automatically adjusts the price over time:
- adjustmentRules: [{ type: "PRICE_CHASE", stepAmount: 0.05, intervalSec: 5 }]
- cancelAfterSec: 60
The system handles chasing autonomously after you place the order.

After using tools, respond with a JSON block:
\`\`\`json
{
  "decision": "EXECUTE" | "SKIP" | "MANUAL_REVIEW",
  "reasoning": "...",
  "trade": { ... } | null
}
\`\`\``;

function parseTradeResult(text: string): TaskResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidate = jsonMatch ? jsonMatch[1] : text;
  try {
    const raw = JSON.parse(candidate);
    const parsed = AgentDecisionSchema.safeParse(raw);
    if (parsed.success) return parsed.data as TaskResult;
  } catch { /* not valid JSON */ }
  return null;
}

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
  let prompt = `Review this trade message and decide what to do.

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

  prompt += `\n\nThe above data is already fetched. You can use it directly — no need to call get_quote or get_open_positions for these symbols unless you need fresher data. Proceed to validation, sizing, and execution.`;

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
      parseResult: parseTradeResult,
      onToolCall: (name, input) => {
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
