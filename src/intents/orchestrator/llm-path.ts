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

import { htmlToLLMText } from '@/parsing/html.js';
import { formatTimestampForLLM } from '@/lib/et-date.js';
import { runAgentLoop } from '@/agent/agent-loop.js';
import type { LLMProvider } from '@/agent/providers.js';
import { createIntentTools, intentOnToolCall } from '../intent-tools.js';
import type { Signal } from '@/agent/schemas.js';
import type { TaskResult } from '@/agent/schemas.js';
import { createLogger } from '@/lib/logger.js';
import type {
  OrchestratorContext,
  OrchestratorResult,
  ParseResult,
  ResolvedSignal,
} from './types.js';
import { resolveOpenPath, resolveAddPath } from './open-path.js';
import { resolvePositionPath } from './position-path.js';
import { lookupIntent, writeIntent, INTENT_VERSION } from './intent-cache.js';
import type { IntentStep } from '@/db/schema.js';

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
- Position updates without action: "holding 20 contracts of SPY", "offering balance at $49.40"
- Future intent or conditional language: "I will take gains", "looking to exit", "plan to close", "trying to sell", "hoping to exit" — these describe what the trader WILL do or is ATTEMPTING, not a confirmed fill
- Questions: "what do you think about AAPL?"

## Signal fields to provide:

For OPEN signals:
- action: "OPEN"
- symbol: ticker (required)
- strategy: "CALL" | "PUT" | "CDS" | "PDS" | "PCS" | "CCS" | "STOCK"
- direction: "LONG" | "SHORT" (if not deterministic from strategy)
- statedPremium: dollar amount if mentioned (e.g. 2.10)
- Do NOT include legs, expiry dates, or exact strikes — those are resolved by market data

For ADD signals (adding to an existing position):
- action: "ADD"
- symbol: ticker (required)
- strategy: same as existing position (e.g. "STOCK")
- direction: same as existing position
- "added more shares", "adding to position", "added 2,000 more" → ADD, not OPEN

For CLOSE / TRIM / LEG_OFF signals:
- action: "CLOSE" | "TRIM" | "LEG_OFF"
- symbol: ticker (required)
- strategy: hint for which position to close (optional — use if clear)
- exitPercent: 0.5 for half, 0.333 for third, etc. (TRIM only)
- targetStrategy: "CALL" | "PUT" for LEG_OFF (the leg to KEEP)

## Rules:
- When a message describes multiple distinct actions (e.g. closing one position AND opening another), emit one signal per action — do not merge them.
- STOCK direction: "shorting"/"shorted"/"short" → SHORT. "buying"/"bought"/"long" → LONG. Use the pre-parsed direction when present.
- "Lotto"/"Yolo" = always LONG (buying), never SHORT
- "Wrote"/"Writing" = always SHORT (selling to open)
- For follow-trades: call get_recent_chat to find the trade, then mirror it exactly
- Only classify as CLOSE/TRIM when the exit has clearly ALREADY HAPPENED ("took profits", "closed", "stopped out") or IS HAPPENING NOW ("closing now", "selling here"). Future intent ("I will take gains into it", "looking to exit") is NOT an exit — it's commentary. When in doubt, IGNORE rather than false-positive a CLOSE.
- Paper trades, futures (ES/NQ/RTY/YM) → IGNORE
- The English verb "put" (e.g. "put myself back in", "put on a position") is NOT the PUT option strategy. These describe re-entering or initiating a stock position.
- Hypothetical or educational statements ("If I were looking to…", "I would buy…") are NOT trades — classify as IGNORE even if they contain specific strikes, premiums, or expiries.

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
  const model = provider.identity.model;

  // ── Cache check (skip for 422 retries — failureContext alters the prompt) ──
  if (!ctx.failureContext) {
    const cached = lookupIntent(ctx.message.id, model);
    if (cached) {
      log.debug(`LLM cache hit for message ${ctx.message.id} (v${INTENT_VERSION})`);
      return resolveFromCached(cached.decision, cached.reasoning, cached.signals, parse, ctx);
    }
  }

  log.debug(`LLM cache miss for message ${ctx.message.id}, calling LLM`);

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
      outcome: 'MANUAL_REVIEW',
      reason: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const usage = loopResult.usage.inputTokens > 0
    ? { inputTokens: loopResult.usage.inputTokens, outputTokens: loopResult.usage.outputTokens }
    : undefined;
  const taskResult = loopResult.result as TaskResult | null;

  // ── Write to cache (fire-and-forget, INSERT OR IGNORE) ──
  writeIntent({
    messageId: ctx.message.id,
    model,
    route: 'llm',
    decision: taskResult?.decision ?? 'MANUAL_REVIEW',
    reasoning: taskResult?.reasoning ?? 'LLM did not call a decision tool',
    signals: taskResult?.signals ?? null,
    durationMs: loopResult.steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
    inputTokens: loopResult.usage.inputTokens,
    outputTokens: loopResult.usage.outputTokens,
    turns: loopResult.steps.filter(s => s.tool).length,
    steps: loopResult.steps as IntentStep[],
  });

  if (!taskResult) {
    return { outcome: 'MANUAL_REVIEW', reason: 'LLM did not call a decision tool', usage };
  }

  if (taskResult.decision === 'SKIP') {
    return { outcome: 'SKIP', reason: taskResult.reasoning, usage };
  }

  if (taskResult.decision === 'MANUAL_REVIEW') {
    return { outcome: 'MANUAL_REVIEW', reason: taskResult.reasoning, usage };
  }

  if (!taskResult.signals || taskResult.signals.length === 0) {
    return { outcome: 'MANUAL_REVIEW', reason: 'LLM returned EXECUTE with no signals', usage };
  }

  log.debug(
    `LLM path: ${taskResult.signals.length} signal(s) for message ${ctx.message.id}`,
  );

  // Route each signal through the appropriate resolution path
  const result = await routeLLMSignals(taskResult.signals, parse, ctx);
  return { ...result, usage };
}

/** Reconstruct an OrchestratorResult from a cached intent (zero token usage). */
async function resolveFromCached(
  decision: string,
  reasoning: string | null,
  signals: Signal[] | null,
  parse: ParseResult,
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };

  if (decision === 'SKIP') {
    return { outcome: 'SKIP', reason: reasoning ?? 'cached skip', usage };
  }
  if (decision === 'MANUAL_REVIEW') {
    return { outcome: 'MANUAL_REVIEW', reason: reasoning ?? 'cached manual review', usage };
  }
  if (!signals || signals.length === 0) {
    return { outcome: 'MANUAL_REVIEW', reason: 'cached EXECUTE with no signals', usage };
  }

  const result = await routeLLMSignals(signals, parse, ctx);
  return { ...result, usage };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildNLUPrompt(parse: ParseResult, ctx: OrchestratorContext): string {
  const messageText = htmlToLLMText(ctx.message.rawHtml);
  const dateStr = formatTimestampForLLM(ctx.message.timestamp);

  const lines: string[] = [
    `Classify this trading message.`,
    ``,
    `Date/Time: ${dateStr}`,
    `Author: ${ctx.message.author}`,
    `Badges: ${JSON.stringify(ctx.message.badges)}`,
    `Text: ${messageText}`,
    `Symbols detected: ${JSON.stringify(ctx.message.symbols)}`,
  ];

  // Include what the parser already determined — LLM doesn't need to re-derive these.
  // For multi_ticker messages, ALL per-symbol fields (action, strategy, direction,
  // strikes, expiry, premium) come from the merged full text and reflect only the first
  // symbol. Sending them anchors the LLM to a single signal, suppressing multi-trade
  // decomposition. Suppress everything; let the LLM derive per-signal fields from text.
  const isMultiTicker = parse.complexityFlags.has('multi_ticker');
  const knownParts: string[] = [];
  if (!isMultiTicker && parse.action) knownParts.push(`action=${parse.action}`);
  if (!isMultiTicker && parse.strategy) knownParts.push(`strategy=${parse.strategy}`);
  if (!isMultiTicker && parse.direction) knownParts.push(`direction=${parse.direction}`);
  if (!isMultiTicker && parse.strikes?.length) knownParts.push(`strikes=${parse.strikes.join('/')}`);
  if (!isMultiTicker && parse.expiryHint) knownParts.push(`expiryHint="${parse.expiryHint}"`);
  if (!isMultiTicker && parse.premiumHint !== null) knownParts.push(`premium=$${parse.premiumHint}`);

  if (knownParts.length > 0) {
    lines.push(``, `Pre-parsed fields: ${knownParts.join(', ')}`);
  }

  if (parse.complexityFlags.size > 0) {
    lines.push(`Complexity: ${Array.from(parse.complexityFlags).join(', ')}`);
  }

  if (ctx.failureContext) {
    lines.push(
      ``,
      `⚠️ Previous execution attempt failed: ${ctx.failureContext.error}`,
      `This usually means a strike was misread from the message (e.g. "$342/5" typed instead of "$342.5", or a typo).`,
      `Re-examine the original message text and provide corrected strike(s).`,
    );
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

    // Safety net: reroute STOCK OPEN→ADD when a matching position already exists.
    // The LLM may output OPEN for "added more shares" if it doesn't use ADD.
    if (signalParse.action === 'OPEN' && signalParse.strategy === 'STOCK' && signalParse.symbol) {
      const existing = await ctx.positions.getPositions(signalParse.symbol);
      const dup = existing.find(p => p.strategy === 'STOCK' && p.direction === signalParse.direction);
      if (dup) {
        signalParse.action = 'ADD';
      }
    }

    if (signalParse.action === 'ADD') {
      result = await resolveAddPath(signalParse, ctx);
    } else if (signalParse.action === 'OPEN') {
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
    } else if (result.outcome === 'MANUAL_REVIEW') {
      flagReasons.push(result.reason);
    }
    // SKIP from a sub-signal is treated as no output (not propagated as top-level SKIP)
  }

  if (allSignals.length > 0) {
    return { outcome: 'EXECUTE', signals: allSignals };
  }

  return {
    outcome: 'MANUAL_REVIEW',
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
    targetStrategy: originalParse.targetStrategy ??
      (signal.targetStrategy as ParseResult['targetStrategy']),
    isLotto: originalParse.isLotto,
    isStrangle: false,
    isHardSkip: false,
    skipReason: null,
    complexityFlags: new Set(), // LLM-resolved signals have no complexity flags
  };
}
