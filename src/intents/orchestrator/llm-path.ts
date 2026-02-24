/**
 * LLM path — natural language understanding for messages that couldn't be
 * resolved deterministically by the parser.
 *
 * Used for:
 * - Casual exit language ("took profits on CRWV calls this morning")
 * - Follow-trade patterns ("following Dave on MSTR")
 * - Multi-trade decomposition (two trades in one message)
 * - Leg-off instructions ("exit the spread, hold straight calls")
 * - Ambiguous action classification
 *
 * The LLM only handles what the parser couldn't: NLU. Direction rules, PCS
 * normalization, and badge interpretation are already done by the parser.
 */

import { htmlToLLMText } from '../../parsing/html.js';
import { formatTimestampForLLM } from '../../lib/et-date.js';
import { runAgentLoop } from '../../agent/agent-loop.js';
import type { LLMProvider } from '../../agent/providers.js';
import { createIntentTools, intentOnToolCall } from '../intent-tools.js';
import type { Signal } from '../../agent/schemas.js';
import type { TaskResult } from '../../agent/schemas.js';
import { createLogger } from '../../lib/logger.js';
import type {
  OrchestratorContext,
  OrchestratorResult,
  ParseResult,
  ResolvedSignal,
} from './types.js';
import { resolveOpenPath } from './open-path.js';
import { resolvePositionPath } from './position-path.js';

const log = createLogger('Orchestrator:LLM');

// ── Simplified NLU-only system prompt ─────────────────────────────────────────
//
// Direction rules, PCS normalization, badge handling, lotto/yolo overrides are
// all handled by the parser before this path is called. This prompt focuses
// purely on natural language understanding.

const NLU_SYSTEM_PROMPT = `You are a trading signal classifier. Parse trading messages that require natural language understanding.

The message has already been pre-parsed for structured fields (strategy keywords, explicit strikes, badge encoding). You only handle what the parser couldn't resolve.

## When to call submit_decision:

**EXECUTE** — message is a clear trade signal:
- Casual exit language: "took profits on CRWV calls", "stopped out of AAPL", "closed my position"
- Multi-trade messages: decompose into separate signals (one per distinct trade)
- Leg-off instructions: "exit the spread, hold straight calls" → action=LEG_OFF, targetStrategy=CALL
- Follow trades: find the referenced trade via get_recent_chat, mirror its signal

**IGNORE** — not a trade:
- Market commentary: "NVDA having a great day"
- Position updates without action: "holding 20 contracts of SPY"
- Questions: "what do you think about AAPL?"

## Signal fields to provide:

For OPEN signals:
- action: "OPEN"
- symbol: ticker (required)
- strategy: "CALL" | "PUT" | "CDS" | "PDS" | "STOCK"
- direction: "LONG" | "SHORT" (if not deterministic from strategy)
- statedPremium: dollar amount if mentioned (e.g. 2.10)
- Do NOT include legs, expiry dates, or exact strikes — those are resolved by market data

For CLOSE / TRIM / LEG_OFF signals:
- action: "CLOSE" | "TRIM" | "LEG_OFF"
- symbol: ticker (required)
- strategy: hint for which position to close (optional — use if clear)
- exitPercent: 0.5 for half, 0.333 for third, etc. (TRIM only)
- targetStrategy: "CALL" | "PUT" for LEG_OFF (the leg to KEEP)

## Rules:
- "Lotto"/"Yolo" = always LONG (buying), never SHORT
- "Wrote"/"Writing" = always SHORT (selling to open)
- For follow-trades: call get_recent_chat to find the trade, then mirror it exactly
- When in doubt about a casual exit, use CLOSE
- Paper trades, futures (ES/NQ/RTY/YM) → IGNORE

Call submit_decision or flag_for_review when ready.`;

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the LLM path for a message that requires natural language understanding.
 *
 * Routes each LLM-produced signal through the appropriate resolution path
 * (open-path for OPEN, position-path for CLOSE/TRIM/LEG_OFF).
 */
export async function resolveLLMPath(
  parse: ParseResult,
  ctx: OrchestratorContext,
  provider: LLMProvider,
): Promise<OrchestratorResult> {
  const userPrompt = buildNLUPrompt(parse, ctx);

  const tools = createIntentTools(async (author, limit) => {
    return ctx.chatHistory.getRecentMessages(author, limit);
  });

  let loopResult: Awaited<ReturnType<typeof runAgentLoop>>;
  try {
    loopResult = await runAgentLoop(
      {
        systemPrompt: NLU_SYSTEM_PROMPT,
        tools,
        onToolCall: intentOnToolCall,
        maxTurns: 5,
      },
      userPrompt,
      provider,
    );
  } catch (err) {
    log.error('LLM path agent loop failed:', err);
    return {
      outcome: 'FLAG_FOR_REVIEW',
      reason: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const taskResult = loopResult.result as TaskResult | null;

  if (!taskResult) {
    return { outcome: 'FLAG_FOR_REVIEW', reason: 'LLM did not call a decision tool' };
  }

  if (taskResult.decision === 'SKIP') {
    return { outcome: 'SKIP', reason: taskResult.reasoning };
  }

  if (taskResult.decision === 'MANUAL_REVIEW') {
    return { outcome: 'FLAG_FOR_REVIEW', reason: taskResult.reasoning };
  }

  if (!taskResult.signals || taskResult.signals.length === 0) {
    return { outcome: 'FLAG_FOR_REVIEW', reason: 'LLM returned EXECUTE with no signals' };
  }

  log.debug(
    `LLM path: ${taskResult.signals.length} signal(s) for message ${ctx.messageId}`,
  );

  // Route each signal through the appropriate resolution path
  return routeLLMSignals(taskResult.signals, parse, ctx);
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildNLUPrompt(parse: ParseResult, ctx: OrchestratorContext): string {
  const messageText = htmlToLLMText(ctx.rawHtml);
  const dateStr = formatTimestampForLLM(ctx.timestamp);

  const lines: string[] = [
    `Classify this trading message.`,
    ``,
    `Date/Time: ${dateStr}`,
    `Author: ${ctx.author}`,
    `Text: ${messageText}`,
    `Symbols detected: ${JSON.stringify(ctx.symbols)}`,
  ];

  // Include what the parser already determined — LLM doesn't need to re-derive these
  const knownParts: string[] = [];
  if (parse.action) knownParts.push(`action=${parse.action}`);
  if (parse.strategy) knownParts.push(`strategy=${parse.strategy}`);
  if (parse.direction) knownParts.push(`direction=${parse.direction}`);
  if (parse.strikes?.length) knownParts.push(`strikes=${parse.strikes.join('/')}`);
  if (parse.expiryHint) knownParts.push(`expiryHint="${parse.expiryHint}"`);
  if (parse.premiumHint !== null) knownParts.push(`premium=$${parse.premiumHint}`);

  if (knownParts.length > 0) {
    lines.push(``, `Pre-parsed fields: ${knownParts.join(', ')}`);
  }

  if (parse.complexityFlags.size > 0) {
    lines.push(`Complexity: ${Array.from(parse.complexityFlags).join(', ')}`);
  }

  lines.push(``, `Classify and call submit_decision.`);
  return lines.join('\n');
}

// ── Signal routing ────────────────────────────────────────────────────────────

/**
 * Convert LLM Signal[] into ParseResults and route each through
 * the appropriate resolution path (open-path or position-path).
 */
async function routeLLMSignals(
  llmSignals: Signal[],
  originalParse: ParseResult,
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  const allSignals: ResolvedSignal[] = [];
  const flagReasons: string[] = [];

  for (const signal of llmSignals) {
    const signalParse = signalToParseResult(signal, originalParse);
    let result: OrchestratorResult;

    if (signalParse.action === 'OPEN' || signalParse.action === 'ADD') {
      result = await resolveOpenPath(signalParse, ctx);
    } else if (
      signalParse.action === 'CLOSE' ||
      signalParse.action === 'TRIM' ||
      signalParse.action === 'LEG_OFF'
    ) {
      result = await resolvePositionPath(signalParse, ctx);
    } else {
      flagReasons.push(`unroutable action from LLM: ${signalParse.action ?? 'null'}`);
      continue;
    }

    if (result.outcome === 'EXECUTE') {
      allSignals.push(...result.signals);
    } else if (result.outcome === 'FLAG_FOR_REVIEW') {
      flagReasons.push(result.reason);
    }
    // SKIP from a sub-signal is treated as no output (not propagated as top-level SKIP)
  }

  if (allSignals.length > 0) {
    return { outcome: 'EXECUTE', signals: allSignals };
  }

  return {
    outcome: 'FLAG_FOR_REVIEW',
    reason:
      flagReasons.length > 0
        ? flagReasons.join('; ')
        : 'LLM path produced no executable signals',
  };
}

/**
 * Convert an LLM-produced Signal to a ParseResult for resolution routing.
 * Merges with the original parser output (parser is authoritative for fields
 * it could determine; LLM fills in what was null).
 */
function signalToParseResult(signal: Signal, originalParse: ParseResult): ParseResult {
  // Extract strikes from legs (hint-legs with strike=0 are excluded)
  const llmStrikes =
    signal.legs
      ?.map((l) => l.strike)
      .filter((s) => s > 0) ?? null;

  // Extract expiry hint from first non-zero leg
  const llmExpiryHint =
    signal.legs?.find((l) => l.expiry)?.expiry ?? null;

  return {
    action: signal.action,
    symbol: signal.symbol,
    direction: signal.direction ?? originalParse.direction,
    strategy: signal.strategy as ParseResult['strategy'],
    strikes: llmStrikes?.length ? llmStrikes : originalParse.strikes,
    expiryHint: llmExpiryHint ?? originalParse.expiryHint,
    premiumHint: signal.statedPremium ?? originalParse.premiumHint,
    exitPercent: signal.exitPercent ?? originalParse.exitPercent,
    targetStrategy: (signal.targetStrategy as ParseResult['targetStrategy']) ??
      originalParse.targetStrategy,
    isStrangle: false,
    isHardSkip: false,
    skipReason: null,
    complexityFlags: new Set(), // LLM-resolved signals have no complexity flags
  };
}
