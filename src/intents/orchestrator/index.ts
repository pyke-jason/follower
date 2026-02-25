/**
 * Orchestrator entry point.
 *
 * Replaces the current skip→LLM→postprocess chain with a field-by-field
 * resolution engine. Each message is routed to the cheapest path that can
 * fully resolve it:
 *
 *   parse → route → resolve → ResolvedSignal[] | SKIP | MANUAL_REVIEW
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
import { resolveOpenPath, resolveAddPath } from './open-path.js';
import { resolvePositionPath } from './position-path.js';
import { resolveLLMPath } from './llm-path.js';
import type {
  OrchestratorContext,
  OrchestratorResult,
  ParseResult,
  ResolvedSignal,
  Leg,
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
 *                 returns MANUAL_REVIEW.
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
    logResult(ctx, parse, { outcome: 'SKIP', reason: parse.skipReason ?? 'hard skip' });
    return { outcome: 'SKIP', reason: parse.skipReason ?? 'hard skip' };
  }

  // ── 2. Strangle ─────────────────────────────────────────────────────────────
  // Strangle/straddle EXIT: close all matching positions for symbol
  if (parse.isStrangle && parse.action !== 'OPEN' && parse.action !== null) {
    log.debug(`[${ctx.messageId}] strangle exit → per-position close`);
    const r = await resolveStrangleExit(parse, ctx);
    logResult(ctx, parse, r);
    return r;
  }

  // Strangle/straddle OPEN: decompose into CALL + PUT signals
  if (parse.isStrangle) {
    log.debug(`[${ctx.messageId}] strangle → forking into CALL + PUT`);
    const r = await resolveStrangle(parse, ctx);
    logResult(ctx, parse, r);
    return r;
  }

  // ── 3 & 4. Deterministic paths ──────────────────────────────────────────────
  // Only take the fast path when there are no complexity flags and the action
  // was unambiguously determined.
  const needsLLM = parse.complexityFlags.size > 0 || parse.action === null;

  if (!needsLLM) {
    if (parse.action === 'ADD') {
      log.debug(`[${ctx.messageId}] → add path`);
      const r = await resolveAddPath(parse, ctx);
      logResult(ctx, parse, r);
      return r;
    }

    if (parse.action === 'OPEN') {
      log.debug(`[${ctx.messageId}] → open path`);
      const r = await resolveOpenPath(parse, ctx);
      logResult(ctx, parse, r);
      return r;
    }

    if (
      parse.action === 'CLOSE' ||
      parse.action === 'TRIM' ||
      parse.action === 'LEG_OFF'
    ) {
      log.debug(`[${ctx.messageId}] → position path (${parse.action})`);
      const r = await resolvePositionPath(parse, ctx);
      logResult(ctx, parse, r);
      return r;
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
    const r: OrchestratorResult = {
      outcome: 'MANUAL_REVIEW',
      reason: `Requires NLU (${flagDetail}) but no LLM provider available`,
    };
    logResult(ctx, parse, r);
    return r;
  }

  const r = await resolveLLMPath(parse, ctx, provider);
  logResult(ctx, parse, r);
  return r;
}

// ── Info-level summary log ────────────────────────────────────────────────────

function logResult(ctx: OrchestratorContext, parse: ParseResult, result: OrchestratorResult): void {
  const id = `[${ctx.messageId}]`;
  const who = ctx.author;

  if (result.outcome === 'SKIP') {
    log.info(`${id} ${who} | SKIP ${result.reason}`);
    return;
  }

  const head = [parse.action, parse.strategy, parse.symbol].filter(Boolean).join(' ');

  // Compact key=value for non-null parse fields
  const fields: string[] = [];
  if (parse.strikes) fields.push(`strikes=${parse.strikes.join('/')}`);
  if (parse.expiryHint) fields.push(`expiry="${parse.expiryHint}"`);
  if (parse.premiumHint != null) fields.push(`premium=${parse.premiumHint}`);
  if (parse.direction) fields.push(`dir=${parse.direction}`);
  if (parse.isLotto) fields.push('lotto');
  if (parse.isStrangle) fields.push('strangle');
  if (parse.exitPercent != null) fields.push(`exit=${parse.exitPercent}`);
  if (parse.complexityFlags.size > 0) fields.push(`flags=[${[...parse.complexityFlags].join(',')}]`);
  const detail = fields.length > 0 ? ` | ${fields.join(' ')}` : '';

  if (result.outcome === 'EXECUTE') {
    const legCount = result.signals.reduce((n, s) => n + s.legs.length, 0);
    log.info(`${id} ${who} | ${head}${detail} | → EXECUTE ${result.signals.length} signal(s) ${legCount} leg(s)`);
  } else {
    log.info(`${id} ${who} | ${head}${detail} | → MANUAL_REVIEW: ${result.reason}`);
  }
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
    } else if (result.outcome === 'MANUAL_REVIEW') {
      flagReasons.push(result.reason);
    }
  }

  if (signals.length > 0) {
    return { outcome: 'EXECUTE', signals };
  }

  return {
    outcome: 'MANUAL_REVIEW',
    reason: `strangle resolution failed: ${flagReasons.join('; ')}`,
  };
}

// ── Strangle exit resolution ─────────────────────────────────────────────────

/**
 * Close all open positions for a strangle/straddle symbol.
 * Produces one CLOSE signal per open position with its tradeId.
 */
async function resolveStrangleExit(
  parse: ParseResult,
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  if (!parse.symbol) {
    return { outcome: 'MANUAL_REVIEW', reason: 'strangle exit missing symbol' };
  }

  const positions = await ctx.positions.getPositions(parse.symbol);
  if (positions.length === 0) {
    return { outcome: 'MANUAL_REVIEW', reason: `no open positions for ${parse.symbol}` };
  }

  const signals: ResolvedSignal[] = [];
  for (const pos of positions) {
    const legs: Leg[] = pos.legs.map(leg => {
      const closeSide = leg.side === 'BUY' ? 'SELL' as const : 'BUY' as const;
      if (leg.type === 'option') {
        return {
          type: 'option' as const,
          symbol: pos.symbol,
          expiry: leg.expiry,
          optionType: leg.optionType!,
          strike: leg.strike,
          side: closeSide,
          quantity: leg.quantity,
        };
      }
      return {
        type: 'stock' as const,
        symbol: pos.symbol,
        side: closeSide,
        quantity: leg.quantity,
      };
    });
    signals.push({
      orderType: legs.length > 1 ? 'SPREAD' : 'SINGLE',
      legs,
      tradeId: pos.id,
    });
  }

  return { outcome: 'EXECUTE', signals };
}
