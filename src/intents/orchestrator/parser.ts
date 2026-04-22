/**
 * Synchronous message parser for the orchestrator.
 *
 * Zero I/O. Uses structural metadata from the Discord envelope (badges,
 * `symbols[]`), a narrow no-badge trade-cue gate for LLM routing, and
 * whole-message canonical-trade template matching. The cue gate only decides
 * skip vs LLM; it does not populate trade fields from prose.
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

const NO_BADGE_ACTION_CUE_RE =
  /\b(?:bought|sold|shorting|short|long|longed|added|adding|add|trim|trimmed|exit|exiting|closed|close|re-?entered|re-?entering|took|taking)\b|\b(?:back\s+in|in\s+since|scal(?:ing|e)\s+out|sclaing\s+out|all\s+out|out\s+of|in\s+them)\b/i;
const NO_BADGE_SPREAD_CUE_RE =
  /\b(?:pcs|pds|cds|ccs)\b|\b\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?(?:\s*(?:pcs|pds|cds|ccs))?\b/i;
const NO_BADGE_OPTION_CUE_RE =
  /\b\d+(?:\.\d+)?\s*[cp]\b|\b(?:calls?|puts?)\b|\b(?:lotto|yolo)\b/i;
const NO_BADGE_PRICE_SIZE_CUE_RE =
  /\$\s*\d|\b\d+(?:\.\d+)?\b\s*@\s*\$?\s*\d|\bavg\b|\bcredit\b|\bdebit\b|\bshares?\b|\bcontracts?\b|\bexp(?:iry|iring)?\b|\b\d{1,2}[/-]\d{1,2}\b/i;
const NO_BADGE_OPEN_WORD_RE = /\bOPEN\b/i;

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

  if (!hasTradeBadge && !hasNoBadgeTradeCue(cleanText, symbols)) {
    return hardSkip('no trade badge or cue', complexityFlags);
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

function hasNoBadgeTradeCue(cleanText: string, symbols: string[]): boolean {
  if (symbols.length === 0) return false;

  return (
    NO_BADGE_ACTION_CUE_RE.test(cleanText) ||
    NO_BADGE_SPREAD_CUE_RE.test(cleanText) ||
    NO_BADGE_OPTION_CUE_RE.test(cleanText) ||
    NO_BADGE_PRICE_SIZE_CUE_RE.test(cleanText) ||
    NO_BADGE_OPEN_WORD_RE.test(cleanText)
  );
}
