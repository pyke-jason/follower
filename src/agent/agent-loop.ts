import type { ToolDef } from './tool-factory.js';
import type { LLMProvider, ModelIdentity, LLMUsage } from './providers.js';

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
  /** Parse text blocks to extract a structured result. Return non-null to set result. */
  parseResult?: (text: string) => unknown | null;
  /** Intercept tool calls to capture results (e.g. submit_label, flag_for_review). Return non-null to set result. */
  onToolCall?: (name: string, input: Record<string, unknown>, output: unknown) => unknown | null;
  maxTurns?: number;  // default 10
  maxTokens?: number; // default 2048
};

/**
 * Generic agentic loop: send messages, execute tools, repeat until done.
 * The caller builds the initial user prompt and passes it as `userPrompt`.
 */
export async function runAgentLoop(
  config: AgentConfig,
  userPrompt: string,
  provider: LLMProvider,
): Promise<AgentRunResult> {
  const { systemPrompt, tools, parseResult, onToolCall, maxTurns = 10, maxTokens = 2048 } = config;

  const steps: AgentStep[] = [];
  let result: unknown | null = null;
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

    // Process text blocks
    for (const text of response.textBlocks) {
      if (parseResult) {
        const parsed = parseResult(text);
        if (parsed != null) result = parsed;
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
      const toolDef = tools.find((t) => t.name === toolCall.name);
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

        // Let caller intercept tool calls for result extraction
        if (onToolCall) {
          const intercepted = onToolCall(toolCall.name, toolCall.input, output);
          if (intercepted != null) result = intercepted;
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
    if (Array.isArray(formattedResults)) {
      messages.push(...formattedResults);
    } else {
      messages.push(formattedResults);
    }
  }

  return { steps, result, model: provider.identity, usage };
}
