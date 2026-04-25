import {
  query,
  tool,
  createSdkMcpServer,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../lib/logger.js';
import type {
  Agent,
  AgentResult,
  AgentRunOptions,
  AgentStep,
  AgentUsage,
  ModelIdentity,
} from './result.js';
import { summarizeToolOutput, summarizeToolInput } from './result.js';
import { estimateLlmCost } from '../lib/llm-cost.js';

const log = createLogger('AnthropicAgent');

const MCP_SERVER_NAME = 'trade-follower';

/**
 * When ANTHROPIC_USE_SUBSCRIPTION=1, the SDK routes through the locally
 * logged-in `claude` CLI (Max plan) instead of the Console API key. Must
 * unset ANTHROPIC_API_KEY at process level so the SDK doesn't pick it up.
 * Idempotent — safe to call from every constructor.
 */
function configureSubscriptionModeIfEnabled(): void {
  if (process.env.ANTHROPIC_USE_SUBSCRIPTION === '1') {
    delete process.env.ANTHROPIC_API_KEY;
  }
}

export class AnthropicAgent implements Agent {
  readonly identity: ModelIdentity;

  constructor(identity: ModelIdentity) {
    this.identity = identity;
    configureSubscriptionModeIfEnabled();
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const steps: AgentStep[] = [];
    let capturedResult: unknown | null = null;
    let usage: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

    const mcpTools = opts.tools.map((def) =>
      tool(
        def.name,
        def.description,
        def.input.shape,
        async (args) => {
          const input = args as Record<string, unknown>;
          const t0 = Date.now();
          const output = await def.execute(input);
          const durationMs = Date.now() - t0;
          const inSummary = summarizeToolInput(def.name, input);
          const callSig = inSummary ? `${def.name}(${inSummary})` : def.name;
          const reasoning = `${callSig} → ${summarizeToolOutput(def.name, output)}`;
          steps.push({ tool: def.name, input, output, reasoning, durationMs });
          log.debug(`  ${reasoning} (${durationMs}ms)`);

          if (opts.onToolCall) {
            const intercepted = opts.onToolCall(def.name, input, output);
            if (intercepted != null) capturedResult = intercepted;
          }

          return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
        },
      ),
    );

    const server = createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: '1.0.0',
      tools: mcpTools,
    });

    const allowedTools = opts.tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`LLM request timed out after ${opts.timeoutMs ?? 120_000}ms`)),
      opts.timeoutMs ?? 120_000,
    );

    const q = query({
      prompt: opts.userPrompt,
      options: {
        model: this.identity.model,
        // Mark the entire caller-provided systemPrompt as the static,
        // cross-session-cacheable prefix. Every trade-classifier call reuses
        // the same NLU prompt, so this turns ~6K input tokens per message
        // into cache reads after the first write.
        systemPrompt: [opts.systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY],
        mcpServers: { [MCP_SERVER_NAME]: server },
        allowedTools,
        tools: [],
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: opts.maxTurns ?? 10,
        abortController: controller,
      },
    });

    try {
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            steps.push({ reasoning: block.text });
          }
        }
      } else if (msg.type === 'result') {
        const u = msg.usage;
        const tokenUsage = {
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
        };
        // Anthropic does not return a cost field — compute from published rates.
        usage = { ...tokenUsage, costUsd: estimateLlmCost(this.identity.model, tokenUsage) };
      }
    }
    } finally {
      clearTimeout(timeoutId);
    }

    return { model: this.identity, steps, result: capturedResult, usage };
  }
}
