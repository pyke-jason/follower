/**
 * Synchronous message parser for the orchestrator.
 *
 * Zero I/O. Applies deterministic rules to the message text and badge array
 * to produce a ParseResult. This is the first stage of the orchestrator
 * pipeline; subsequent stages handle async resolution (symbol lookup, strike
 * selection, expiry resolution).
 */

import type { Direction, Strategy, TradeAction } from '@/lib/enums.js';
import type {
  OrchestratorContext,
  ParseResult,
  StrikeSelection,
  ComplexityFlag,
} from './types.js';

// ── Symbol blacklist (hard skip — add tickers here to suppress all signals) ───
const BLACKLISTED_SYMBOLS = new Set(['PLTR']);

// ── Hard-skip patterns ────────────────────────────────────────────────────────

const PAPER_TRADE_RE = /\bpaper\b/i;
// Futures tickers MUST have a leading slash ("/ES", "/NQ") to distinguish from
// equity tickers that happen to share the same letters (ES = Eversource Energy,
// NQ rarely, etc.). Bare "ES 67.06" is Eversource stock, not /ES futures.
const FUTURES_RE = /\/(ES|NQ|RTY|YM|MES|MNQ|M2K|CL|MCL|GC|MGC|ZN|ZB|6E)\b|\b(futures?|futs?)\b/i;

// ── Strategy detection patterns (deterministic acronyms only) ─────────────────

const CDS_RE = /\bcds\b|call debit spread/i;
const PCS_RE = /\bpcs\b|put credit spread|bull(?:ish)?\s+put\s+spread/i;
const PDS_RE = /\bpds\b|put debit spread/i;
const STRANGLE_RE = /\bstrangle\b|\bstraddle\b/i;

// ── Text extractors (populate Signal fields for classifier accuracy) ─────────
// These run zero-I/O on cleanText. Extraction is conservative — prefer null
// over a wrong value. The LLM path will still handle ambiguous cases.

const LOTTO_RE = /\b(?:lotto|lottos|yolo)\b/i;

// Strike + optionType from e.g. "160c", "170.5p", "$225c", " 50 P"
const OPT_STRIKE_RE = /(?:^|\s|\$|\W)(\d{1,4}(?:\.\d+)?)\s*([cp])(?=\b|\s|[^a-z])/gi;

// Spread strikes: "84/83" "330/327.5" (both ≥ 20, not a date)
const SPREAD_STRIKES_RE = /\b(\d{2,4}(?:\.\d+)?)\/(\d{2,4}(?:\.\d+)?)\b/;

// Price: "@ $.54", "@ 3.20", "for $0.33", "@ 0.85"
const PRICE_AT_RE = /@\s*\$?(\.?\d+(?:\.\d+)?)/;
const PRICE_FOR_RE = /\bfor\s+\$(\.?\d+(?:\.\d+)?)/i;

// Exit percent: "25%", "1/2", "half", "rest", "all out", "last (candle|leg)"
const PCT_RE = /(\d{1,3})\s*%/;
const HALF_RE = /\bhalf\b/i;
const FULL_RE = /\b(?:all\s+out|last\s+(?:candle|leg)|closed\s+out|fully)\b/i;

// Expiry: MM/DD / MM-DD / "MMM DD" / "DD MMM" / keyword. Intent-level (no year).
const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const EXPIRY_SLASH_RE = /(?:^|\s|\()(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?=\s|\)|$|[^0-9])/;
const EXPIRY_WORD_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:uary|ruary|il|ember|ober)?\b\s*(\d{1,2})?|(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:uary|ruary|il|ember|ober)?/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip parenthetical content for strategy detection. */
function stripParenthetical(text: string): string {
  return text.replace(/\([^)]*\)/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ── Strategy detection (acronym-only) ────────────────────────────────────────

function detectStrategyAcronyms(
  text: string,
): { strategy: Strategy | null; directionFromStrategy: Direction | null } {
  // Direction for spreads = trader's bias (bullish/bearish), not leg side.
  // CDS/PCS → LONG (bullish view); PDS/CCS → SHORT (bearish view).
  if (CDS_RE.test(text)) return { strategy: 'CDS', directionFromStrategy: 'LONG' };
  if (PCS_RE.test(text)) return { strategy: 'PCS', directionFromStrategy: 'LONG' };
  if (PDS_RE.test(text)) return { strategy: 'PDS', directionFromStrategy: 'SHORT' };
  return { strategy: null, directionFromStrategy: null };
}

// Extract strikes + (if single-leg) the option type from Nc/Np patterns.
// Returns `{ strikes, optionStrategy }` — optionStrategy is 'CALL' or 'PUT' when all
// matches share the same suffix, else null (mixed, let LLM decide).
function extractOptionDetails(text: string): { strikes: number[] | null; strategy: Strategy | null } {
  const matches = Array.from(text.matchAll(OPT_STRIKE_RE));
  if (matches.length === 0) {
    const spread = SPREAD_STRIKES_RE.exec(text);
    if (spread) {
      const a = parseFloat(spread[1]);
      const b = parseFloat(spread[2]);
      if (a >= 20 && b >= 20 && Math.abs(a - b) < a * 0.5) {
        return { strikes: [a, b].sort((x, y) => x - y), strategy: null };
      }
    }
    return { strikes: null, strategy: null };
  }
  const types = new Set(matches.map((m) => m[2].toLowerCase()));
  const strikes = [...new Set(matches.map((m) => parseFloat(m[1])))].sort((a, b) => a - b);
  let strategy: Strategy | null = null;
  if (types.size === 1) {
    strategy = [...types][0] === 'c' ? 'CALL' : 'PUT';
  }
  return { strikes, strategy };
}

function extractPrice(text: string): number | null {
  const at = PRICE_AT_RE.exec(text);
  if (at) {
    const raw = at[1].startsWith('.') ? `0${at[1]}` : at[1];
    const n = parseFloat(raw);
    if (n > 0 && n < 100000) return n;
  }
  const forP = PRICE_FOR_RE.exec(text);
  if (forP) {
    const raw = forP[1].startsWith('.') ? `0${forP[1]}` : forP[1];
    const n = parseFloat(raw);
    if (n > 0 && n < 100000) return n;
  }
  return null;
}

function extractExitPercent(text: string): number | null {
  const pct = PCT_RE.exec(text);
  if (pct) {
    const n = parseInt(pct[1], 10);
    if (n > 0 && n <= 100) return n / 100;
  }
  if (HALF_RE.test(text)) return 0.5;
  if (FULL_RE.test(text)) return 1;
  return null;
}

function extractExpiry(text: string): string | null {
  const slash = EXPIRY_SLASH_RE.exec(text);
  if (slash) {
    const m = parseInt(slash[1], 10);
    const d = parseInt(slash[2], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
    }
  }
  const word = EXPIRY_WORD_RE.exec(text);
  if (word) {
    const mon = (word[1] ?? word[4] ?? '').toLowerCase();
    const dayStr = word[2] ?? word[3];
    if (mon && MONTH_MAP[mon] && dayStr) {
      const m = MONTH_MAP[mon];
      const d = parseInt(dayStr, 10);
      if (d >= 1 && d <= 31) return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
    }
  }
  if (/\btoday\b/i.test(text)) return 'today';
  if (/\btomorrow['’]?s?\b/i.test(text)) return 'tomorrow';
  if (/\bovernight\b/i.test(text)) return 'overnight';
  return null;
}

// ── Main parse function ───────────────────────────────────────────────────────

/**
 * Parse a Discord message synchronously.
 *
 * Applies deterministic structural rules to `cleanText` and `badges`. Anything
 * not derivable from badges or hard-coded acronyms is left null for the LLM.
 */
export function parseMessage(ctx: OrchestratorContext): ParseResult {
  const { cleanText, badges, symbols } = ctx.message;

  const hasExitBadge = badges.includes('Exit');
  const hasLongBadge = badges.includes('Long');
  const hasShortBadge = badges.includes('Short');

  const complexityFlags = new Set<ComplexityFlag>();

  // ── Hard skip checks ───────────────────────────────────────────────────────

  if (PAPER_TRADE_RE.test(cleanText)) {
    return hardSkip('paper trade', complexityFlags);
  }

  if (FUTURES_RE.test(cleanText)) {
    return hardSkip('futures', complexityFlags);
  }

  // Long+Short badges without strangle keyword → calendar/time spread
  if (hasLongBadge && hasShortBadge && !STRANGLE_RE.test(cleanText)) {
    return hardSkip('calendar/time spread not supported', complexityFlags);
  }

  // Non-trade badge whitelist — unknown badges without a trade badge → hard skip
  const TRADE_BADGES = new Set(['Long', 'Short', 'Exit']);
  const hasNonTradeBadge = badges.length > 0 && badges.some(b => !TRADE_BADGES.has(b));
  const hasTradeBadge = badges.some(b => TRADE_BADGES.has(b));
  if (hasNonTradeBadge && !hasTradeBadge) {
    return hardSkip(`non-trade badge: ${badges.filter(b => !TRADE_BADGES.has(b)).join(', ')}`, complexityFlags);
  }

  // ── Complexity: structural flags only ─────────────────────────────────────

  if (symbols.length > 1) complexityFlags.add('multi_ticker');

  // Mixed action: Exit badge co-present with Long/Short badge.
  if (hasExitBadge && (hasLongBadge || hasShortBadge)) {
    complexityFlags.add('mixed_action');
  }

  // ── Symbol ────────────────────────────────────────────────────────────────

  const symbol = symbols.length > 0 ? symbols[0] : null;

  // ── Symbol blacklist ─────────────────────────────────────────────────────
  if (symbol && BLACKLISTED_SYMBOLS.has(symbol)) {
    return hardSkip(`blacklisted symbol: ${symbol}`, complexityFlags);
  }

  // ── Strangle (badge composition + STRANGLE_RE) ────────────────────────────

  const isStrangle =
    STRANGLE_RE.test(cleanText) && (hasLongBadge || hasShortBadge || hasExitBadge);

  // ── Strategy detection (acronym-only, paren-stripped) ─────────────────────

  const primaryText = stripParenthetical(cleanText);
  const { strategy, directionFromStrategy } = detectStrategyAcronyms(primaryText);

  // ── Direction (strategy first, badge fallback) ───────────────────────────

  let direction: Direction | null = directionFromStrategy;
  if (direction === null) {
    if (hasLongBadge && !hasShortBadge) direction = 'LONG';
    else if (hasShortBadge && !hasLongBadge) direction = 'SHORT';
  }

  // ── Action (badge-only) ──────────────────────────────────────────────────

  let action: TradeAction | null = null;
  if (hasExitBadge) {
    action = 'CLOSE';
  } else if (hasLongBadge || hasShortBadge) {
    action = 'OPEN';
  }

  // Hard-skip: no symbol and no action → pure commentary
  if (symbol === null && action === null) {
    return hardSkip('no symbol and no action', complexityFlags);
  }

  // ── Deterministic field extraction ────────────────────────────────────────
  const isLotto = LOTTO_RE.test(cleanText);
  const { strikes: extractedStrikes, strategy: optStrategy } = extractOptionDetails(cleanText);
  const extractedPrice = extractPrice(cleanText);
  const extractedExpiry = extractExpiry(cleanText);
  const extractedExitPct = action === 'CLOSE' ? extractExitPercent(cleanText) : null;

  // Override strategy if Nc/Np pattern gave us CALL/PUT. Don't override spread acronyms.
  let finalStrategy: Strategy | null = strategy;
  if (finalStrategy == null && optStrategy != null) finalStrategy = optStrategy;

  return {
    action,
    symbol,
    direction,
    strategy: finalStrategy,
    strikes: extractedStrikes,
    expiryHint: extractedExpiry,
    premiumHint: extractedPrice,
    exitPercent: extractedExitPct,
    targetStrategy: null,
    isLotto,
    isStrangle,
    isHardSkip: false,
    skipReason: null,
    complexityFlags,
  };
}

// ── strikesFromParse ──────────────────────────────────────────────────────────

/**
 * Determine the strike selection method from a ParseResult.
 *
 * Priority order:
 * 1. Explicit strikes found in text → 'explicit'
 * 2. Lotto/yolo → delta 0.70 (speculative near-the-money buy)
 * 3. No strikes but premium stated → 'premium_match'
 * 4. Fallback → 'atm'
 */
export function strikesFromParse(parse: ParseResult): StrikeSelection {
  if (parse.strikes !== null && parse.strikes.length > 0) {
    return { method: 'explicit', strikes: parse.strikes };
  }

  if (parse.isLotto) {
    return { method: 'delta', target: 0.70, bias: 'nearest' };
  }

  if (parse.premiumHint !== null) {
    return { method: 'premium_match', statedPremium: parse.premiumHint };
  }

  return { method: 'atm' };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
