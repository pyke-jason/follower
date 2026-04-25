import type { ToolDef } from './tool-factory.js';

export type ModelProvider = 'anthropic' | 'xai';

export type ModelIdentity = {
  provider: ModelProvider;
  model: string;
};

export type AgentStep = {
  tool?: string;
  input?: unknown;
  output?: unknown;
  reasoning?: string;
  durationMs?: number;
};

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /**
   * Actual (xAI) or computed (Anthropic) cost in USD for this agent run.
   * Summed across all steps. Undefined when the adapter has no pricing
   * info for the model (caller falls back to token-based estimation).
   */
  costUsd?: number;
};

export type AgentResult = {
  model: ModelIdentity;
  steps: AgentStep[];
  result: unknown | null;
  usage: AgentUsage;
};

export type AgentRunOptions = {
  systemPrompt: string;
  userPrompt: string;
  tools: ToolDef[];
  /** Intercept tool calls to capture results (e.g. submit_decision, flag_for_review). Return non-null to set result. */
  onToolCall?: (name: string, input: Record<string, unknown>, output: unknown) => unknown | null;
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  /** Hard deadline for the entire agent run in ms. Defaults to 120 000 ms (2 min). */
  timeoutMs?: number;
};

export interface Agent {
  readonly identity: ModelIdentity;
  run(opts: AgentRunOptions): Promise<AgentResult>;
}

export function summarizeToolOutput(toolName: string, output: unknown): string {
  if (output == null) return '(null)';
  if (typeof output === 'object' && 'error' in (output as Record<string, unknown>)) {
    return `ERROR: ${(output as Record<string, unknown>).error}`;
  }
  const json = JSON.stringify(output);
  if (json.length <= 120) return json;
  if (toolName === 'get_open_positions' && Array.isArray(output)) {
    return `${output.length} position(s)`;
  }
  const obj = output as Record<string, unknown>;
  if (toolName === 'get_quote' && obj.bid != null) {
    return `bid=${obj.bid} ask=${obj.ask}`;
  }
  return json.slice(0, 100) + '…';
}

/**
 * Summarize the *input* args passed to a tool. The output of submit_decision /
 * flag_for_review is just `{accepted: true}` / `{flagged: true}`, which hides
 * the actual classification. This pulls the load-bearing fields out of the
 * input so logs show what the LLM actually decided.
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  if (toolName === 'submit_decision') {
    const decision = String(obj.decision ?? '?');
    const signals = Array.isArray(obj.signals) ? obj.signals : [];
    const sigs = signals
      .map((s) => {
        if (!s || typeof s !== 'object') return '?';
        const sg = s as Record<string, unknown>;
        const parts = [sg.action, sg.strategy, sg.symbol].filter(Boolean).join(' ');
        const dir = sg.direction ? ` ${sg.direction}` : '';
        const strikes = Array.isArray(sg.strikes) && sg.strikes.length ? ` ${(sg.strikes as number[]).join('/')}` : '';
        const expiry = sg.expiry ? ` exp=${sg.expiry}` : '';
        return `${parts}${dir}${strikes}${expiry}`;
      })
      .join(' | ');
    return sigs ? `${decision}: ${sigs}` : decision;
  }

  if (toolName === 'flag_for_review') {
    const reason = String(obj.reason ?? '');
    return reason.length > 80 ? reason.slice(0, 77) + '…' : reason;
  }

  if (toolName === 'get_recent_chat') {
    const author = obj.author ? `author=${obj.author} ` : '';
    const limit = obj.limit ? `limit=${obj.limit}` : '';
    return `${author}${limit}`.trim();
  }

  return '';
}
