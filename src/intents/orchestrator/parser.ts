/**
 * Synchronous message parser for the orchestrator.
 *
 * Zero I/O. Applies deterministic rules to the message text and badge array
 * to produce a ParseResult. This is the first stage of the orchestrator
 * pipeline; subsequent stages handle async resolution (symbol lookup, strike
 * selection, expiry resolution).
 */

import type { Direction, Strategy } from '../../lib/enums.js';
import type {
  OrchestratorContext,
  ParseResult,
  StrikeSelection,
  ComplexityFlag,
  Action,
} from './types.js';

// ── Hard-skip patterns ────────────────────────────────────────────────────────

const PAPER_TRADE_RE = /\bpaper\b/i;
const FUTURES_RE = /\b(ES|NQ|RTY|YM)[\s/]|\b(futures?|futs?)\b/i;

// ── Strategy detection patterns ───────────────────────────────────────────────

const CDS_RE = /\bcds\b|call debit spread/i;
const PCS_RE = /\bpcs\b|put credit spread/i;
const PDS_RE = /\bpds\b|put debit spread/i;
const LEAP_RE = /\bleaps?\b/i;
const LOTTO_RE = /\blotto\b|\byolo\b/i;
const STRANGLE_RE = /\bstrangle\b|\bstraddle\b/i;
// Spread keywords — used to disambiguate naked vs spread when "calls"/"puts" present
const SPREAD_KW_RE = /\bcds\b|\bpcs\b|\bpds\b|call debit spread|put credit spread|put debit spread|\bspread\b/i;
const CALLS_RE = /\bcalls?\b/i;
const PUTS_RE = /\bputs?\b/i;
const STOCK_RE = /\bstocks?\b|\bshares?\b/i;

// ── Direction-override verb patterns ─────────────────────────────────────────

const SOLD_RE = /\bsold\b/i;
// "sold out" / "sold to close" is an exit, not sell-to-open — handled in action logic
const WROTE_WRITING_RE = /\b(wrote|writing)\b/i;
const BOUGHT_BUYING_RE = /\b(bought|buying)\b/i;

// ── Strike extraction ─────────────────────────────────────────────────────────

const SLASH_PAIR_RE = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/;
// Single strike near option type keyword or bare dollar prefix
const STRIKE_NEAR_OPTION_RE = /\$?(\d{2,5}(?:\.\d+)?)\s*(?:calls?|puts?|[cp]\b)/i;
const DOLLAR_STRIKE_RE = /\$(\d{2,5}(?:\.\d+)?)/g;

// ── Expiry hint extraction (ordered: most-specific first) ─────────────────────

const EXPIRY_0DTE_RE = /\b0\s*-?\s*dte\b/i;
const EXPIRY_OVERNIGHT_RE = /\bovernight\b/i;
const EXPIRY_NEXT_FRIDAY_RE = /\bnext\s+friday\b/i;
const EXPIRY_NEXT_WEEK_RE = /\bnext\s+week\b/i;
const EXPIRY_THIS_WEEK_RE = /\bthis\s+week\b/i;
const EXPIRY_SLASH_DATE_RE = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/;
const EXPIRY_MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\(?\s*(\d{1,2})\s*\)?/i;
const EXPIRY_BARE_MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;

// ── Premium hint extraction ───────────────────────────────────────────────────

// Matches patterns like "for $2.10", "for .63", "at $1.20", "$0.63 credit", "2.10 debit"
// We intentionally require a trigger word or explicit $ before the number to avoid
// accidentally matching strike prices.
const PREMIUM_RE =
  /(?:for\s+\$?|at\s+\$?|\$)(\d{1,4}(?:\.\d+)?)(?:\s*(?:credit|debit|cr|db))?|(\d{1,4}(?:\.\d+)?)\s+(?:credit|debit|cr|db)/i;

const PREMIUM_MIN = 0.01;
const PREMIUM_MAX = 500;

// ── Exit-percent / fraction patterns ─────────────────────────────────────────

const FRACTION_HALF_RE = /\bhalf\b|1\s*\/\s*2/i;
const FRACTION_THIRD_RE = /\bthird\b|1\s*\/\s*3/i;
const FRACTION_QUARTER_RE = /\bquarter\b|1\s*\/\s*4/i;
const FRACTION_TWO_THIRDS_RE = /\btwo\s+thirds?\b|2\s*\/\s*3/i;
const PERCENT_RE = /(\d{1,3})\s*%/;

// ── Exit-verb patterns (soft detection without badge) ─────────────────────────

const EXIT_VERB_RE = /\b(exit(?:ing|ed)?|clos(?:ed|ing)|exiting|took profits?|stopped out|sold out)\b/i;

// ── LEG_OFF target patterns ───────────────────────────────────────────────────

const LEGOFF_RE = /\bleg\s+off\b|\bhold\s+straight\b|\bkeep\s+the\b/i;
const KEEP_CALLS_RE = /\b(hold\s+straight\s+calls?|keep\s+the\s+calls?)\b/i;
const KEEP_PUTS_RE = /\b(hold\s+straight\s+puts?|keep\s+the\s+puts?)\b/i;

// ── Relational patterns ───────────────────────────────────────────────────────

const RELATIONAL_RE = /\b(following|same as|from yesterday|ty\s+\w+|thanks?\s+\w+|via\s+\w+|and also|adding to)\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Extract a premium value from the text.
 * Returns the first match that falls within the sanity range, or null.
 */
function extractPremium(text: string): number | null {
  const m = PREMIUM_RE.exec(text);
  if (!m) return null;
  const raw = m[1] ?? m[2];
  if (!raw) return null;
  const val = parseFloat(raw);
  if (!isFinite(val) || val < PREMIUM_MIN || val > PREMIUM_MAX) return null;
  return val;
}

/**
 * Extract exit percent (0.0–1.0) from text for TRIM detection.
 * Returns null if no fraction or percent detected.
 */
function extractExitPercent(text: string): number | null {
  if (FRACTION_TWO_THIRDS_RE.test(text)) return 2 / 3;
  if (FRACTION_HALF_RE.test(text)) return 0.5;
  if (FRACTION_THIRD_RE.test(text)) return 1 / 3;
  if (FRACTION_QUARTER_RE.test(text)) return 0.25;
  const pm = PERCENT_RE.exec(text);
  if (pm) {
    const pct = parseInt(pm[1], 10);
    if (pct > 0 && pct <= 100) return pct / 100;
  }
  return null;
}

/**
 * Extract explicit strikes from text.
 * Priority: slash pair > single strike near option keyword > dollar-prefixed.
 */
function extractStrikes(text: string): number[] | null {
  // Slash pair (spread strikes): "180/185", "68/67"
  const pairM = SLASH_PAIR_RE.exec(text);
  if (pairM) {
    const s1 = parseFloat(pairM[1]);
    const s2 = parseFloat(pairM[2]);
    if (isFinite(s1) && isFinite(s2)) return [s1, s2];
  }

  // Single strike adjacent to option type word
  const nearM = STRIKE_NEAR_OPTION_RE.exec(text);
  if (nearM) {
    const s = parseFloat(nearM[1]);
    if (isFinite(s) && s >= 1) return [s];
  }

  // Dollar-prefixed standalone: "$580", "$180"
  const dollarHits: number[] = [];
  let dm: RegExpExecArray | null;
  const dollarRe = new RegExp(DOLLAR_STRIKE_RE.source, 'gi');
  while ((dm = dollarRe.exec(text)) !== null) {
    const v = parseFloat(dm[1]);
    if (isFinite(v) && v >= 1) dollarHits.push(v);
  }
  if (dollarHits.length > 0) return dollarHits;

  return null;
}

/**
 * Extract the expiry hint string from text. Returns the most-specific match.
 */
function extractExpiryHint(text: string, isLotto: boolean): string | null {
  if (LEAP_RE.test(text)) return 'LEAP';
  if (EXPIRY_0DTE_RE.test(text) || isLotto) return '0DTE';
  if (EXPIRY_OVERNIGHT_RE.test(text)) return 'overnight';
  if (EXPIRY_NEXT_FRIDAY_RE.test(text)) return 'next friday';
  if (EXPIRY_NEXT_WEEK_RE.test(text)) return 'next week';
  if (EXPIRY_THIS_WEEK_RE.test(text)) return 'this week';

  const slashM = EXPIRY_SLASH_DATE_RE.exec(text);
  if (slashM) {
    const [full] = slashM;
    return full;
  }

  const mdM = EXPIRY_MONTH_DAY_RE.exec(text);
  if (mdM) return `${mdM[1]} ${mdM[2]}`;

  const bmM = EXPIRY_BARE_MONTH_RE.exec(text);
  if (bmM) return bmM[1].toLowerCase();

  return null;
}

// ── Main parse function ───────────────────────────────────────────────────────

/**
 * Parse a Discord message synchronously.
 *
 * Applies deterministic rules to `cleanText` and `badges` to derive as many
 * fields as possible without I/O. All uncertain fields are left null for
 * downstream resolution.
 */
export function parseMessage(ctx: OrchestratorContext): ParseResult {
  const { cleanText, badges, symbols } = ctx;

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

  // ── Complexity: multi-ticker ───────────────────────────────────────────────

  if (symbols.length > 1) complexityFlags.add('multi_ticker');

  // ── Complexity: relational ─────────────────────────────────────────────────

  if (RELATIONAL_RE.test(cleanText)) complexityFlags.add('relational');

  // ── Complexity: mixed action ───────────────────────────────────────────────

  if (hasExitBadge && (hasLongBadge || hasShortBadge)) {
    complexityFlags.add('mixed_action');
  }

  // ── Symbol ────────────────────────────────────────────────────────────────

  const symbol = symbols.length > 0 ? symbols[0] : null;

  // ── Lotto/Yolo flag (affects strategy, direction, expiry) ─────────────────

  const isLotto = LOTTO_RE.test(cleanText);

  // ── Strangle ──────────────────────────────────────────────────────────────

  const isStrangle = hasLongBadge && hasShortBadge && STRANGLE_RE.test(cleanText);

  // ── Strategy detection ────────────────────────────────────────────────────

  let strategy: Strategy | null = null;
  let directionFromStrategy: Direction | null = null;

  if (CDS_RE.test(cleanText)) {
    strategy = 'CDS';
    directionFromStrategy = 'LONG';
  } else if (PCS_RE.test(cleanText)) {
    // PCS normalizes to PDS SHORT
    strategy = 'PDS';
    directionFromStrategy = 'SHORT';
  } else if (PDS_RE.test(cleanText)) {
    strategy = 'PDS';
    directionFromStrategy = 'LONG';
  } else if (LEAP_RE.test(cleanText)) {
    strategy = 'CALL';
    directionFromStrategy = 'LONG';
  } else if (isLotto) {
    // Lotto with "calls" → CALL; otherwise PUT (more common lotto play)
    strategy = CALLS_RE.test(cleanText) ? 'CALL' : 'PUT';
    directionFromStrategy = 'LONG';
  } else if (STOCK_RE.test(cleanText)) {
    strategy = 'STOCK';
    directionFromStrategy = null; // badge-derived below
  } else if (CALLS_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)) {
    strategy = 'CALL';
    directionFromStrategy = 'LONG';
  } else if (PUTS_RE.test(cleanText) && !SPREAD_KW_RE.test(cleanText)) {
    strategy = 'PUT';
    directionFromStrategy = 'LONG';
  }

  // ── Direction derivation ──────────────────────────────────────────────────

  let direction: Direction | null = directionFromStrategy;

  if (isLotto) {
    // Lotto always overrides everything
    direction = 'LONG';
  } else if (strategy === 'STOCK') {
    // Badge-derived for stocks
    if (hasLongBadge && !hasShortBadge) direction = 'LONG';
    else if (hasShortBadge && !hasLongBadge) direction = 'SHORT';
    else direction = null; // ambiguous — leave for LLM
    // Authoritative verbs override badges for stock too
    if (BOUGHT_BUYING_RE.test(cleanText)) direction = 'LONG';
    if (WROTE_WRITING_RE.test(cleanText)) direction = 'SHORT';
    if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText)) direction = 'SHORT';
  } else if (strategy === 'CALL' || strategy === 'PUT') {
    // For naked options: default LONG unless sell verbs present
    direction = 'LONG';
    if (WROTE_WRITING_RE.test(cleanText)) direction = 'SHORT';
    // "sold" is ambiguous (could be exit) — only override if we're in OPEN context
    // and not clearly an exit message
    if (SOLD_RE.test(cleanText) && !hasExitBadge && !EXIT_VERB_RE.test(cleanText)) {
      direction = 'SHORT';
    }
    if (BOUGHT_BUYING_RE.test(cleanText)) direction = 'LONG';
  }
  // For CDS/PDS: directionFromStrategy already set definitively; don't override

  // ── Action determination ──────────────────────────────────────────────────

  let action: Action | null = null;
  let exitPercent: number | null = null;
  let targetStrategy: Strategy | null = null;

  if (hasExitBadge) {
    // Check for LEG_OFF first (hold straight / keep the calls or puts)
    if (LEGOFF_RE.test(cleanText)) {
      action = 'LEG_OFF';
      if (KEEP_CALLS_RE.test(cleanText)) targetStrategy = 'CALL';
      else if (KEEP_PUTS_RE.test(cleanText)) targetStrategy = 'PUT';
    } else {
      // Check for TRIM (fraction/percent)
      exitPercent = extractExitPercent(cleanText);
      if (exitPercent !== null) {
        action = 'TRIM';
      } else {
        action = 'CLOSE';
      }
    }
  } else if (hasLongBadge || hasShortBadge) {
    // Non-exit badge present → opening
    action = 'OPEN';
  } else {
    // No badge — soft detection from verbs
    if (EXIT_VERB_RE.test(cleanText) && symbol !== null) {
      // Only set CLOSE when we have a ticker too (higher confidence)
      const exitPct = extractExitPercent(cleanText);
      if (exitPct !== null) {
        exitPercent = exitPct;
        action = 'TRIM';
      } else {
        action = 'CLOSE';
      }
    } else if (BOUGHT_BUYING_RE.test(cleanText) || /\b(adding|opened)\b/i.test(cleanText)) {
      action = 'OPEN';
    } else if (WROTE_WRITING_RE.test(cleanText)) {
      action = 'OPEN';
    }
    // Otherwise leave null — needs LLM
  }

  // ── Strikes ───────────────────────────────────────────────────────────────

  const strikes = extractStrikes(cleanText);

  // ── Expiry hint ───────────────────────────────────────────────────────────

  const expiryHint = extractExpiryHint(cleanText, isLotto);

  // ── Premium hint ──────────────────────────────────────────────────────────

  const premiumHint = extractPremium(cleanText);

  // ── Complexity: extra_text ────────────────────────────────────────────────

  if (action !== null && strategy !== null && wordCount(cleanText) > 15) {
    complexityFlags.add('extra_text');
  }

  return {
    action,
    symbol,
    direction,
    strategy,
    strikes,
    expiryHint,
    premiumHint,
    exitPercent,
    targetStrategy,
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

  // Detect lotto from expiryHint (set to '0DTE' for lotto) combined with a
  // check on the direction override. Since this function only has the ParseResult
  // we use the heuristic: lotto → expiryHint==='0DTE' && direction==='LONG'
  // but that's not fully discriminating. We rely on the caller having run
  // parseMessage, so we check if expiryHint is '0DTE' AND strategy is PUT/CALL
  // as a proxy. The cleaner approach: expose isLotto in ParseResult, but per the
  // spec it isn't there. Use delta when expiryHint==='0DTE' as a reasonable proxy.
  if (parse.expiryHint === '0DTE' && parse.direction === 'LONG' &&
      (parse.strategy === 'PUT' || parse.strategy === 'CALL')) {
    return { method: 'delta', target: 0.70, bias: 'otm' };
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
    isStrangle: false,
    isHardSkip: true,
    skipReason: reason,
    complexityFlags,
  };
}
