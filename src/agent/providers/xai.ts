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
import { randomUUID } from 'node:crypto';
import { withRetry, LLM_DEFAULTS, oaiClassify } from '@/lib/resilient.js';
import { createLogger } from '@/lib/logger.js';

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
            ...(params.temperature != null ? { temperature: params.temperature } : {}),
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
            ...(params.temperature != null ? { temperature: params.temperature } : {}),
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

    // Recover tool calls when model emits them as text instead of structured calls.
    // Known Grok behavior: outputs "submit_decision(EXECUTE): action CLOSE, symbol MSFT"
    // as plain text instead of invoking the tool.
    if (toolCalls.length === 0 && msg.content) {
      const recovered = recoverToolCallsFromText(msg.content);
      if (recovered.length > 0) {
        toolCalls.push(...recovered);
        stopReason = 'tool_use';

        // Inject recovered calls into the raw message so the agent loop can
        // append it to conversation history without violating OpenAI's
        // constraint that `tool` messages must follow an `assistant` message
        // containing the matching `tool_calls` array.
        msg.tool_calls = recovered.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }));
      }
    }

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

// ─── Text-to-tool-call recovery ──────────────────────────────────────
//
// Some OpenAI-compatible models (notably Grok) stochastically "describe" tool
// calls in text instead of emitting structured tool_calls. The model reasons
// correctly but the signal is lost because the agent loop sees zero tool calls.
//
// These helpers parse the text patterns the model emits and synthesize proper
// tool calls so the agent loop can process them normally.

const SUBMIT_RE = /submit_decision\s*\(\s*(EXECUTE|SKIP|MANUAL_REVIEW)\s*\)(?:\s*:?\s*([\s\S]*))?/i;
const FLAG_RE = /flag_for_review\s*[\(:](.+)/i;

function recoverToolCallsFromText(text: string): LLMTurnResult['toolCalls'] {
  const submitMatch = text.match(SUBMIT_RE);
  if (submitMatch) {
    const decision = submitMatch[1].toUpperCase();
    const detailText = (submitMatch[2] ?? '').trim();
    const reasoning = extractReasoning(text);

    if (decision === 'SKIP' || decision === 'MANUAL_REVIEW') {
      log.warn(`Recovered text-as-tool-call: submit_decision(${decision})`);
      return [{ id: `recovered-${randomUUID()}`, name: 'submit_decision', input: { decision, reasoning } }];
    }

    if (decision === 'EXECUTE' && detailText) {
      // Strip array brackets if the model formatted signals as a list
      const cleanDetail = detailText.replace(/^\[\s*/, '').replace(/\s*\]$/, '');

      // Split into individual signal blocks using "action" as the delimiter
      const signalTexts = cleanDetail
        .split(/(?=action\s+(?:OPEN|CLOSE|TRIM|LEG_OFF|ADD))/i)
        .map(s => s.trim().replace(/,+$/, ''))
        .filter(Boolean);

      const signals = signalTexts
        .map(parseSignalText)
        .filter((s): s is Record<string, unknown> => s !== null);

      if (signals.length > 0) {
        log.warn(`Recovered text-as-tool-call: submit_decision(EXECUTE) with ${signals.length} signal(s)`);
        return [{ id: `recovered-${randomUUID()}`, name: 'submit_decision', input: { decision, reasoning, signals } }];
      }
    }
  }

  const flagMatch = text.match(FLAG_RE);
  if (flagMatch) {
    // Extract reason — may be quoted or bare text, may end with )
    const reason = flagMatch[1].replace(/^["'(\s]+/, '').replace(/["')\s]+$/, '').trim();
    if (reason) {
      log.warn(`Recovered text-as-tool-call: flag_for_review`);
      return [{ id: `recovered-${randomUUID()}`, name: 'flag_for_review', input: { reason } }];
    }
  }

  return [];
}

/** Pull reasoning from <reasoning>...</reasoning> tags, falling back to raw text. */
function extractReasoning(text: string): string {
  const match = text.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
  return match?.[1]?.trim() ?? text.slice(0, 500);
}

/**
 * Parse "action CLOSE, symbol MSFT, strategy PDS" into a signal object.
 * Handles legs like "legs [BUY 507.5P, SELL 500P]" and numeric fields.
 */
function parseSignalText(text: string): Record<string, unknown> | null {
  // Extract and remove legs bracket before splitting on commas
  // (legacy model output — convert to strikes/expiry)
  let remaining = text;
  const legsMatch = text.match(/legs\s*\[([^\]]+)\]/i);
  if (legsMatch) remaining = remaining.replace(legsMatch[0], '');

  const kv: Record<string, string> = {};
  for (const part of remaining.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(' ');
    if (idx > 0) {
      kv[trimmed.slice(0, idx).toLowerCase()] = trimmed.slice(idx + 1).trim();
    }
  }

  if (!kv.action || !kv.symbol) return null;

  const signal: Record<string, unknown> = {
    action: kv.action.toUpperCase(),
    symbol: kv.symbol.toUpperCase(),
  };

  if (kv.direction) signal.direction = kv.direction.toUpperCase();
  if (kv.strategy) signal.strategy = kv.strategy.toUpperCase();
  if (kv.targetstrategy) signal.targetStrategy = kv.targetstrategy.toUpperCase();
  if (kv.exitpercent) signal.exitPercent = parseFloat(kv.exitpercent);
  // Support both old (statedpremium) and new (statedprice) field names from model output
  if (kv.statedprice) signal.statedPrice = parseFloat(kv.statedprice);
  else if (kv.statedpremium) signal.statedPrice = parseFloat(kv.statedpremium);
  if (kv.quantity) signal.quantity = parseFloat(kv.quantity);

  // Parse strikes from kv or from legacy legs bracket
  if (kv.strikes) {
    // "strikes [332.5]" or "strikes [190, 192.5]" or "strikes 332.5"
    const strikesArr = kv.strikes.replace(/[\[\]]/g, '').split(/[,\s]+/).map(Number).filter(n => !isNaN(n) && n > 0);
    if (strikesArr.length > 0) signal.strikes = strikesArr;
  } else if (legsMatch) {
    // Convert legacy legs to strikes array
    const legs = parseLegsText(legsMatch[1]);
    const strikes = legs.map(l => l.strike as number).filter(s => s > 0);
    if (strikes.length > 0) signal.strikes = strikes;
    // Extract expiry from first leg that has one
    const legExpiry = legs.find(l => l.expiry != null)?.expiry;
    if (legExpiry && !kv.expiry) signal.expiry = legExpiry;
  }

  // Set expiry from kv if present
  if (kv.expiry) {
    signal.expiry = kv.expiry;
  }

  // LEAP context fallback: if the raw text mentions "leap" but no expiry was parsed,
  // inject expiry: "LEAP" to catch flaky model formatting under concurrency
  if (!signal.expiry && /leap/i.test(text)) {
    signal.expiry = 'LEAP';
  }

  return signal;
}

/** @internal Exported for testing only. */
export const _testing = { recoverToolCallsFromText, extractReasoning, parseSignalText, parseLegsText };

/** Parse "BUY 507.5P, SELL 500P" or "BUY 180C expiry=Oct" into leg objects. */
function parseLegsText(text: string): Array<Record<string, unknown>> {
  const legs: Array<Record<string, unknown>> = [];
  const legRe = /(BUY|SELL)\s+(\d+(?:\.\d+)?)(C|P)(?:\s+expiry=(\S+))?/gi;
  let match: RegExpExecArray | null;
  while ((match = legRe.exec(text)) !== null) {
    const leg: Record<string, unknown> = {
      action: match[1].toUpperCase(),
      strike: parseFloat(match[2]),
      optionType: match[3].toUpperCase() === 'C' ? 'CALL' : 'PUT',
    };
    if (match[4]) leg.expiry = match[4];
    legs.push(leg);
  }
  return legs;
}
