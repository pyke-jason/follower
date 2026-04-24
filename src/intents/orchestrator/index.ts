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
 *   1. No badge/cue → hard SKIP immediately (no I/O)
 *   2. Whole-message canonical trade template → deterministic path
 *   3. Everything else → LLM path → then re-route
 *
 * See docs/plan-orchestrator-technical.md for the full design.
 */

import type { Message } from '@/db/schema.js';

import { createLogger } from '@/lib/logger.js';
import { traced } from '@/lib/trace.js';
import { parseMessage } from './parser.js';
import { resolveOpenPath, resolveAddPath } from './open-path.js';
import { resolvePositionPath, buildReversalLeg } from './position-path.js';
import { synthesizeDeterministicSignals } from './classifier-signals.js';
import { resolveLLMPath } from './llm-path.js';
import { writeIntent } from './intent-cache.js';
import type { IntentRoute } from './intent-cache.js';
import { buildOrchestratorContext } from './context.js';
import {
  SerializedParseResultSchema,
  type OrchestratorContext,
  type OrchestratorEnv,
  type OrchestratorResult,
  type ParseResult,
  type SerializedParseResult,
  type ResolvedSignal,
  type Leg,
} from './types.js';


const log = createLogger('Orchestrator');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a trading message to concrete signals (or SKIP/FLAG outcome).
 *
 * Builds OrchestratorContext internally from the message and env.
 * Emits PARSED + SETTLED (for skips) or SIGNAL_RESOLVED (for executes) via env.emitter.
 *
 * @param message  The chat message to resolve
 * @param env      Pipeline environment (positions, agent, broker, emitter)
 * @param opts     Optional: failureContext for 422 retry
 */
export async function resolveOrchestrator(
  message: Message,
  env: OrchestratorEnv,
  opts?: { failureContext?: { error: string } },
): Promise<OrchestratorResult> {
  // Build internal context from message + env
  const ctx = await buildOrchestratorContext(message, env, opts?.failureContext);
  let parse = traced(env.trace, 'parse', 'sync', () => parseMessage(ctx));

  log.debug(
    `[${ctx.message.id}] parse: action=${parse.action} symbol=${parse.symbol} ` +
    `strategy=${parse.strategy} direction=${parse.direction} ` +
    `flags=[${Array.from(parse.complexityFlags).join(',')}] ` +
    `hardSkip=${parse.isHardSkip} canonical=${parse.hasCanonicalMatch} strangle=${parse.isStrangle}`,
  );

  let serializedParse = serializeParseResult(parse);

  // ── 1. Hard skip ────────────────────────────────────────────────────────────
  if (parse.isHardSkip) {
    const result: OrchestratorResult = {
      outcome: 'SKIP',
      reason: parse.skipReason ?? 'hard skip',
      parseResult: serializedParse,
      classifierSignals: [],
    };
    logResult(ctx, parse, result);
    await traced(env.trace, 'emitEvents', 'db', () => emitOrchestratorEvents(env, message, result, serializedParse, 'hard-skip'));
    return result;
  }

  // ── 2. Deterministic path (canonical templates only) ───────────────────────
  // A failureContext means execution already tried a deterministic result and
  // got a 422 — force the LLM to correct the strike.
  if (parse.hasCanonicalMatch && ctx.failureContext == null) {
    // Strangle/straddle EXIT: close all matching positions for symbol
    if (parse.isStrangle && parse.action !== 'OPEN' && parse.action !== null) {
      log.debug(`[${ctx.message.id}] strangle exit → per-position close`);
      const r = await traced(env.trace, 'strangleExit', 'db', () => resolveStrangleExit(parse, ctx));
      const result = { ...r, parseResult: serializedParse, classifierSignals: synthesizeDeterministicSignals(parse) };
      logResult(ctx, parse, result);
      await traced(env.trace, 'emitEvents', 'db', () => emitOrchestratorEvents(env, message, result, serializedParse, 'deterministic'));
      return result;
    }

    // Strangle/straddle OPEN: decompose into CALL + PUT signals
    if (parse.isStrangle) {
      log.debug(`[${ctx.message.id}] strangle → forking into CALL + PUT`);
      const r = await traced(env.trace, 'strangle', 'market_data', () => resolveStrangle(parse, ctx));
      const result = { ...r, parseResult: serializedParse, classifierSignals: synthesizeDeterministicSignals(parse) };
      logResult(ctx, parse, result);
      await traced(env.trace, 'emitEvents', 'db', () => emitOrchestratorEvents(env, message, result, serializedParse, 'deterministic'));
      return result;
    }

    // Reroute STOCK OPEN→ADD when a same-symbol/strategy/direction position already exists.
    // The parser is zero-I/O so can't check, but the orchestrator can.
    if (parse.action === 'OPEN' && parse.strategy === 'STOCK' && parse.symbol) {
      const existing = await ctx.positions.getPositions(parse.symbol);
      const duplicate = existing.find(
        (p) => p.strategy === 'STOCK' && p.direction === parse.direction,
      );
      if (duplicate) {
        log.debug(`[${ctx.message.id}] rerouting STOCK OPEN→ADD for ${parse.symbol} (existing position ${duplicate.id.slice(0, 8)})`);
        parse = { ...parse, action: 'ADD' };
        serializedParse = serializeParseResult(parse);
      }
    }

    if (parse.action === 'ADD') {
      log.debug(`[${ctx.message.id}] → add path`);
      const r = await traced(env.trace, 'addPath', 'market_data', () => resolveAddPath(parse, ctx));
      const result = { ...r, parseResult: serializedParse, classifierSignals: synthesizeDeterministicSignals(parse) };
      logResult(ctx, parse, result);
      await traced(env.trace, 'emitEvents', 'db', () => emitOrchestratorEvents(env, message, result, serializedParse, 'deterministic'));
      return result;
    }

    if (parse.action === 'OPEN') {
      log.debug(`[${ctx.message.id}] → open path`);
      const r = await traced(env.trace, 'openPath', 'market_data', () => resolveOpenPath(parse, ctx));
      if (r.outcome !== 'MANUAL_REVIEW') {
        const result = { ...r, parseResult: serializedParse, classifierSignals: synthesizeDeterministicSignals(parse) };
        logResult(ctx, parse, result);
        await traced(env.trace, 'emitEvents', 'db', () => emitOrchestratorEvents(env, message, result, serializedParse, 'deterministic'));
        return result;
      }
      // Open path couldn't resolve — fall through to LLM for disambiguation
      log.debug(`[${ctx.message.id}] open path → MANUAL_REVIEW (${r.reason}), escalating to LLM`);
    }

    if (
      parse.action === 'CLOSE' ||
      parse.action === 'TRIM' ||
      parse.action === 'LEG_OFF'
    ) {
      log.debug(`[${ctx.message.id}] → position path (${parse.action})`);
      const r = await traced(env.trace, 'positionPath', 'db', () => resolvePositionPath(parse, ctx));
      if (r.outcome !== 'MANUAL_REVIEW') {
        const result = { ...r, parseResult: serializedParse, classifierSignals: synthesizeDeterministicSignals(parse) };
        logResult(ctx, parse, result);
        await traced(env.trace, 'emitEvents', 'db', () => emitOrchestratorEvents(env, message, result, serializedParse, 'deterministic'));
        return result;
      }
      // Ambiguous position match — fall through to LLM for disambiguation
      log.debug(`[${ctx.message.id}] position path → MANUAL_REVIEW (${r.reason}), escalating to LLM`);
    }
  }

  const followTrade = await tryFollowTradeFromHistory(parse, ctx);
  if (followTrade && ctx.failureContext == null) {
    parse = followTrade;
    serializedParse = serializeParseResult(parse);
    log.debug(`[${ctx.message.id}] → open path via follow-trade history rule`);
    const r = await traced(env.trace, 'followTradeHistory', 'db', () => resolveOpenPath(parse, ctx));
    if (r.outcome !== 'MANUAL_REVIEW') {
      const result = { ...r, parseResult: serializedParse, classifierSignals: synthesizeDeterministicSignals(parse) };
      logResult(ctx, parse, result);
      await traced(env.trace, 'emitEvents', 'db', () => emitOrchestratorEvents(env, message, result, serializedParse, 'deterministic'));
      return result;
    }
    log.debug(`[${ctx.message.id}] follow-trade history → MANUAL_REVIEW (${r.reason}), escalating to LLM`);
  }

  const singlePositionExit = await trySinglePositionExit(parse, ctx);
  if (singlePositionExit && ctx.failureContext == null) {
    parse = singlePositionExit;
    serializedParse = serializeParseResult(parse);
    log.debug(`[${ctx.message.id}] → position path via single-position exit rule`);
    const r = await traced(env.trace, 'singlePositionExit', 'db', () => resolvePositionPath(parse, ctx));
    if (r.outcome !== 'MANUAL_REVIEW') {
      const result = { ...r, parseResult: serializedParse, classifierSignals: synthesizeDeterministicSignals(parse) };
      logResult(ctx, parse, result);
      await traced(env.trace, 'emitEvents', 'db', () => emitOrchestratorEvents(env, message, result, serializedParse, 'deterministic'));
      return result;
    }
    log.debug(`[${ctx.message.id}] single-position exit → MANUAL_REVIEW (${r.reason}), escalating to LLM`);
  }

  // ── 3. LLM path ─────────────────────────────────────────────────────────────
  const flagDetail = ctx.failureContext != null
    ? '422-retry'
    : parse.hasCanonicalMatch
      ? 'canonical-manual-review'
      : parse.complexityFlags.size > 0
        ? `non-canonical flags: [${Array.from(parse.complexityFlags).join(', ')}]`
        : 'non-canonical';
  log.debug(`[${ctx.message.id}] → LLM path (${flagDetail})`);

  const r = await traced(env.trace, 'llmPath', 'llm', () => resolveLLMPath(parse, ctx, env.agent));
  const result = { ...r, parseResult: serializedParse };
  logResult(ctx, parse, result);
  await traced(env.trace, 'emitEvents', 'db', () => emitOrchestratorEvents(env, message, result, serializedParse, 'llm'));
  return result;
}

async function tryFollowTradeFromHistory(
  parse: ParseResult,
  ctx: OrchestratorContext,
): Promise<ParseResult | null> {
  if (!parse.complexityFlags.has('relational')) return null;
  if (parse.symbol !== null || parse.action !== null) return null;
  if (!/\b(?:same|same\s+trade|following|with\s+you|in\s+with\s+you)\b/i.test(ctx.message.cleanText)) return null;

  const author = extractReferencedAuthor(ctx.message.cleanText);
  const history = await ctx.chatHistory.getRecentMessages(author ?? undefined, 20);
  const hint = parseSimpleFollowTradeHistory(history);
  if (!hint) return null;

  return {
    ...parse,
    action: 'OPEN',
    symbol: hint.symbol,
    direction: hint.direction,
    strategy: hint.strategy,
    strikes: hint.strikes,
    premiumHint: hint.statedPrice,
    expiryHint: null,
    hasCanonicalMatch: true,
    ruleId: 'history-loop.follow-trade-simple-option',
    routeReason: 'follow-trade mirrored structured option trade from recent chat',
  };
}

function extractReferencedAuthor(cleanText: string): string | null {
  const mention = /@([A-Za-z][\w .-]{0,40})/.exec(cleanText);
  if (mention) return mention[1].trim();
  const following = /\bfollowing\s+([A-Za-z][\w .-]{0,40})/i.exec(cleanText);
  return following?.[1]?.trim() ?? null;
}

function parseSimpleFollowTradeHistory(history: string): {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strategy: 'CALL' | 'PUT';
  strikes: number[];
  statedPrice: number | null;
} | null {
  const lines = history.split('\n').reverse();
  for (const line of lines) {
    const word = /\bLong\s+([A-Z]{1,6})\s+\$?(\d{1,5}(?:\.\d+)?)\s+(call|put)s?\s+for\s+\$?(\d+(?:\.\d+)?|\.\d+)/i.exec(line);
    if (word) {
      return {
        symbol: word[1].toUpperCase(),
        direction: 'LONG',
        strategy: word[3].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
        strikes: [Number.parseFloat(word[2])],
        statedPrice: Number.parseFloat(word[4]),
      };
    }

    const compact = /\bLong\s+([A-Z]{1,6})\s+(\d{1,5}(?:\.\d+)?)([cp])\b(?:\s+\S+)?(?:\s+(?:@|for)\s+\$?(\d+(?:\.\d+)?|\.\d+))?/i.exec(line);
    if (compact) {
      return {
        symbol: compact[1].toUpperCase(),
        direction: 'LONG',
        strategy: compact[3].toLowerCase() === 'c' ? 'CALL' : 'PUT',
        strikes: [Number.parseFloat(compact[2])],
        statedPrice: compact[4] ? Number.parseFloat(compact[4]) : null,
      };
    }
  }
  return null;
}

async function trySinglePositionExit(
  parse: ParseResult,
  ctx: OrchestratorContext,
): Promise<ParseResult | null> {
  if (parse.hasCanonicalMatch || parse.isHardSkip || !parse.symbol) return null;
  if (parse.action !== 'CLOSE' && parse.action !== 'TRIM') return null;
  if (parse.complexityFlags.has('multi_ticker')) return null;
  if (hasExitLoopDisqualifier(ctx.message.cleanText)) return null;

  const positions = await ctx.positions.getPositions(parse.symbol);
  if (positions.length !== 1) return null;

  const position = positions[0];
  return {
    ...parse,
    strategy: parse.strategy ?? position.strategy,
    direction: parse.direction ?? position.direction,
    ruleId: 'history-loop.single-position-exit',
    routeReason: 'non-canonical exit matched exactly one open position',
  };
}

function hasExitLoopDisqualifier(cleanText: string): boolean {
  return /\b(?:expired?|expire\s+worthless|will\s+expire|offering|trying\s+to|looking\s+to|plan\s+to|would\s+like|if\s+)\b/i.test(cleanText);
}

// ── Emit orchestrator events ──────────────────────────────────────────────────

async function emitOrchestratorEvents(
  env: OrchestratorEnv,
  message: Message,
  result: OrchestratorResult,
  serializedParse: SerializedParseResult,
  route: 'deterministic' | 'llm' | 'hard-skip',
): Promise<void> {
  // Always emit PARSED — include route so timeline knows how we got here
  await env.emitter.emit('PARSED', {}, { ...serializedParse, route });

  // For EXECUTE, emit SIGNAL_RESOLVED per signal
  // Non-EXECUTE outcomes: SETTLED is emitted by the caller (runner), not here
  if (result.outcome === 'EXECUTE') {
    for (let i = 0; i < result.signals.length; i++) {
      const signal = result.signals[i];
      await env.emitter.emit('SIGNAL_RESOLVED', {
        signalIndex: i,
        tradeId: signal.tradeId ?? undefined,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      }, { ...signal });
    }
  }

  // Record decision for tracking (LLM path records its own with richer detail)
  if (route !== 'llm') {
    const reason = result.outcome === 'SKIP' || result.outcome === 'MANUAL_REVIEW'
      ? result.reason
      : serializedParse.routeReason;
    await writeIntent({
      messageId: message.id,
      model: env.agent.identity.model,
      route: route as IntentRoute,
      decision: result.outcome,
      reasoning: reason,
    });
  }
}

// ── Serialize ParseResult for snapshot ────────────────────────────────────────

function serializeParseResult(parse: ParseResult): SerializedParseResult {
  const { complexityFlags, targetStrategy: _drop, ...rest } = parse;
  // Write-time validation: catches schema drift at the source. Every orchestrator
  // branch funnels through this helper, so every `run_decisions.snapshot.parseResult`
  // payload is guaranteed to match SerializedParseResultSchema.
  return SerializedParseResultSchema.parse({
    ...rest,
    complexityFlags: Array.from(complexityFlags),
  });
}

// ── Info-level summary log ────────────────────────────────────────────────────

function logResult(ctx: OrchestratorContext, parse: ParseResult, result: OrchestratorResult): void {
  const id = `[${ctx.message.id}]`;
  const who = ctx.message.author;

  if (result.outcome === 'SKIP') {
    log.info(`${id} ${who} | SKIP ${result.reason}\n  msg: ${ctx.message.cleanText}`);
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
    const why = result.llmReasoning ? `\n  why: ${truncateLine(result.llmReasoning, 300)}` : '';
    log.info(`${id} ${who} | ${head}${detail} | → EXECUTE ${result.signals.length} signal(s) ${legCount} leg(s)${why}\n  msg: ${ctx.message.cleanText}`);
  } else {
    const why = result.llmReasoning && result.llmReasoning !== result.reason
      ? `\n  why: ${truncateLine(result.llmReasoning, 300)}` : '';
    log.info(`${id} ${who} | ${head}${detail} | → MANUAL_REVIEW: ${result.reason}${why}\n  msg: ${ctx.message.cleanText}`);
  }
}

function truncateLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
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
    const legs: Leg[] = pos.legs.map(leg => buildReversalLeg(leg, pos.symbol, leg.quantity));
    signals.push({
      action: 'CLOSE',
      orderType: legs.length > 1 ? 'SPREAD' : 'SINGLE',
      legs,
      tradeId: pos.id,
    });
  }

  return { outcome: 'EXECUTE', signals };
}
