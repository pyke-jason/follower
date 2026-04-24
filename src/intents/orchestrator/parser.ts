/**
 * Synchronous message parser for the orchestrator.
 *
 * Zero I/O. Uses structural metadata from the Discord envelope (badges,
 * `symbols[]`), a narrow no-badge trade-cue gate for hard skips, and
 * whole-message canonical-trade template matching. Deterministic execution is
 * allowed only when the full message matches a canonical trade template.
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
const FOLLOW_TRADE_CUE_RE = /@\w+[\s\S]{0,40}\b(?:same|following|with\s+you|in\s+with\s+you|same\s+trade)\b|\b(?:same\s+trade|following\s+\w+|in\s+with\s+you)\b/i;
const WATCHLIST_SKIP_RE =
  /\b(?:nothing\s+actionable|setting\s+an?\s+alert|set\s+an?\s+alert|watch(?:ing|list)|monitoring|would\s+(?:sell|buy|add|trim|close|short|long)|would\s+like\s+to|looking\s+to|prepared\s+to|trying\s+to|hoping\s+to|plan\s+to|if\s+(?:it|we|this|the\s+(?:stock|market))|can\s+be\s+had\s+for|available\s+at|is\s+priced\s+at|trading\s+at)\b/i;
const PENDING_ORDER_SKIP_RE = /^\s*(?:offering|trying\s+to\s+scratch|have\s+an?\s+offer\s+working)\b/i;
const POSITION_RECAP_SKIP_RE = /\b(?:as\s+a\s+recap|position\s+recap|currently\s+holding|i\s+have\s+an?\b[\s\S]{0,80}\b(?:watching|monitoring))\b/i;

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
  const noBadgeTradeCue = hasNoBadgeTradeCue(cleanText, symbols);
  if (hasNonTradeBadge && !hasTradeBadge) {
    const nonTradeBadges = badges.filter(b => !TRADE_BADGES.has(b)).join(', ');
    return hardSkip(
      `non-trade badge: ${nonTradeBadges}`,
      complexityFlags,
      'hard-skip.non-trade-badge',
      `non-trade badge: ${nonTradeBadges}`,
    );
  }

  if (!hasTradeBadge) {
    const skipRule = matchNoBadgeSkipRule(cleanText, noBadgeTradeCue);
    if (skipRule) {
      return hardSkip(skipRule.reason, complexityFlags, skipRule.ruleId, skipRule.reason);
    }
  }

  if (!hasTradeBadge && !noBadgeTradeCue) {
    return hardSkip('no trade badge or cue', complexityFlags, 'hard-skip.no-trade-cue', 'no trade badge or cue');
  }

  // ── Complexity: structural flags only ─────────────────────────────────────
  if (symbols.length > 1) complexityFlags.add('multi_ticker');
  if (hasExitBadge && (hasLongBadge || hasShortBadge)) complexityFlags.add('mixed_action');
  if (FOLLOW_TRADE_CUE_RE.test(cleanText)) complexityFlags.add('relational');

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
  if (symbol === null && action === null && !FOLLOW_TRADE_CUE_RE.test(cleanText)) {
    return hardSkip('no symbol and no action', complexityFlags, 'hard-skip.no-symbol-action', 'no symbol and no action');
  }

  // ── Whole-message canonical template matching ────────────────────────────
  let strategy: Strategy | null = null;
  let strikes: number[] | null = null;
  let expiry: string | null = null;
  let price: number | null = null;
  let exitPercent: number | null = null;
  let ruleId: string | null = null;
  let routeReason: string | null = null;

  let hasCanonicalMatch = false;

  if (action !== null && symbol !== null) {
    const match = matchCanonicalTrade(cleanText, symbol, action);
    if (match) {
      hasCanonicalMatch = true;
      action = match.action;
      strategy = match.strategy;
      strikes = match.strikes;
      expiry = match.expiry;
      price = match.statedPrice;
      exitPercent = match.exitPercent;
      ruleId = match.ruleId;
      routeReason = match.routeReason;
      if (direction == null && match.direction != null) direction = match.direction;
    }
  }

  if (!hasCanonicalMatch && !hasTradeBadge && symbol !== null) {
    const simple = matchSimpleNoBadgeExecute(cleanText, symbol);
    if (simple) {
      hasCanonicalMatch = true;
      action = simple.action;
      strategy = simple.strategy;
      direction = simple.direction;
      price = simple.statedPrice;
      ruleId = simple.ruleId;
      routeReason = simple.routeReason;
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
    exitPercent,
    targetStrategy: null,
    isLotto: false,
    isStrangle: false,
    hasCanonicalMatch,
    isHardSkip: false,
    skipReason: null,
    ruleId,
    routeReason,
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

function hardSkip(
  reason: string,
  complexityFlags: Set<ComplexityFlag>,
  ruleId: string,
  routeReason: string,
): ParseResult {
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
    hasCanonicalMatch: false,
    isHardSkip: true,
    skipReason: reason,
    ruleId,
    routeReason,
    complexityFlags,
  };
}

function hasNoBadgeTradeCue(cleanText: string, symbols: string[]): boolean {
  if (FOLLOW_TRADE_CUE_RE.test(cleanText)) return true;
  if (symbols.length === 0) return false;

  return (
    NO_BADGE_ACTION_CUE_RE.test(cleanText) ||
    NO_BADGE_SPREAD_CUE_RE.test(cleanText) ||
    NO_BADGE_OPTION_CUE_RE.test(cleanText) ||
    NO_BADGE_PRICE_SIZE_CUE_RE.test(cleanText) ||
    NO_BADGE_OPEN_WORD_RE.test(cleanText)
  );
}

function matchNoBadgeSkipRule(cleanText: string, hasTradeCue: boolean): { ruleId: string; reason: string } | null {
  if (/\bnothing\s+actionable\b/i.test(cleanText)) {
    return { ruleId: 'hard-skip.explicit-not-actionable', reason: 'explicitly says nothing actionable' };
  }
  if (PENDING_ORDER_SKIP_RE.test(cleanText) || /\boffer\s+working\b/i.test(cleanText)) {
    return { ruleId: 'hard-skip.pending-order', reason: 'pending offer/order language, not a fill' };
  }
  if (hasTradeCue) {
    return null;
  }
  if (WATCHLIST_SKIP_RE.test(cleanText)) {
    return { ruleId: 'hard-skip.watchlist-conditional', reason: 'watchlist, alert, conditional, or future-intent language' };
  }
  if (POSITION_RECAP_SKIP_RE.test(cleanText)) {
    return { ruleId: 'hard-skip.position-recap', reason: 'position recap or monitoring language' };
  }
  return null;
}

function matchSimpleNoBadgeExecute(cleanText: string, symbol: string): {
  action: TradeAction;
  strategy: Strategy;
  direction: Direction;
  statedPrice: number | null;
  ruleId: string;
  routeReason: string;
} | null {
  const symbolRe = escapeRegExp(symbol);
  const addedShort = new RegExp(
    `^\\s*added\\s+to\\s+${symbolRe}\\s+short\\b[\\s\\S]*\\bshares?\\b`,
    'i',
  );
  const addedLong = new RegExp(
    `^\\s*added\\s+to\\s+${symbolRe}\\b(?!\\s+short\\b)[\\s\\S]*\\bshares?\\b`,
    'i',
  );
  const price = extractFirstDollarPrice(cleanText);

  if (addedShort.test(cleanText)) {
    return {
      action: 'ADD',
      strategy: 'STOCK',
      direction: 'SHORT',
      statedPrice: price,
      ruleId: 'simple-exec.added-to-short-stock-shares',
      routeReason: 'no-badge add to short stock with shares keyword',
    };
  }

  if (addedLong.test(cleanText)) {
    return {
      action: 'ADD',
      strategy: 'STOCK',
      direction: 'LONG',
      statedPrice: price,
      ruleId: 'simple-exec.added-to-long-stock-shares',
      routeReason: 'no-badge add to stock with shares keyword',
    };
  }

  return null;
}

function extractFirstDollarPrice(text: string): number | null {
  const match = /(?:avg\.?(?:\s+is)?(?:\s+now)?|at|@)\s+\$?(\d{1,5}(?:\.\d{1,4})?)/i.exec(text)
    ?? /\$(\d{1,5}(?:\.\d{1,4})?)/.exec(text);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
