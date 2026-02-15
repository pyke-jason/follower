import type { ToolDef } from './tools.js';

// ─── Identity ────────────────────────────────────────

export type ModelProvider = 'anthropic' | 'xai';

export type ModelIdentity = {
  provider: ModelProvider;
  model: string; // e.g. 'claude-sonnet-4-5-20250929', 'grok-3'
};

// ─── Normalized types ────────────────────────────────

export type LLMToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type LLMTurnResult = {
  textBlocks: string[];
  toolCalls: LLMToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  /** Native SDK message — pushed back into conversation history as-is */
  rawAssistantMessage: unknown;
};

export type ToolResult = {
  toolCallId: string;
  output: string;
  isError?: boolean;
};

export type ChatParams = {
  system?: string;
  messages: unknown[]; // provider-native message array
  maxTokens: number;
};

export type ChatWithToolsParams = ChatParams & {
  tools: ToolDef[];
};

// ─── Provider interface ──────────────────────────────

export interface LLMProvider {
  readonly identity: ModelIdentity;

  /** Simple chat completion (no tools). */
  chat(params: ChatParams): Promise<LLMTurnResult>;

  /** Chat with tool definitions. */
  chatWithTools(params: ChatWithToolsParams): Promise<LLMTurnResult>;

  /** Build a user message (the initial prompt). */
  makeUserMessage(text: string): unknown;

  /** Format tool results into the provider's native message format. */
  formatToolResults(results: ToolResult[]): unknown;
}

// ─── Defaults ────────────────────────────────────────

export const DEFAULT_TRADE_MODEL: ModelIdentity = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929',
};

export const DEFAULT_LABEL_MODEL: ModelIdentity = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
};

// ─── Factory ─────────────────────────────────────────

export async function createProvider(identity: ModelIdentity): Promise<LLMProvider> {
  switch (identity.provider) {
    case 'anthropic': {
      const { AnthropicProvider } = await import('./providers/anthropic.js');
      return new AnthropicProvider(identity);
    }
    case 'xai': {
      const { XAIProvider } = await import('./providers/xai.js');
      return new XAIProvider(identity);
    }
    default:
      throw new Error(`Unknown provider: ${(identity as any).provider}`);
  }
}
