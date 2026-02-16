import OpenAI from 'openai';
import type {
  LLMProvider,
  ModelIdentity,
  LLMTurnResult,
  ChatParams,
  ChatWithToolsParams,
  ToolResult,
} from '../providers.js';
import type { ToolDef } from '../tool-factory.js';
import { withRetry, LLM_DEFAULTS, oaiClassify } from '../../lib/resilient.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('XAI');

type OAIMessage = OpenAI.ChatCompletionMessageParam;
type OAITool = OpenAI.ChatCompletionTool;

export class XAIProvider implements LLMProvider {
  readonly identity: ModelIdentity;
  private client: OpenAI;

  constructor(identity: ModelIdentity) {
    this.identity = identity;

    if (!process.env.XAI_API_KEY) {
      throw new Error('XAI_API_KEY is not set');
    }

    this.client = new OpenAI({
      apiKey: process.env.XAI_API_KEY,
      baseURL: 'https://api.x.ai/v1',
      timeout: 60_000,
      maxRetries: 0,
    });
  }

  async chat(params: ChatParams): Promise<LLMTurnResult> {
    const messages = this.buildMessages(params.system, params.messages as OAIMessage[]);
    return withRetry(
      async (signal) => {
        const response = await this.client.chat.completions.create(
          {
            model: this.identity.model,
            max_tokens: params.maxTokens,
            messages,
          },
          { signal },
        );
        return this.parseResponse(response);
      },
      { ...LLM_DEFAULTS, classify: oaiClassify },
      `xai:chat(${this.identity.model})`,
    );
  }

  async chatWithTools(params: ChatWithToolsParams): Promise<LLMTurnResult> {
    const messages = this.buildMessages(params.system, params.messages as OAIMessage[]);
    const tools = this.convertTools(params.tools);

    return withRetry(
      async (signal) => {
        const response = await this.client.chat.completions.create(
          {
            model: this.identity.model,
            max_tokens: params.maxTokens,
            messages,
            tools,
          },
          { signal },
        );
        return this.parseResponse(response);
      },
      { ...LLM_DEFAULTS, classify: oaiClassify },
      `xai:chatWithTools(${this.identity.model})`,
    );
  }

  makeUserMessage(text: string): OAIMessage {
    return { role: 'user', content: text };
  }

  formatToolResults(results: ToolResult[]): OAIMessage[] {
    return results.map((r) => ({
      role: 'tool' as const,
      tool_call_id: r.toolCallId,
      content: r.output,
    }));
  }

  private buildMessages(system: string | undefined, conversationMessages: OAIMessage[]): OAIMessage[] {
    const messages: OAIMessage[] = [];
    if (system) {
      messages.push({ role: 'system', content: system });
    }
    messages.push(...conversationMessages);
    return messages;
  }

  private convertTools(tools: ToolDef[]): OAITool[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  private parseResponse(response: OpenAI.ChatCompletion): LLMTurnResult {
    const choice = response.choices[0];
    if (!choice) {
      return { textBlocks: [], toolCalls: [], stopReason: 'end_turn', rawAssistantMessage: null };
    }

    const msg = choice.message;
    const textBlocks: string[] = [];
    if (msg.content) {
      textBlocks.push(msg.content);
    }

    const toolCalls: LLMTurnResult['toolCalls'] = [];
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function') continue;
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch (err) {
          log.warn(
            `Failed to parse tool call arguments for ${tc.function.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
          input = { __raw: tc.function.arguments };
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }

    let stopReason: LLMTurnResult['stopReason'] = 'end_turn';
    if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
    else if (choice.finish_reason === 'length') stopReason = 'max_tokens';

    return {
      textBlocks,
      toolCalls,
      stopReason,
      rawAssistantMessage: msg,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        cacheReadInputTokens:
          response.usage.prompt_tokens_details?.cached_tokens ?? 0,
      } : undefined,
    };
  }
}
