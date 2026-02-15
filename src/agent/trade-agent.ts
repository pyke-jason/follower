import { tools as defaultTools } from './tools.js';
import type { ToolDef } from './tools.js';
import type { TaskContext, TaskResult } from '../db/schema.js';
import type { LLMProvider, ModelIdentity } from './providers.js';
import { createProvider, DEFAULT_TRADE_MODEL } from './providers.js';
import { AgentDecisionSchema, FlagForReviewInput } from './schemas.js';

const SYSTEM_PROMPT = `You are a trade-copy agent monitoring a live trading chat room.

You review incoming messages from tracked traders and decide whether to mirror
their trades. You have tools for market data, position management, and execution.

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

export type AgentStep = {
  tool?: string;
  input?: unknown;
  output?: unknown;
  reasoning?: string;
  durationMs?: number;
};

export type AgentRunResult = {
  steps: AgentStep[];
  result: TaskResult | null;
  model: ModelIdentity;
};

export async function runAgent(
  taskContext: TaskContext,
  injectedTools?: ToolDef[],
  provider?: LLMProvider,
): Promise<AgentRunResult> {

  // Lazily create default provider if not supplied
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
Detected Strategies: ${JSON.stringify(taskContext.detectedStrategies)}
Regex Confidence: ${taskContext.confidence ?? 'N/A'}

Use your tools to gather context, validate the trade, and make a decision.`;

  const activeTools = injectedTools ?? defaultTools;

  const steps: AgentStep[] = [];
  let result: TaskResult | null = null;

  // Messages array holds provider-native message objects
  const messages: unknown[] = [provider.makeUserMessage(userPrompt)];

  // Agentic loop: keep going while the model wants to use tools
  for (let turn = 0; turn < 10; turn++) {
    const startTime = Date.now();

    const response = await provider.chatWithTools({
      system: SYSTEM_PROMPT,
      messages,
      maxTokens: 2048,
      tools: activeTools,
    });

    const durationMs = Date.now() - startTime;

    // Process text blocks — try to parse JSON result
    for (const text of response.textBlocks) {
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        try {
          const raw = JSON.parse(jsonMatch[1]);
          const parsed = AgentDecisionSchema.safeParse(raw);
          if (parsed.success) result = parsed.data as TaskResult;
        } catch { /* not valid JSON, that's ok */ }
      } else {
        try {
          const raw = JSON.parse(text);
          const parsed = AgentDecisionSchema.safeParse(raw);
          if (parsed.success) result = parsed.data as TaskResult;
        } catch { /* intermediate reasoning */ }
      }
      steps.push({ reasoning: text, durationMs });
    }

    // If no tool use, we're done
    if (response.toolCalls.length === 0 || response.stopReason === 'end_turn') {
      break;
    }

    // Push the raw assistant message into conversation history
    messages.push(response.rawAssistantMessage);

    // Execute tool calls and build results
    const toolResults: Array<{ toolCallId: string; output: string; isError?: boolean }> = [];

    for (const toolCall of response.toolCalls) {
      const toolDef = activeTools.find((t) => t.name === toolCall.name);
      if (!toolDef) {
        toolResults.push({
          toolCallId: toolCall.id,
          output: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }),
        });
        steps.push({ tool: toolCall.name, input: toolCall.input, output: { error: 'unknown tool' } });
        continue;
      }

      const toolStart = Date.now();
      try {
        const output = await toolDef.execute(toolCall.input);
        const toolDuration = Date.now() - toolStart;

        steps.push({ tool: toolCall.name, input: toolCall.input, output, durationMs: toolDuration });
        toolResults.push({ toolCallId: toolCall.id, output: JSON.stringify(output) });

        // If flag_for_review was called, capture as MANUAL_REVIEW
        if (toolCall.name === 'flag_for_review') {
          const flagParsed = FlagForReviewInput.safeParse(toolCall.input);
          result = {
            decision: 'MANUAL_REVIEW',
            reasoning: flagParsed.success ? flagParsed.data.reason : 'Flagged by agent',
          };
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const toolDuration = Date.now() - toolStart;

        steps.push({ tool: toolCall.name, input: toolCall.input, output: { error: errMsg }, durationMs: toolDuration });
        toolResults.push({ toolCallId: toolCall.id, output: JSON.stringify({ error: errMsg }), isError: true });
      }
    }

    // Push tool results in provider-native format
    const formattedResults = provider.formatToolResults(toolResults);
    // OpenAI returns an array of messages (one per tool result), Anthropic returns one message
    if (Array.isArray(formattedResults)) {
      messages.push(...formattedResults);
    } else {
      messages.push(formattedResults);
    }
  }

  return { steps, result, model: provider.identity };
}
