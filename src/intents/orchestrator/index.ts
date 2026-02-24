/**
 * Orchestrator entry point.
 *
 * Replaces the current skip→LLM→postprocess chain with a field-by-field
 * resolution engine. Each message is routed to the cheapest path that can
 * fully resolve it:
 *
 *   parse → route → resolve → ResolvedSignal[] | SKIP | FLAG_FOR_REVIEW
 *
 * Routes (in order of precedence):
 *   1. Hard skip  → SKIP immediately (no I/O)
 *   2. Strangle   → fork into CALL + PUT OPEN signals via open-path
 *   3. OPEN (no complexity flags) → open-path (market data only)
 *   4. CLOSE / TRIM / LEG_OFF (no complexity flags) → position-path (DB only)
 *   5. Complexity flags or action=null → LLM path → then re-route
 *
 * See docs/plan-orchestrator-technical.md for the full design.
 */

import { createLogger } from '../../lib/logger.js';
import type { LLMProvider } from '../../agent/providers.js';
import { parseMessage } from './parser.js';
import { resolveOpenPath } from './open-path.js';
import { resolvePositionPath } from './position-path.js';
import { resolveLLMPath } from './llm-path.js';
import type {
  OrchestratorContext,
  OrchestratorResult,
  ParseResult,
  ResolvedSignal,
} from './types.js';

export type { OrchestratorContext, OrchestratorResult, ResolvedSignal };
export type { Leg, OptionLeg, StockLeg } from './types.js';
export type { OrchestratorMarketDataProvider, PositionProvider, ChatHistoryProvider, OpenPosition, TraderConfig } from './types.js';

const log = createLogger('Orchestrator');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a trading message to concrete signals (or SKIP/FLAG outcome).
 *
 * @param ctx      All context the orchestrator might need (message, market data, positions, chat)
 * @param provider Optional LLM provider. Required if the message needs NLU (complex language,
 *                 casual exits, follow trades). If null and the LLM path is triggered,
 *                 returns FLAG_FOR_REVIEW.
 */
export async function resolveOrchestrator(
  ctx: OrchestratorContext,
  provider?: LLMProvider,
): Promise<OrchestratorResult> {
  const parse = parseMessage(ctx);

  log.debug(
    `[${ctx.messageId}] parse: action=${parse.action} symbol=${parse.symbol} ` +
    `strategy=${parse.strategy} direction=${parse.direction} ` +
    `flags=[${Array.from(parse.complexityFlags).join(',')}] ` +
    `hardSkip=${parse.isHardSkip} strangle=${parse.isStrangle}`,
  );

  // ── 1. Hard skip ────────────────────────────────────────────────────────────
  if (parse.isHardSkip) {
    log.debug(`[${ctx.messageId}] hard skip: ${parse.skipReason}`);
    return { outcome: 'SKIP', reason: parse.skipReason ?? 'hard skip' };
  }

  // ── 2. Strangle ─────────────────────────────────────────────────────────────
  // Strangles decompose into two SINGLE signals: one CALL and one PUT.
  if (parse.isStrangle) {
    log.debug(`[${ctx.messageId}] strangle → forking into CALL + PUT`);
    return resolveStrangle(parse, ctx);
  }

  // ── 3 & 4. Deterministic paths ──────────────────────────────────────────────
  // Only take the fast path when there are no complexity flags and the action
  // was unambiguously determined.
  const needsLLM = parse.complexityFlags.size > 0 || parse.action === null;

  if (!needsLLM) {
    if (parse.action === 'OPEN' || parse.action === 'ADD') {
      log.debug(`[${ctx.messageId}] → open path`);
      return resolveOpenPath(parse, ctx);
    }

    if (
      parse.action === 'CLOSE' ||
      parse.action === 'TRIM' ||
      parse.action === 'LEG_OFF'
    ) {
      log.debug(`[${ctx.messageId}] → position path (${parse.action})`);
      return resolvePositionPath(parse, ctx);
    }
  }

  // ── 5. LLM path ─────────────────────────────────────────────────────────────
  const flagDetail = parse.complexityFlags.size > 0
    ? `flags: [${Array.from(parse.complexityFlags).join(', ')}]`
    : 'action=null';
  log.debug(`[${ctx.messageId}] → LLM path (${flagDetail})`);

  if (!provider) {
    log.warn(
      `[${ctx.messageId}] LLM path needed (${flagDetail}) but no provider supplied`,
    );
    return {
      outcome: 'FLAG_FOR_REVIEW',
      reason: `Requires NLU (${flagDetail}) but no LLM provider available`,
    };
  }

  return resolveLLMPath(parse, ctx, provider);
}

// ── Strangle resolution ───────────────────────────────────────────────────────

/**
 * Fork a strangle/straddle into two OPEN signals: one CALL leg and one PUT leg.
 * Each resolves independently through the open-path.
 */
async function resolveStrangle(
  parse: ParseResult,
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  const baseParse: ParseResult = {
    ...parse,
    action: 'OPEN',
    direction: 'LONG',
    isStrangle: false,
    complexityFlags: new Set(),
  };

  const callParse: ParseResult = { ...baseParse, strategy: 'CALL' };
  const putParse: ParseResult = { ...baseParse, strategy: 'PUT' };

  const [callResult, putResult] = await Promise.all([
    resolveOpenPath(callParse, ctx),
    resolveOpenPath(putParse, ctx),
  ]);

  const signals: ResolvedSignal[] = [];
  const flagReasons: string[] = [];

  for (const result of [callResult, putResult]) {
    if (result.outcome === 'EXECUTE') {
      signals.push(...result.signals);
    } else if (result.outcome === 'FLAG_FOR_REVIEW') {
      flagReasons.push(result.reason);
    }
  }

  if (signals.length > 0) {
    return { outcome: 'EXECUTE', signals };
  }

  return {
    outcome: 'FLAG_FOR_REVIEW',
    reason: `strangle resolution failed: ${flagReasons.join('; ')}`,
  };
}
