import { generateText, stepCountIs, dynamicTool } from 'ai';
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
    const steps: AgentStep[] = [];
    let capturedResult: unknown | null = null;

    const toolSet: Record<string, ReturnType<typeof dynamicTool>> = {};
    for (const def of opts.tools) {
      toolSet[def.name] = dynamicTool({
        description: def.description,
        inputSchema: def.input,
        execute: async (input) => {
          const typedInput = input as Record<string, unknown>;
          const t0 = Date.now();
          const output = await def.execute(typedInput);
          const durationMs = Date.now() - t0;
          const inSummary = summarizeToolInput(def.name, typedInput);
          const callSig = inSummary ? `${def.name}(${inSummary})` : def.name;
          const reasoning = `${callSig} → ${summarizeToolOutput(def.name, output)}`;
          steps.push({ tool: def.name, input: typedInput, output, reasoning, durationMs });
          log.debug(`  ${reasoning} (${durationMs}ms)`);

          if (opts.onToolCall) {
            const intercepted = opts.onToolCall(def.name, typedInput, output);
            if (intercepted != null) capturedResult = intercepted;
          }

          return output;
        },
      });
    }

    const model = this.provider.languageModel(this.identity.model);
    const maxTurns = opts.maxTurns ?? 10;

    const result = await generateText({
      model,
      system: opts.systemPrompt,
      prompt: opts.userPrompt,
      tools: toolSet,
      stopWhen: stepCountIs(maxTurns),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens != null ? { maxOutputTokens: opts.maxTokens } : {}),
    });

    // Accumulate reasoning text from every step. Tool call/result pairs are
    // already recorded by the dynamicTool execute wrapper above.
    for (const step of result.steps) {
      if (step.text) {
        steps.push({ reasoning: step.text });
      }
    }

    // Grok fallback: when the model emits a tool call as prose instead of a
    // structured tool_call, the dynamicTool execute wrapper never fires. Parse
    // the final text and synthesize a call via onToolCall.
    if (capturedResult == null && result.text) {
      const recovered = recoverToolCallsFromText(result.text);
      for (const rec of recovered) {
        const def = opts.tools.find((t) => t.name === rec.name);
        if (!def) continue;
        const output = await def.execute(rec.input);
        const inSummary = summarizeToolInput(def.name, rec.input);
        const callSig = inSummary ? `${def.name}(${inSummary})` : def.name;
        const reasoning = `${callSig} → ${summarizeToolOutput(def.name, output)} (recovered from text)`;
        steps.push({ tool: def.name, input: rec.input, output, reasoning });
        log.warn(`Recovered text-as-tool-call: ${rec.name} ${inSummary}`);
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

const SUBMIT_RE = /submit_decision\s*\(\s*(EXECUTE|SKIP|MANUAL_REVIEW)\s*\)(?:\s*:?\s*([\s\S]*))?/i;
const FLAG_RE = /flag_for_review\s*[(:](.+)/i;

type RecoveredCall = { id: string; name: string; input: Record<string, unknown> };

function recoverToolCallsFromText(text: string): RecoveredCall[] {
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
