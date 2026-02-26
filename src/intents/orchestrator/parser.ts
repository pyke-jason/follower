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
const EXPIRED_WORTHLESS_RE = /\bexpir(?:ed|es|ing)?\s+worthless\b/i;

// ── Strategy detection patterns ───────────────────────────────────────────────

const CDS_RE = /\bcds\b|call debit spread/i;
const PCS_RE = /\bpcs\b|put credit spread|bull(?:ish)?\s+put\s+spread/i;
const PDS_RE = /\bpds\b|put debit spread/i;
const LEAP_RE = /\bleaps?\b/i;
const LOTTO_RE = /\blotto\b|\byolo\b/i;
const STRANGLE_RE = /\bstrangle\b|\bstraddle\b/i;
// Spread keywords — used to disambiguate naked vs spread when "calls"/"puts" present
const SPREAD_KW_RE = /\bcds\b|\bpcs\b|\bpds\b|call debit spread|put credit spread|put debit spread|\bspread\b/i;
const CALLS_RE = /\bcalls?\b/i;
const PUTS_RE = /\bputs?\b/i;
const STOCK_RE = /\bstocks?\b|\bshares?\b/i;
const CONTRACT_RE = /\bcontracts?\b/i;
const STOCK_QTY_RE = /\b\d{1,3}(,\d{3})+\b/;

// ── Direction-override verb patterns ─────────────────────────────────────────

const SOLD_RE = /\b(sold|selling)\b/i;
// "sold out" / "sold to close" is an exit, not sell-to-open — handled in action logic
const WROTE_WRITING_RE = /\b(wrote|writing)\b/i;
const BOUGHT_BUYING_RE = /\b(bought|buying)\b/i;
const BOUGHT_BACK_RE = /\bbought\s+back\b/i;
const BOUGHT_BACK_SHORT_CALLS_RE = /\bbought\s+back\s+(?:the\s+)?short\s+(?:call|calls)\b/i;
const BOUGHT_BACK_SHORT_PUTS_RE = /\bbought\s+back\s+(?:the\s+)?short\s+(?:put|puts)\b/i;
const SHORTING_RE = /\b(shorting|shorted)\b|\bshort\b(?!\s*(?:term|squeeze|interest|sellers?|covering|side|dated|strike|week|leg|run))/i;

// ── Strike detection (used in strategy detection fallback) ────────────────────

const STRIKE_NEAR_OPTION_RE = /\$?(\d{2,5}(?:\.\d+)?)\s*(?:calls?|puts?|[cp]\b)/i;

// ── Monitoring / observation patterns ────────────────────────────────────────

const MONITORING_RE = /\b(watching|monitoring|I\s+have|I\s+am\s+holding)\b/i;

// ── Premium constants ─────────────────────────────────────────────────────────

const PREMIUM_MIN = 0.01;
const PREMIUM_MAX = 500;

// ── Exit-percent / fraction patterns ─────────────────────────────────────────

const FRACTION_HALF_RE = /\bhalf\b|1\s*\/\s*2/i;
const FRACTION_THIRD_RE = /\bthird\b|1\s*\/\s*3/i;
const FRACTION_QUARTER_RE = /\bquarter\b|1\s*\/\s*4/i;
const FRACTION_TWO_THIRDS_RE = /\btwo\s+thirds?\b|2\s*\/\s*3/i;
const PERCENT_RE = /(\d{1,3})\s*%/;

// ── Exit-verb patterns (soft detection without badge) ─────────────────────────

const EXIT_VERB_RE = /\b(exit(?:ing|ed)?|clos(?:e[ds]?|ing)|exiting|took profits?|stopped out|sold out)\b/i;

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

function looksLikeDate(a: number, b: number): boolean {
  return Number.isInteger(a) && Number.isInteger(b) && a >= 1 && a <= 12 && b >= 1 && b <= 31;
}

/** Strip parenthetical content for strategy detection (preserves for field extraction). */
function stripParenthetical(text: string): string {
  return text.replace(/\([^)]*\)/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ── Coordinated token extraction ──────────────────────────────────────────────

type Token = {
  type: 'dollar' | 'slash_pair' | 'option_kw' | 'month' | 'paren_num' | 'slash_date' | 'keyword_expiry' | 'price_marker' | 'bare_num' | 'credit_debit';
  start: number;
  end: number;
  value: string;
  parsed: number[];   // numeric values extracted
};

type ExtractionResult = {
  strikes: number[] | null;
  premiumHint: number | null;
  expiryHint: string | null;
  ambiguousSlashPair: boolean;
};

/** Collect all regex matches as tokens with positions. */
function collectTokens(re: RegExp, type: Token['type'], text: string, parseFn: (m: RegExpExecArray) => number[]): Token[] {
  const tokens: Token[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ type, start: m.index, end: m.index + m[0].length, value: m[0], parsed: parseFn(m) });
  }
  return tokens;
}

/** Check if two tokens overlap in character positions. */
function overlaps(a: Token, b: Token): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Remove tokens that overlap with a higher-priority token (longer span wins). */
function dedupeTokens(tokens: Token[]): Token[] {
  // Sort by span length descending (longer wins overlaps), then by start position
  const sorted = [...tokens].sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept: Token[] = [];
  for (const tok of sorted) {
    if (kept.some(k => overlaps(k, tok))) continue;
    kept.push(tok);
  }
  return kept;
}

/**
 * Coordinated extraction of strikes, premium, and expiry from text.
 *
 * Two-phase approach: tokenize all values with character positions, then
 * assign roles (strike/premium/expiry) using adjacency and elimination.
 * This prevents the cascading mis-assignment bugs that occur when independent
 * regexes scan the same text without sharing context.
 */
function extractTradeFields(
  text: string,
  context: { strategy: Strategy | null; isLotto: boolean; isSpread: boolean },
): ExtractionResult {
  // ── Phase 1: Tokenize ────────────────────────────────────────────────────

  // Dollar amounts: $9.50, $.50, $180
  const dollarTokens = collectTokens(
    /\$(\d*\.?\d+)/g, 'dollar', text,
    m => [parseFloat(m[1])],
  );

  // Slash pairs: 68/67, 227.50/225
  const slashPairTokens = collectTokens(
    /(\d{1,5}(?:\.\d+)?)\s*\/\s*(\d{1,5}(?:\.\d+)?)/g, 'slash_pair', text,
    m => [parseFloat(m[1]), parseFloat(m[2])],
  );

  // Option keywords: puts, calls, put, call
  const optionKwTokens = collectTokens(
    /\b(puts?|calls?)\b/gi, 'option_kw', text,
    () => [],
  );

  // Month tokens: jan, feb, ..., sept, september, etc.
  const monthTokens = collectTokens(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi, 'month', text,
    () => [],
  );

  // Parenthesized numbers: (19), (3)
  const parenNumTokens = collectTokens(
    /\((\d{1,2})\)/g, 'paren_num', text,
    m => [parseInt(m[1], 10)],
  );

  // Slash dates: 9/19, 3/6/26
  const slashDateTokens = collectTokens(
    /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g, 'slash_date', text,
    m => [parseInt(m[1], 10), parseInt(m[2], 10), ...(m[3] ? [parseInt(m[3], 10)] : [])],
  );

  // Keyword expiries: 0DTE, overnight, tomorrow, this week, next week, next friday
  const keywordExpiryTokens: Token[] = [];
  const kwExpiries: [RegExp, string][] = [
    [/\b0\s*-?\s*dte\b/gi, '0DTE'],
    [/\bovernight\b/gi, 'overnight'],
    [/\btomorrow\b/gi, 'tomorrow'],
    [/\bnext\s+friday\b/gi, 'next friday'],
    [/\bnext\s+week\b/gi, 'next week'],
    [/\bthis\s+week\b/gi, 'this week'],
  ];
  for (const [re, label] of kwExpiries) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      keywordExpiryTokens.push({ type: 'keyword_expiry', start: m.index, end: m.index + m[0].length, value: label, parsed: [] });
    }
  }

  // Price markers: @ symbol
  const priceMarkerTokens = collectTokens(
    /@/g, 'price_marker', text,
    () => [],
  );

  // credit/debit keywords
  const creditDebitTokens = collectTokens(
    /\b(credit|debit|cr|db)\b/gi, 'credit_debit', text,
    () => [],
  );

  // Bare numbers adjacent to option keywords (no $ prefix): "9.50 puts"
  const bareNumTokens = collectTokens(
    /(?<!\$)(?<!\d)(\d{1,5}(?:\.\d+)?)\s*(?=(?:puts?|calls?|[cp])\b)/gi, 'bare_num', text,
    m => [parseFloat(m[1])],
  );

  // Bare numbers after "for"/"at" (no $ prefix): "for .63", "for 1.80", "at 2.10"
  // These are premium candidates; tokenize just the number portion
  const forAtBareTokensFixed: Token[] = [];
  {
    const re = /\b(?:for|at)\s+(\.?\d+(?:\.\d+)?)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Skip if the number part starts with $ (already a dollar token)
      const numStr = m[1];
      const numStart = m.index + m[0].length - numStr.length;
      if (numStart > 0 && text[numStart - 1] === '$') continue;
      const val = parseFloat(numStr);
      if (isFinite(val) && val >= PREMIUM_MIN && val <= PREMIUM_MAX) {
        forAtBareTokensFixed.push({
          type: 'bare_num',
          start: numStart,
          end: m.index + m[0].length,
          value: numStr,
          parsed: [val],
        });
      }
    }
  }

  // Cost-basis suffix pattern
  const costBasisRe = /\b(?:avg|average|cost|basis)\b/gi;
  const costBasisPositions: number[] = [];
  let cbm: RegExpExecArray | null;
  while ((cbm = costBasisRe.exec(text)) !== null) {
    costBasisPositions.push(cbm.index);
  }

  // Combine all tokens and deduplicate overlaps (longer span wins)
  // Slash pairs take priority over dollar amounts and slash dates
  let allTokens = dedupeTokens([
    ...slashPairTokens,
    ...dollarTokens,
    ...slashDateTokens,
    ...optionKwTokens,
    ...monthTokens,
    ...parenNumTokens,
    ...keywordExpiryTokens,
    ...priceMarkerTokens,
    ...creditDebitTokens,
    ...bareNumTokens,
    ...forAtBareTokensFixed,
  ]);

  // ── Phase 2: Assign roles ──────────────────────────────────────────────────

  let strikes: number[] | null = null;
  let premiumHint: number | null = null;
  let expiryHint: string | null = null;
  let ambiguousSlashPair = false;

  // Track which tokens have been consumed
  const consumed = new Set<Token>();

  // Helper: is a cost-basis keyword within N chars of a token?
  function nearCostBasis(tok: Token, dist = 8): boolean {
    return costBasisPositions.some(pos =>
      (pos >= tok.start - dist && pos <= tok.end + dist));
  }

  // Helper: is an option keyword within N chars after a token?
  function optionKwAfter(tok: Token, dist = 4): Token | undefined {
    return allTokens.find(t =>
      t.type === 'option_kw' && t.start >= tok.end && t.start - tok.end <= dist);
  }

  // Helper: is a price marker (@) or "for"/"at" within N chars before a token?
  function priceMarkerBefore(tok: Token, dist = 4): boolean {
    // Check for @ token
    if (allTokens.some(t => t.type === 'price_marker' && t.end <= tok.start && tok.start - t.end <= dist)) return true;
    // Check for "for"/"at" keyword in raw text before the token
    const lookback = text.slice(Math.max(0, tok.start - 6), tok.start);
    return /\b(?:for|at)\s*$/.test(lookback);
  }

  // Helper: is a credit/debit keyword within N chars after a token?
  function creditDebitAfter(tok: Token, dist = 4): boolean {
    return allTokens.some(t =>
      t.type === 'credit_debit' && t.start >= tok.end && t.start - tok.end <= dist);
  }

  // Rule 1: Dollar amount with cost-basis keyword nearby → exclude
  for (const tok of allTokens) {
    if ((tok.type === 'dollar' || tok.type === 'bare_num') && nearCostBasis(tok)) {
      consumed.add(tok);
    }
  }

  // Rule 2: Handle keyword expiries first (highest priority for expiry)
  for (const tok of allTokens) {
    if (tok.type === 'keyword_expiry' && !consumed.has(tok)) {
      if (!expiryHint) {
        expiryHint = tok.value;
        consumed.add(tok);
      }
    }
  }

  // Lotto implies 0DTE
  if (context.isLotto && !expiryHint) {
    expiryHint = '0DTE';
  }

  // Rule 3: Month + paren number → expiry (e.g., "Sept (19)" → "Sep 19")
  for (const monthTok of allTokens.filter(t => t.type === 'month' && !consumed.has(t))) {
    const parenTok = allTokens.find(t =>
      t.type === 'paren_num' && !consumed.has(t) &&
      t.start >= monthTok.end && t.start - monthTok.end <= 3);
    if (parenTok && !expiryHint) {
      // Normalize "sept" → "sep" etc.
      const rawMonth = monthTok.value.toLowerCase();
      const normMonth = rawMonth.startsWith('sep') ? 'sep' : rawMonth.slice(0, 3);
      expiryHint = `${normMonth} ${parenTok.parsed[0]}`;
      consumed.add(monthTok);
      consumed.add(parenTok);
    }
  }

  // Rule 4: Month + adjacent number (not already consumed) → expiry
  for (const monthTok of allTokens.filter(t => t.type === 'month' && !consumed.has(t))) {
    // Look for a bare number or paren number right after the month
    const adjNum = allTokens.find(t =>
      (t.type === 'bare_num' || t.type === 'paren_num') && !consumed.has(t) &&
      t.start >= monthTok.end && t.start - monthTok.end <= 3 &&
      t.parsed[0] >= 1 && t.parsed[0] <= 31);
    if (adjNum && !expiryHint) {
      const rawMonth = monthTok.value.toLowerCase();
      const normMonth = rawMonth.startsWith('sep') ? 'sep' : rawMonth.slice(0, 3);
      expiryHint = `${normMonth} ${adjNum.parsed[0]}`;
      consumed.add(monthTok);
      consumed.add(adjNum);
    }
  }

  // Rule 5: Bare month with no day → expiry
  for (const monthTok of allTokens.filter(t => t.type === 'month' && !consumed.has(t))) {
    if (!expiryHint) {
      const rawMonth = monthTok.value.toLowerCase();
      const normMonth = rawMonth.startsWith('sep') ? 'sep' : rawMonth.slice(0, 3);
      expiryHint = normMonth;
      consumed.add(monthTok);
    }
  }

  // Rule 6: Slash pairs — strikes vs date disambiguation
  for (const tok of allTokens.filter(t => t.type === 'slash_pair' && !consumed.has(t))) {
    const [s1, s2] = tok.parsed;
    const datelike = looksLikeDate(s1, s2);

    if (!datelike) {
      // Clearly strikes
      if (!strikes) {
        strikes = [s1, s2];
        consumed.add(tok);
      }
    } else if (context.isSpread && expiryHint) {
      // Spread + separate expiry → these are strikes
      if (!strikes) {
        strikes = [s1, s2];
        consumed.add(tok);
      }
    } else if (context.isSpread && !expiryHint) {
      // Strikes already found from another pair → this date-like pair IS the expiry
      if (strikes) {
        expiryHint = tok.value.replace(/\s/g, '');
        consumed.add(tok);
      } else {
        // Check if another slash pair exists that is clearly strikes (not date-like)
        const otherStrikePairs = allTokens.filter(t =>
          t.type === 'slash_pair' && !consumed.has(t) && t !== tok &&
          !looksLikeDate(t.parsed[0], t.parsed[1]));
        if (otherStrikePairs.length > 0) {
          // Another pair is clearly strikes → this date-like pair IS the expiry
          expiryHint = tok.value.replace(/\s/g, '');
          consumed.add(tok);
        } else {
          // Genuinely ambiguous — could be dates or cheap-stock strikes
          ambiguousSlashPair = true;
          consumed.add(tok);
        }
      }
    } else {
      // Non-spread + date-like → it's a date
      if (!expiryHint) {
        expiryHint = tok.value.replace(/\s/g, '');
        consumed.add(tok);
      }
    }
  }

  // Rule 7: Slash dates (M/DD format, not consumed by slash_pair)
  for (const tok of allTokens.filter(t => t.type === 'slash_date' && !consumed.has(t))) {
    const [mo, dy] = tok.parsed;
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31 && !expiryHint) {
      expiryHint = tok.value;
      consumed.add(tok);
    }
  }

  // LEAP fallback for expiry
  if (!expiryHint && LEAP_RE.test(text)) {
    expiryHint = 'LEAP';
  }

  // Rule 8: Dollar/bare number immediately left of option keyword → strike
  for (const tok of allTokens.filter(t => (t.type === 'dollar' || t.type === 'bare_num') && !consumed.has(t))) {
    const kwTok = optionKwAfter(tok, 4);
    if (kwTok) {
      const val = tok.parsed[0];
      if (isFinite(val) && val >= 0.5) {
        if (!strikes) strikes = [];
        if (!strikes.includes(val)) strikes.push(val);
        consumed.add(tok);
      }
    }
  }

  // Rule 9: Dollar amount after @ or "for $"/"at $" → premium
  for (const tok of allTokens.filter(t => t.type === 'dollar' && !consumed.has(t))) {
    if (priceMarkerBefore(tok, 4)) {
      const val = tok.parsed[0];
      if (isFinite(val) && val >= PREMIUM_MIN && val <= PREMIUM_MAX) {
        if (premiumHint === null) {
          premiumHint = val;
          consumed.add(tok);
        }
      }
    }
  }

  // Rule 10: Number + credit/debit → premium
  for (const tok of allTokens.filter(t => (t.type === 'dollar' || t.type === 'bare_num') && !consumed.has(t))) {
    if (creditDebitAfter(tok, 4)) {
      const val = tok.parsed[0];
      if (isFinite(val) && val >= PREMIUM_MIN && val <= PREMIUM_MAX) {
        if (premiumHint === null) {
          premiumHint = val;
          consumed.add(tok);
        }
      }
    }
  }

  // Rule 11: Elimination — single remaining unassigned dollar → premium (if no premium yet)
  if (premiumHint === null) {
    const remaining = allTokens.filter(t =>
      (t.type === 'dollar' || t.type === 'bare_num') && !consumed.has(t));
    if (remaining.length === 1) {
      const val = remaining[0].parsed[0];
      if (isFinite(val) && val >= PREMIUM_MIN && val <= PREMIUM_MAX) {
        premiumHint = val;
        consumed.add(remaining[0]);
      }
    }
  }

  // Rule 12: Remaining unassigned dollar amounts → strikes (fallback)
  if (!strikes) {
    const remaining = allTokens.filter(t =>
      (t.type === 'dollar' || t.type === 'bare_num') && !consumed.has(t));
    const vals = remaining
      .map(t => t.parsed[0])
      .filter(v => isFinite(v) && v >= 1);
    if (vals.length > 0) {
      strikes = vals;
      for (const t of remaining) consumed.add(t);
    }
  }

  // Dedup: if premium matches a strike, the premium is really the strike price
  if (premiumHint !== null && strikes !== null && strikes.includes(premiumHint)) {
    premiumHint = null;
  }

  return { strikes, premiumHint, expiryHint, ambiguousSlashPair };
}

// ── Strategy detection (extracted for two-pass paren stripping) ──────────────

function detectStrategy(
  text: string,
  isLotto: boolean,
  fullText: string,
): { strategy: Strategy | null; directionFromStrategy: Direction | null } {
  let strategy: Strategy | null = null;
  let directionFromStrategy: Direction | null = null;

  if (CDS_RE.test(text)) {
    strategy = 'CDS';
    directionFromStrategy = 'LONG';
  } else if (PCS_RE.test(text)) {
    strategy = 'PCS';
  } else if (PDS_RE.test(text)) {
    strategy = 'PDS';
    directionFromStrategy = 'LONG';
  } else if (LEAP_RE.test(text)) {
    strategy = 'CALL';
    directionFromStrategy = 'LONG';
  } else if (isLotto) {
    // Always check full text since "(calls)" may be in parens
    strategy = CALLS_RE.test(fullText) ? 'CALL' : 'PUT';
    directionFromStrategy = 'LONG';
  } else if (CALLS_RE.test(text) && !SPREAD_KW_RE.test(text)) {
    strategy = 'CALL';
    directionFromStrategy = 'LONG';
  } else if (PUTS_RE.test(text) && !SPREAD_KW_RE.test(text)) {
    strategy = 'PUT';
    directionFromStrategy = 'LONG';
  } else if (STOCK_RE.test(text)) {
    strategy = 'STOCK';
    directionFromStrategy = null;
  }

  // Positional STOCK override: if CALL/PUT was detected but the text also
  // contains stock indicators, prefer STOCK (the option keyword is likely
  // commentary about an existing position, not the primary trade action)
  if ((strategy === 'CALL' || strategy === 'PUT') && !SPREAD_KW_RE.test(text)) {
    if (STOCK_QTY_RE.test(text)) {
      // Comma-separated quantities (1,000+) strongly indicate stock
      strategy = 'STOCK';
      directionFromStrategy = null;
    } else if (STOCK_RE.test(text)) {
      const stockPos = text.search(STOCK_RE);
      const callPos = CALLS_RE.test(text) ? text.search(CALLS_RE) : Infinity;
      const putPos = PUTS_RE.test(text) ? text.search(PUTS_RE) : Infinity;
      if (stockPos < Math.min(callPos, putPos)) {
        strategy = 'STOCK';
        directionFromStrategy = null;
      }
    }
  }

  // Bare P/C abbreviation fallback (e.g. "$34 P", "$180 C")
  if (strategy === null) {
    const nearM = STRIKE_NEAR_OPTION_RE.exec(text);
    if (nearM) {
      const match = nearM[0].toLowerCase();
      if (/p\b/.test(match)) { strategy = 'PUT'; directionFromStrategy = 'LONG'; }
      else if (/c\b/.test(match)) { strategy = 'CALL'; directionFromStrategy = 'LONG'; }
    }
  }

  // "put spread" + credit/debit disambiguation (when PCS_RE didn't match)
  if (strategy === null && /\bput\s+spread\b/i.test(text)) {
    if (/\bcredit\b/i.test(text) || /\bbullish\b/i.test(text)) strategy = 'PCS';
    else if (/\bdebit\b/i.test(text) || /\bbearish\b/i.test(text)) strategy = 'PDS';
  }

  return { strategy, directionFromStrategy };
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

  if (EXPIRED_WORTHLESS_RE.test(cleanText)) {
    return hardSkip('expired worthless — informational, no broker action needed', complexityFlags);
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

  // ── Complexity: multi-ticker ───────────────────────────────────────────────

  if (symbols.length > 1) complexityFlags.add('multi_ticker');

  // ── Complexity: relational ─────────────────────────────────────────────────

  if (RELATIONAL_RE.test(cleanText)) complexityFlags.add('relational');

  // ── Complexity: mixed action ───────────────────────────────────────────────

  if (hasExitBadge && (hasLongBadge || hasShortBadge)) {
    const hasOpenIntent =
      (BOUGHT_BUYING_RE.test(cleanText) && !BOUGHT_BACK_RE.test(cleanText)) ||
      WROTE_WRITING_RE.test(cleanText);
    if (hasOpenIntent) {
      complexityFlags.add('mixed_action');
    }
  }

  // ── Symbol ────────────────────────────────────────────────────────────────

  const symbol = symbols.length > 0 ? symbols[0] : null;

  // ── Lotto/Yolo flag (affects strategy, direction, expiry) ─────────────────

  const isLotto = LOTTO_RE.test(cleanText);

  // ── Strangle ──────────────────────────────────────────────────────────────

  const isStrangle =
    (hasLongBadge && hasShortBadge && STRANGLE_RE.test(cleanText)) ||
    (STRANGLE_RE.test(cleanText) && CALLS_RE.test(cleanText) && PUTS_RE.test(cleanText)) ||
    (STRANGLE_RE.test(cleanText) && (hasLongBadge || hasShortBadge || hasExitBadge));

  // ── Strategy detection (two-pass: primary text first, full text fallback) ──
  //
  // Phase 1: detect on paren-stripped text to prevent keyword hijacking from
  //          parenthetical commentary (e.g., "PDS" in aside text).
  // Phase 2: fall back to full text for messages where the trade strategy is
  //          legitimately inside parentheses (e.g., "Long OSCR (sold $18 puts)").

  const primaryText = stripParenthetical(cleanText);
  let { strategy, directionFromStrategy } = detectStrategy(primaryText, isLotto, cleanText);
  const strategyFromPrimary = strategy !== null;

  if (strategy === null) {
    ({ strategy, directionFromStrategy } = detectStrategy(cleanText, isLotto, cleanText));
  }

  // STOCK priority: strategy found only in parenthetical content but primary text
  // has stock indicators, or badge implies stock with no trade fields in parens
  if (!strategyFromPrimary && strategy !== null && strategy !== 'STOCK') {
    const primaryHasStock = STOCK_RE.test(primaryText) || STOCK_QTY_RE.test(primaryText);
    const parenContent = cleanText.match(/\([^)]*\)/g)?.join(' ') ?? '';
    const parenHasTradeFields = /\$\d/.test(parenContent) || /\bexpir/i.test(parenContent);
    const badgeImpliesStock = (hasLongBadge || hasShortBadge) && !hasExitBadge && !parenHasTradeFields;
    if (primaryHasStock || badgeImpliesStock) {
      strategy = 'STOCK';
      directionFromStrategy = null;
    }
  }

  // Badge-implied STOCK fallback: Long/Short badge + no option strategy detected.
  // Guard: "contracts" keyword suggests an unlabeled options trade → leave for LLM.
  if (strategy === null && (hasLongBadge || hasShortBadge) && !hasExitBadge && !CONTRACT_RE.test(cleanText)) {
    strategy = 'STOCK';
    directionFromStrategy = null;
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
    if (SHORTING_RE.test(cleanText)) direction = 'SHORT';
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
    } else if (BOUGHT_BACK_RE.test(cleanText) && symbol !== null) {
      if (BOUGHT_BACK_SHORT_CALLS_RE.test(cleanText)) {
        action = 'LEG_OFF';
        targetStrategy = 'CALL';
      } else if (BOUGHT_BACK_SHORT_PUTS_RE.test(cleanText)) {
        action = 'LEG_OFF';
        targetStrategy = 'PUT';
      } else {
        action = 'CLOSE';
      }
    } else if (/\b(adding|added)\b/i.test(cleanText)) {
      action = 'ADD';
    } else if (BOUGHT_BUYING_RE.test(cleanText) || /\bopened\b/i.test(cleanText)) {
      action = 'OPEN';
    } else if (WROTE_WRITING_RE.test(cleanText)) {
      action = 'OPEN';
    } else if (SOLD_RE.test(cleanText) && !EXIT_VERB_RE.test(cleanText) && symbol !== null) {
      action = 'OPEN';
    } else if (
      strategy !== null &&
      (strategy === 'CDS' || strategy === 'PDS' || strategy === 'PCS' || isStrangle) &&
      symbol !== null &&
      !EXIT_VERB_RE.test(cleanText) &&
      !MONITORING_RE.test(cleanText)
    ) {
      action = 'OPEN';
    }
    // Otherwise leave null — needs LLM
  }

  // Monitoring-verb skip: position description without action intent
  if (action === null && badges.length === 0 && MONITORING_RE.test(cleanText)) {
    return hardSkip('monitoring/observation', complexityFlags);
  }

  // Hard-skip: no symbol and no action → pure commentary
  if (symbol === null && action === null) {
    return hardSkip('no symbol and no action', complexityFlags);
  }

  // ── Coordinated field extraction (strikes, premium, expiry) ──────────────

  const isSpread = strategy === 'CDS' || strategy === 'PDS' || strategy === 'PCS';
  const { strikes: extractedStrikes, premiumHint: extractedPremium, expiryHint: extractedExpiry, ambiguousSlashPair } = extractTradeFields(
    cleanText,
    { strategy, isLotto, isSpread },
  );
  let strikes = extractedStrikes;
  const expiryHint = extractedExpiry;
  let premiumHint = extractedPremium;
  if (ambiguousSlashPair) complexityFlags.add('ambiguous_strikes');

  // ── Complexity: extra_text ────────────────────────────────────────────────
  // Skip extra_text flag when all core trade fields are resolved — commentary
  // after a fully-parsed trade shouldn't force the LLM path.

  if (action !== null && strategy !== null && wordCount(cleanText) > 25) {
    const fullyResolved = symbol !== null && (
      strategy === 'STOCK' ||
      (isSpread && strikes !== null && strikes.length >= 2) ||
      (!isSpread && (strikes !== null || premiumHint !== null))
    );
    if (!fullyResolved) {
      complexityFlags.add('extra_text');
    }
  }

  // When lotto + extra_text, the context is too complex for the lotto=LONG default.
  // Leave direction null for LLM resolution.
  if (isLotto && complexityFlags.has('extra_text')) {
    direction = null;
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
