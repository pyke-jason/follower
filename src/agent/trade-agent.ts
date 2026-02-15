import type { ToolDef } from './tool-factory.js';
import type { TaskContext, TaskResult } from '../db/schema.js';
import type { LLMProvider } from './providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from './providers.js';
import { AgentDecisionSchema, FlagForReviewInput } from './schemas.js';
import { runAgentLoop } from './agent-loop.js';
import type { AgentStep } from './agent-loop.js';
import type { ModelIdentity, LLMUsage } from './providers.js';

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
2. Identify the strategy type (CDS, PDS, CALL, PUT, STOCK, or unsupported)
3. Extract strikes, expiry, price, quantity from the message
4. If expiry is missing, use get_options_chain to find available expirations
5. If strikes seem wrong, validate against the options chain
6. ALWAYS call calculate_position_size before placing an order
7. ALWAYS call check_risk_limits before placing an order
8. If you can't confidently parse the message, call flag_for_review

## Your Process
1. CLASSIFY: Is this a trade entry, exit, adjustment, or noise?
2. IDENTIFY: What strategy? CDS, PDS, naked call, stock, etc.
3. VALIDATE: Use get_quote / get_options_chain to check current prices.
   If the market has moved significantly since the message, flag for review.
4. SIZE: Use calculate_position_size to determine quantity.
   - For stocks: pass entryPrice
   - For spreads (CDS/PDS): pass entryPrice as net debit, spreadMaxRisk as (width - credit)
   Use the returned quantity for all legs.
5. CHECK RISK: Use check_risk_limits before any execution.
6. DECIDE: Execute, skip (with reason), or flag for human review.

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

export async function runAgent(
  taskContext: TaskContext,
  injectedTools: ToolDef[],
  provider?: LLMProvider,
): Promise<AgentRunResult> {

  if (!provider) {
    provider = await createProvider(DEFAULT_TRADE_MODEL);
  }

  const userPrompt = `Review this trade message and decide what to do.

Message ID: ${taskContext.messageId}
Author: ${taskContext.author}
Text: ${taskContext.cleanText}
Badges: ${JSON.stringify(taskContext.badges)}
Symbols: ${JSON.stringify(taskContext.symbols)}
Action Hint: ${taskContext.actionHint}
Direction Hint: ${taskContext.directionHint}

Use your tools to gather context, validate the trade, and make a decision.`;

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
