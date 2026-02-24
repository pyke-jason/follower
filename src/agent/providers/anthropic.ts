import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  ModelIdentity,
  LLMTurnResult,
  ChatParams,
  ChatWithToolsParams,
  ToolResult,
} from '../providers.js';

export class AnthropicProvider implements LLMProvider {
  readonly identity: ModelIdentity;
  private client: Anthropic;

  constructor(identity: ModelIdentity) {
    this.identity = identity;
    this.client = new Anthropic();
  }

  async chat(params: ChatParams): Promise<LLMTurnResult> {
    const response = await this.client.messages.create({
      model: this.identity.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
    });
    return this.parseResponse(response);
  }

  async chatWithTools(params: ChatWithToolsParams): Promise<LLMTurnResult> {
    const tools: Anthropic.Tool[] = params.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      // Mark the last tool so the API caches system + tools prefix
      ...(i === params.tools.length - 1
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    }));

    const response = await this.client.messages.create({
      model: this.identity.model,
      max_tokens: params.maxTokens,
      system: params.system,
      tools,
      messages: params.messages as Anthropic.MessageParam[],
      ...(params.temperature != null ? { temperature: params.temperature } : {}),
    });
    return this.parseResponse(response);
  }

  makeUserMessage(text: string): Anthropic.MessageParam {
    return { role: 'user', content: text };
  }

  formatToolResults(results: ToolResult[]): Anthropic.MessageParam {
    return {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolCallId,
        content: r.output,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  }

  private parseResponse(response: Anthropic.Message): LLMTurnResult {
    const textBlocks: string[] = [];
    const toolCalls: LLMTurnResult['toolCalls'] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textBlocks.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    let stopReason: LLMTurnResult['stopReason'];
    switch (response.stop_reason) {
      case 'tool_use': stopReason = 'tool_use'; break;
      case 'max_tokens': stopReason = 'max_tokens'; break;
      case 'end_turn':
      case 'stop_sequence':
      default: stopReason = 'end_turn'; break;
    }

    return {
      textBlocks,
      toolCalls,
      stopReason,
      rawAssistantMessage: { role: 'assistant', content: response.content },
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? undefined,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  }
}
