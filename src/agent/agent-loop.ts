import type { ToolDef } from './tool-factory.js';
import type { LLMProvider, ModelIdentity, LLMUsage } from './providers.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Agent');

export type AgentStep = {
  tool?: string;
  input?: unknown;
  output?: unknown;
  reasoning?: string;
  durationMs?: number;
};

export type AgentRunResult = {
  steps: AgentStep[];
  result: unknown | null;
  model: ModelIdentity;
  usage: LLMUsage;
};

export type AgentConfig = {
  systemPrompt: string;
  tools: ToolDef[];
  /** Intercept tool calls to capture results (e.g. submit_decision, flag_for_review). Return non-null to set result. */
  onToolCall?: (name: string, input: Record<string, unknown>, output: unknown) => unknown | null;
  maxTurns?: number;  // default 10
  maxTokens?: number; // default 2048
};

/** Produce a short one-line summary of a tool's output for logging. */
function summarizeToolOutput(toolName: string, output: unknown): string {
  if (output == null) return '(null)';
  if (typeof output === 'object' && 'error' in (output as Record<string, unknown>)) {
    return `ERROR: ${(output as Record<string, unknown>).error}`;
  }
  try {
    const json = JSON.stringify(output);
    if (json.length <= 120) return json;
    const obj = output as Record<string, unknown>;
    if (toolName === 'get_open_positions' && Array.isArray(output)) {
      return `${output.length} position(s)`;
    }
    if (toolName === 'get_quote' && obj.bid != null) {
      return `bid=${obj.bid} ask=${obj.ask}`;
    }
    return json.slice(0, 100) + '…';
  } catch {
    return String(output).slice(0, 100);
  }
}

/**
 * Generic agentic loop: send messages, execute tools, repeat until done.
 * The caller builds the initial user prompt and passes it as `userPrompt`.
 */
export async function runAgentLoop(
  config: AgentConfig,
  userPrompt: string,
  provider: LLMProvider,
): Promise<AgentRunResult> {
  const {
    systemPrompt, tools, onToolCall,
    maxTurns = parseInt(process.env.AGENT_MAX_TURNS ?? '10', 10),
    maxTokens = parseInt(process.env.AGENT_MAX_TOKENS ?? '2048', 10),
  } = config;

  const steps: AgentStep[] = [];
  let result: unknown | null = null;
  let toolCallIndex = 0;
  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

  const messages: unknown[] = [provider.makeUserMessage(userPrompt)];

  for (let turn = 0; turn < maxTurns; turn++) {
    const startTime = Date.now();

    const response = await provider.chatWithTools({
      system: systemPrompt,
      messages,
      maxTokens,
      tools,
    });

    const durationMs = Date.now() - startTime;

    // Accumulate token usage
    if (response.usage) {
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.cacheCreationInputTokens = (usage.cacheCreationInputTokens ?? 0) + (response.usage.cacheCreationInputTokens ?? 0);
      usage.cacheReadInputTokens = (usage.cacheReadInputTokens ?? 0) + (response.usage.cacheReadInputTokens ?? 0);
    }

    // Record text blocks as reasoning steps
    for (const text of response.textBlocks) {
      steps.push({ reasoning: text, durationMs });
    }

    // If no tool calls, we're done. Don't check stopReason here — if the model
    // returns tool calls with end_turn (text + tool_use in one response), we must
    // still execute those tool calls before breaking.
    if (response.toolCalls.length === 0) {
      break;
    }

    // Push the raw assistant message into conversation history
    messages.push(response.rawAssistantMessage);

    // Execute tool calls and build results
    const toolResults: Array<{ toolCallId: string; output: string; isError?: boolean }> = [];

    for (const toolCall of response.toolCalls) {
      toolCallIndex++;
      const toolDef = tools.find((t) => t.name === toolCall.name);
      if (!toolDef) {
        const reasoning = `${toolCall.name} → ERROR: unknown tool`;
        toolResults.push({
          toolCallId: toolCall.id,
          output: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }),
        });
        steps.push({ tool: toolCall.name, input: toolCall.input, output: { error: 'unknown tool' }, reasoning });
        log.debug(`  turn ${toolCallIndex}: ${reasoning}`);
        continue;
      }

      const toolStart = Date.now();
      try {
        const output = await toolDef.execute(toolCall.input);
        const toolDuration = Date.now() - toolStart;
        const reasoning = `${toolCall.name} → ${summarizeToolOutput(toolCall.name, output)}`;

        steps.push({ tool: toolCall.name, input: toolCall.input, output, reasoning, durationMs: toolDuration });
        toolResults.push({ toolCallId: toolCall.id, output: JSON.stringify(output) });
        log.debug(`  turn ${toolCallIndex}: ${reasoning} (${toolDuration}ms)`);

        // Let caller intercept tool calls for result extraction
        if (onToolCall) {
          const intercepted = onToolCall(toolCall.name, toolCall.input, output);
          if (intercepted != null) result = intercepted;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const toolDuration = Date.now() - toolStart;
        const reasoning = `${toolCall.name} → ERROR: ${errMsg}`;

        steps.push({ tool: toolCall.name, input: toolCall.input, output: { error: errMsg }, reasoning, durationMs: toolDuration });
        toolResults.push({ toolCallId: toolCall.id, output: JSON.stringify({ error: errMsg }), isError: true });
        log.debug(`  turn ${toolCallIndex}: ${reasoning} (${toolDuration}ms)`);
      }
    }

    // If we got a terminal result (submit_decision / flag_for_review), stop — no need
    // for another round-trip just to get an end_turn text block.
    if (result != null) break;

    // Push tool results in provider-native format
    const formattedResults = provider.formatToolResults(toolResults);
    if (Array.isArray(formattedResults)) {
      messages.push(...formattedResults);
    } else {
      messages.push(formattedResults);
    }
  }

  return { steps, result, model: provider.identity, usage };
}
