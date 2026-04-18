/**
 * Synchronous message parser for the orchestrator.
 *
 * Zero I/O. Uses ONLY structural metadata from the Discord envelope (badges,
 * `symbols[]`) and whole-message canonical-trade template matching. No prose
 * keyword scanning — "these PDSes look good" would mis-classify as a PDS trade,
 * so any field populated by keyword presence alone has been removed.
 *
 * Anything not derivable from structural metadata + a template match stays null
 * and the LLM path handles it.
 */

import type { Direction, Strategy, TradeAction } from '@/lib/enums.js';
import type {
  OrchestratorContext,
  ParseResult,
  StrikeSelection,
  ComplexityFlag,
} from './types.js';
import { matchCanonicalTrade } from './canonical-trade.js';

export function parseMessage(ctx: OrchestratorContext): ParseResult {
  const { cleanText, badges, symbols } = ctx.message;

  const hasExitBadge = badges.includes('Exit');
  const hasLongBadge = badges.includes('Long');
  const hasShortBadge = badges.includes('Short');

  const complexityFlags = new Set<ComplexityFlag>();

  // ── Hard skip: badges with no trade badge (Annotation, Note, etc.) ────────
  const TRADE_BADGES = new Set(['Long', 'Short', 'Exit']);
  const hasNonTradeBadge = badges.length > 0 && badges.some(b => !TRADE_BADGES.has(b));
  const hasTradeBadge = badges.some(b => TRADE_BADGES.has(b));
  if (hasNonTradeBadge && !hasTradeBadge) {
    return hardSkip(`non-trade badge: ${badges.filter(b => !TRADE_BADGES.has(b)).join(', ')}`, complexityFlags);
  }

  // ── Complexity: structural flags only ─────────────────────────────────────
  if (symbols.length > 1) complexityFlags.add('multi_ticker');
  if (hasExitBadge && (hasLongBadge || hasShortBadge)) complexityFlags.add('mixed_action');

  // ── Symbol ────────────────────────────────────────────────────────────────
  const symbol = symbols.length > 0 ? symbols[0] : null;

  // ── Direction (badge-only; LLM handles "sold to open" and bias nuance) ────
  let direction: Direction | null = null;
  if (hasLongBadge && !hasShortBadge) direction = 'LONG';
  else if (hasShortBadge && !hasLongBadge) direction = 'SHORT';

  // ── Action (badge-only) ───────────────────────────────────────────────────
  let action: TradeAction | null = null;
  if (hasExitBadge) action = 'CLOSE';
  else if (hasLongBadge || hasShortBadge) action = 'OPEN';

  // ── Hard skip: no symbol AND no trade action ──────────────────────────────
  if (symbol === null && action === null) {
    return hardSkip('no symbol and no action', complexityFlags);
  }

  // ── Whole-message canonical template matching ────────────────────────────
  let strategy: Strategy | null = null;
  let strikes: number[] | null = null;
  let expiry: string | null = null;
  let price: number | null = null;

  if (action !== null && symbol !== null) {
    const match = matchCanonicalTrade(cleanText, symbol, action);
    if (match) {
      strategy = match.strategy;
      strikes = match.strikes;
      expiry = match.expiry;
      price = match.statedPrice;
      if (direction == null && match.direction != null) direction = match.direction;
    }
  }

  return {
    action,
    symbol,
    direction,
    strategy,
    strikes,
    expiryHint: expiry,
    premiumHint: price,
    exitPercent: null,
    targetStrategy: null,
    isLotto: false,
    isStrangle: false,
    isHardSkip: false,
    skipReason: null,
    complexityFlags,
  };
}

// ── strikesFromParse ──────────────────────────────────────────────────────────

/**
 * Determine the strike selection method from a ParseResult.
 * Only used when a deterministic open-path can resolve strikes; otherwise
 * the LLM has already provided them.
 */
export function strikesFromParse(parse: ParseResult): StrikeSelection {
  if (parse.strikes !== null && parse.strikes.length > 0) {
    return { method: 'explicit', strikes: parse.strikes };
  }
  if (parse.premiumHint !== null) {
    return { method: 'premium_match', statedPremium: parse.premiumHint };
  }
  return { method: 'atm' };
}

function hardSkip(reason: string, complexityFlags: Set<ComplexityFlag>): ParseResult {
  return {
    action: null,
    symbol: null,
    direction: null,
    strategy: null,
    strikes: null,
    expiryHint: null,
    premiumHint: null,
    exitPercent: null,
    targetStrategy: null,
    isLotto: false,
    isStrangle: false,
    isHardSkip: true,
    skipReason: reason,
    complexityFlags,
  };
}
