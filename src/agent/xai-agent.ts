import { generateText, stepCountIs, tool, type ToolSet } from 'ai';
import { createXai } from '@ai-sdk/xai';
import { randomUUID } from 'node:crypto';
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

const log = createLogger('XAIAgent');

export class XAIAgent implements Agent {
  readonly identity: ModelIdentity;
  private provider: ReturnType<typeof createXai>;

  constructor(identity: ModelIdentity) {
    this.identity = identity;
    if (!process.env.XAI_API_KEY) {
      throw new Error('XAI_API_KEY is not set');
    }
    this.provider = createXai({ apiKey: process.env.XAI_API_KEY });
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    // Typed `tool()` from `ai` + `strict: true` wires the schema into xAI's
    // constrained-decoding path, forcing tool calls to come through as
    // structured tool_calls rather than prose/XML in the response text.
    // `dynamicTool` erases the schema so Grok falls back to prose emission.
    const toolSet: ToolSet = {};
    for (const def of opts.tools) {
      toolSet[def.name] = tool<Record<string, unknown>, unknown>({
        description: def.description,
        inputSchema: def.input,
        strict: true,
        execute: async (input) => def.execute(input),
      });
    }

    const model = this.provider.languageModel(this.identity.model);
    const maxTurns = opts.maxTurns ?? 10;
    const temperature = opts.temperature ?? 0;

    const result = await generateText({
      model,
      system: opts.systemPrompt,
      prompt: opts.userPrompt,
      tools: toolSet,
      stopWhen: stepCountIs(maxTurns),
      temperature,
      ...(opts.maxTokens != null ? { maxOutputTokens: opts.maxTokens } : {}),
    });

    // Walk steps once: extract reasoning text, tool calls paired with their
    // results, and fire onToolCall interception. Single telemetry path.
    const steps: AgentStep[] = [];
    let capturedResult: unknown | null = null;
    for (const step of result.steps) {
      if (step.text) steps.push({ reasoning: step.text });
      for (const call of step.toolCalls) {
        const resultPart = step.toolResults.find((r) => r.toolCallId === call.toolCallId);
        const input = call.input as Record<string, unknown>;
        const output = resultPart?.output;
        const inSummary = summarizeToolInput(call.toolName, input);
        const callSig = inSummary ? `${call.toolName}(${inSummary})` : call.toolName;
        const reasoning = `${callSig} → ${summarizeToolOutput(call.toolName, output)}`;
        steps.push({ tool: call.toolName, input, output, reasoning });
        log.debug(`  ${reasoning}`);

        if (opts.onToolCall) {
          const intercepted = opts.onToolCall(call.toolName, input, output);
          if (intercepted != null) capturedResult = intercepted;
        }
      }
    }

    // Grok fallback: when the model emits a tool call as prose instead of a
    // structured tool_call, no toolCall is present in steps. Parse the final
    // text and synthesize a call. With structured decoding on (via `tool()`)
    // this path should rarely fire — each hit is logged with its variant tag
    // so residual rates are measurable.
    if (capturedResult == null && result.text) {
      const recovered = recoverToolCallsFromText(result.text);
      for (const rec of recovered) {
        const def = opts.tools.find((t) => t.name === rec.name);
        if (!def) continue;
        const output = await def.execute(rec.input);
        const inSummary = summarizeToolInput(def.name, rec.input);
        const callSig = inSummary ? `${def.name}(${inSummary})` : def.name;
        const variant = rec.id.startsWith('recovered-xml-') ? 'xml'
          : rec.id.startsWith('recovered-json-') ? 'json'
          : 'prose';
        const reasoning = `${callSig} → ${summarizeToolOutput(def.name, output)} (recovered from ${variant})`;
        steps.push({ tool: def.name, input: rec.input, output, reasoning });
        log.warn(`Recovered text-as-tool-call [${variant}]: ${rec.name} ${inSummary} | text[0..300]=${result.text.slice(0, 300)}`);
        if (opts.onToolCall) {
          const intercepted = opts.onToolCall(rec.name, rec.input, output);
          if (intercepted != null) capturedResult = intercepted;
        }
      }
    }

    const usage: AgentUsage = {
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0,
      cacheReadInputTokens: result.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0,
      cacheCreationInputTokens: result.totalUsage.inputTokenDetails?.cacheWriteTokens ?? 0,
    };

    return { model: this.identity, steps, result: capturedResult, usage };
  }
}

// ─── Text-to-tool-call recovery (Grok fallback) ──────────────────────────
//
// Some Grok versions stochastically describe tool calls in text instead of
// emitting structured tool_calls. Reasoning is correct but the signal is
// lost. Parse the patterns and synthesize proper tool calls.

// Matches both:
//   submit_decision(EXECUTE)   — positional style
//   submit_decision(decision="SKIP", reasoning="…")  — keyword style
const SUBMIT_RE = /submit_decision\s*\(\s*(?:decision\s*[=:]\s*["']?)?(EXECUTE|SKIP|MANUAL_REVIEW|IGNORE)(?:["']?)?\s*[,)]?\s*(?:([\s\S]*))?/i;
const FLAG_RE = /flag_for_review\s*[(:](.+)/i;

// Grok sometimes emits XML-style tags: <function_call name="submit_decision">
// <decision>SKIP</decision><reasoning>...</reasoning></function_call>
const XML_FUNCTION_CALL_RE = /<function_call\s+name=["']?(submit_decision|flag_for_review)["']?\s*>([\s\S]*?)(?:<\/function_call>|$)/i;

type RecoveredCall = { id: string; name: string; input: Record<string, unknown> };

function extractXMLParam(body: string, paramName: string): string | null {
  // Format 1: <name>value</name>
  const direct = body.match(new RegExp(`<${paramName}>([\\s\\S]*?)<\\/${paramName}>`, 'i'));
  if (direct) return direct[1].trim();
  // Format 2: <parameter name="name">value</parameter>  (Claude-style)
  const param = body.match(new RegExp(`<parameter\\s+name=["']?${paramName}["']?\\s*>([\\s\\S]*?)<\\/parameter>`, 'i'));
  if (param) return param[1].trim();
  // Format 3: <argument name="name">value</argument>  (Grok alt-style)
  const arg = body.match(new RegExp(`<argument\\s+name=["']?${paramName}["']?\\s*>([\\s\\S]*?)<\\/argument>`, 'i'));
  if (arg) return arg[1].trim();
  return null;
}

function recoverFromXMLFunctionCall(text: string): RecoveredCall | null {
  const m = text.match(XML_FUNCTION_CALL_RE);
  if (!m) return null;
  const toolName = m[1];
  const body = m[2];
  if (toolName === 'submit_decision') {
    const rawDecision = extractXMLParam(body, 'decision');
    if (!rawDecision) return null;
    let decision = rawDecision.toUpperCase().replace(/\s+/g, '');
    if (!['EXECUTE', 'SKIP', 'MANUAL_REVIEW', 'IGNORE'].includes(decision)) return null;
    if (decision === 'IGNORE') decision = 'SKIP';
    const reasoning = extractXMLParam(body, 'reasoning') ?? '';
    const signalsRaw = extractXMLParam(body, 'signals');
    if (decision === 'EXECUTE' && signalsRaw) {
      try {
        const parsed = JSON.parse(signalsRaw);
        const signals = Array.isArray(parsed) ? parsed : [parsed];
        return { id: `recovered-xml-${randomUUID()}`, name: 'submit_decision', input: { decision, reasoning, signals } };
      } catch { /* fall through — return SKIP/MANUAL_REVIEW shape instead */ }
    }
    return { id: `recovered-xml-${randomUUID()}`, name: 'submit_decision', input: { decision, reasoning } };
  }
  if (toolName === 'flag_for_review') {
    const reason = extractXMLParam(body, 'reason') ?? body.replace(/<[^>]+>/g, ' ').trim();
    if (!reason) return null;
    return { id: `recovered-xml-${randomUUID()}`, name: 'flag_for_review', input: { reason } };
  }
  return null;
}

// Try to extract a JSON object that looks like a submit_decision payload.
// Handles: bare JSON, `submit_decision({...})`, `submit_decision\n{...}`, fenced ```json{...}```
function recoverFromJSONPayload(text: string): RecoveredCall | null {
  const candidates: string[] = [];
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidates.push(fenceMatch[1]);
  const callMatch = text.match(/submit_decision\s*[:\n(]\s*(\{[\s\S]*)/i);
  if (callMatch) candidates.push(callMatch[1]);
  const bareMatch = text.match(/(\{[\s\S]*?"decision"\s*:\s*"[\s\S]*)/);
  if (bareMatch) candidates.push(bareMatch[1]);

  for (const c of candidates) {
    for (let end = c.length; end > 0; end--) {
      if (c[end - 1] !== '}') continue;
      const slice = c.slice(0, end);
      try {
        const obj = JSON.parse(slice) as Record<string, unknown>;
        if (obj && typeof obj === 'object' && typeof obj.decision === 'string') {
          let decision = (obj.decision as string).toUpperCase();
          if (decision === 'IGNORE') decision = 'SKIP';
          const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
          const input: Record<string, unknown> = { decision, reasoning };
          if (Array.isArray(obj.signals)) input.signals = obj.signals;
          return { id: `recovered-json-${randomUUID()}`, name: 'submit_decision', input };
        }
      } catch { /* try shorter slice */ }
    }
  }
  return null;
}

function recoverToolCallsFromText(text: string): RecoveredCall[] {
  const xmlRecovered = recoverFromXMLFunctionCall(text);
  if (xmlRecovered) return [xmlRecovered];

  const jsonRecovered = recoverFromJSONPayload(text);
  if (jsonRecovered) return [jsonRecovered];

  const submitMatch = text.match(SUBMIT_RE);
  if (submitMatch) {
    const decision = submitMatch[1].toUpperCase();
    const detailText = (submitMatch[2] ?? '').trim();
    const reasoning = extractReasoning(text);

    if (decision === 'SKIP' || decision === 'MANUAL_REVIEW') {
      return [{ id: `recovered-${randomUUID()}`, name: 'submit_decision', input: { decision, reasoning } }];
    }

    if (decision === 'EXECUTE' && detailText) {
      const cleanDetail = detailText.replace(/^\[\s*/, '').replace(/\s*\]$/, '');
      const signalTexts = cleanDetail
        .split(/(?=action\s+(?:OPEN|CLOSE|TRIM|LEG_OFF|ADD))/i)
        .map((s) => s.trim().replace(/,+$/, ''))
        .filter(Boolean);

      const signals = signalTexts
        .map(parseSignalText)
        .filter((s): s is Record<string, unknown> => s !== null);

      if (signals.length > 0) {
        return [{ id: `recovered-${randomUUID()}`, name: 'submit_decision', input: { decision, reasoning, signals } }];
      }
    }
  }

  const flagMatch = text.match(FLAG_RE);
  if (flagMatch) {
    const reason = flagMatch[1].replace(/^["'(\s]+/, '').replace(/["')\s]+$/, '').trim();
    if (reason) {
      return [{ id: `recovered-${randomUUID()}`, name: 'flag_for_review', input: { reason } }];
    }
  }

  return [];
}

function extractReasoning(text: string): string {
  const match = text.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
  return match?.[1]?.trim() ?? text.slice(0, 500);
}

function parseSignalText(text: string): Record<string, unknown> | null {
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
  if (kv.statedprice) signal.statedPrice = parseFloat(kv.statedprice);
  else if (kv.statedpremium) signal.statedPrice = parseFloat(kv.statedpremium);
  if (kv.quantity) signal.quantity = parseFloat(kv.quantity);

  if (kv.strikes) {
    const strikesArr = kv.strikes.replace(/[\[\]]/g, '').split(/[,\s]+/).map(Number).filter((n) => !isNaN(n) && n > 0);
    if (strikesArr.length > 0) signal.strikes = strikesArr;
  } else if (legsMatch) {
    const legs = parseLegsText(legsMatch[1]);
    const strikes = legs.map((l) => l.strike as number).filter((s) => s > 0);
    if (strikes.length > 0) signal.strikes = strikes;
    const legExpiry = legs.find((l) => l.expiry != null)?.expiry;
    if (legExpiry && !kv.expiry) signal.expiry = legExpiry;
  }

  if (kv.expiry) signal.expiry = kv.expiry;

  if (!signal.expiry && /leap/i.test(text)) {
    signal.expiry = 'LEAP';
  }

  return signal;
}

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

/** @internal Exported for testing only. */
export const _testing = { recoverToolCallsFromText, extractReasoning, parseSignalText, parseLegsText };
