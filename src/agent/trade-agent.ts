import Anthropic from '@anthropic-ai/sdk';
import { tools as defaultTools } from './tools.js';
import type { ToolDef } from './tools.js';
import type { TaskContext, TaskResult } from '../db/schema.js';

const SYSTEM_PROMPT = `You are a trade-copy agent monitoring a live trading chat room.

You review incoming messages from tracked traders and decide whether to mirror
their trades. You have tools for market data, position management, and execution.

## Your Process
1. CLASSIFY: Is this a trade entry, exit, adjustment, or noise?
2. IDENTIFY: What strategy? CDS, PDS, naked call, stock, etc.
3. VALIDATE: Use get_quote / get_options_chain to check current prices.
   If the market has moved significantly since the message, flag for review.
4. CHECK RISK: Use check_risk_limits before any execution.
5. DECIDE: Execute, skip (with reason), or flag for human review.

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
- Respect max allocation per trader and daily loss limits.

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

const client = new Anthropic();

export type AgentStep = {
  tool?: string;
  input?: unknown;
  output?: unknown;
  reasoning?: string;
  durationMs?: number;
};

export async function runAgent(
  taskContext: TaskContext,
  injectedTools?: ToolDef[],
): Promise<{ steps: AgentStep[]; result: TaskResult | null }> {

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

  const anthropicTools: Anthropic.Tool[] = activeTools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));

  const steps: AgentStep[] = [];
  let result: TaskResult | null = null;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  // Agentic loop: keep going while the model wants to use tools
  for (let turn = 0; turn < 10; turn++) {
    const startTime = Date.now();

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: anthropicTools,
      messages,
    });

    const durationMs = Date.now() - startTime;

    // Process response blocks
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        // Try to parse the final JSON result
        const jsonMatch = block.text.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          try {
            result = JSON.parse(jsonMatch[1]);
          } catch { /* not valid JSON, that's ok */ }
        } else {
          // Try parsing the whole text as JSON
          try {
            const parsed = JSON.parse(block.text);
            if (parsed.decision) result = parsed;
          } catch { /* intermediate reasoning */ }
        }
        steps.push({ reasoning: block.text, durationMs });
      }

      if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      }
    }

    // If no tool use, we're done
    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      break;
    }

    // Execute tool calls and build tool results
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const toolDef = activeTools.find(t => t.name === toolUse.name);
      if (!toolDef) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: `Unknown tool: ${toolUse.name}` }),
        });
        steps.push({ tool: toolUse.name, input: toolUse.input, output: { error: 'unknown tool' } });
        continue;
      }

      const toolStart = Date.now();
      try {
        const output = await toolDef.execute(toolUse.input as Record<string, unknown>);
        const toolDuration = Date.now() - toolStart;

        steps.push({
          tool: toolUse.name,
          input: toolUse.input,
          output,
          durationMs: toolDuration,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(output),
        });

        // If flag_for_review was called, capture as MANUAL_REVIEW
        if (toolUse.name === 'flag_for_review') {
          result = {
            decision: 'MANUAL_REVIEW',
            reasoning: (toolUse.input as any).reason ?? 'Flagged by agent',
          };
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const toolDuration = Date.now() - toolStart;

        steps.push({
          tool: toolUse.name,
          input: toolUse.input,
          output: { error: errMsg },
          durationMs: toolDuration,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ error: errMsg }),
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { steps, result };
}
