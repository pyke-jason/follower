/**
 * Deterministic post-processor for LLM-emitted signals.
 *
 * The LLM occasionally violates documented label conventions (see
 * .claude/skills/label/SKILL.md): drops explicit prices, emits null strategy
 * when the message has a dollar price and no option markers, misreads "50%
 * profit" as an exit percent, etc. These rules are documented and
 * unambiguous — we enforce them deterministically on top of LLM output
 * rather than relying on the LLM to follow them consistently.
 *
 * Runs AFTER `canonicalizeSignals`, BEFORE the result lands in
 * `OrchestratorResult.classifierSignals`. Input: the LLM's signal array +
 * the original message text. Output: the same array with rule-violating
 * fields corrected.
 *
 * Each rule is a pure function: `(signal, text) => signal`. Rules compose.
 */
import type { Signal } from '@/agent/schemas.js';

// ── Text probes ─────────────────────────────────────────────────────────────

/** Word-form option keywords. "Nc"/"Np" excluded — collides with "53c loss". */
const OPTION_WORD_RE = /\b(?:call|put|calls|puts|spread|strike|premium|credit|debit|cds|pds|pcs|ccs|leap|lotto|yolo|strangle|straddle)\b/i;

/** "Nc"/"Np" option notation (strike+type). */
const OPTION_NC_NP_RE = /\b\d{1,4}(?:\.\d+)?[cp]\b/i;

/** Explicit partial-exit qualifiers that turn a CLOSE into a TRIM. */
const EXPLICIT_PARTIAL_RE = new RegExp([
  /\bhalf\b/.source,
  /\bpartial(?:\s+profits?)?\b/.source,
  /\b1\/[234]\b/.source,
  /\btook\s+\d+\s*%/.source,              // "took 70%..." (partial by explicit trim)
  /\d+\s*%(?!\s*(?:profit|gain|loss|return))/.source,  // "25% off" but not "30% gain" / "50% profit" (P&L)
  /\bstill\s+holding\b/.source,
  /\bstill\s+have\s+(?:majority|most|some|half|rest|remainder|a\s+lot|plenty)\b/.source,
  /\bkeeping\s+(?:some|half|rest|majority|most)\b/.source,
  /\bwill\s+keep\s+(?:some|scaling|half)\b/.source,
  /\bsome\s+off\b/.source,
  /\btook\s+(?:more|additional|further|another)\s+(?:gains?|profits?)/.source,
  /\btook\s+(?:small\s+)?(?:gains?|profits?)\s+again/.source,
  /\bscaling\s+out\b/.source,
  /\bscaled\s+out\b/.source,
  /\btrimmed\b/.source,
  /\btook\s+partial/.source,
].join('|'), 'i');

/** Explicit full-exit markers that keep CLOSE as CLOSE. */
const EXPLICIT_FULL_RE = /\b(?:all\s+out|closed\s+out|remainder|final\s+(?:sell|exit)|last\s+(?:candle|leg)|fully|stopped\s+out)\b/i;

/** P&L annotation patterns — "50% profit", "$1.20 profit", "$.30 gain/loss". */
const PL_PERCENT_PROFIT_RE = /\b(\d{1,3})\s*%\s+(?:profit|gain|loss|scratch)/i;
const PL_DOLLAR_RE = /(?:\bfor\s+(?:a\s+|some\s+)?)?[+-]?\$?(?:\.\d+|\d+(?:\.\d+)?)\s*c?\s*(?:\/(?:share|contract))?\s+(?:gain|loss|scratch|profit)\b/i;

/** "overnight" expiry keyword anywhere in text. */
const OVERNIGHT_RE = /\bovernight\b/i;

/** "i shorted"/"covered … short" → closing SHORT position. */
const COVERED_SHORT_RE = /\b(?:covered\s+(?:my\s+)?(?:the\s+)?stock\s+i\s+short(?:ed)?|stock\s+i\s+shorted|covered\s+(?:my\s+)?short\b)/i;

/** "my shares"/"my stock"/"my long" → position was LONG. */
const MY_LONG_POSITION_RE = /\bmy\s+(?:shares?|stock|long)\b/i;

/** "my calls" → position was LONG CALL; "my puts" → LONG PUT. */
const MY_CALLS_RE = /\bmy\s+calls?\b/i;
const MY_PUTS_RE = /\bmy\s+puts?\b/i;

// ── Rules ───────────────────────────────────────────────────────────────────

/**
 * SKILL rule 8: "A stated dollar price implies STOCK unless options language
 * is present." Only fires when there's a concrete stock indicator in the
 * text — a $price, a "shares"/"stock" word, or a post-ticker decimal that
 * looks like a stock price. Do NOT default to STOCK on bare prose exits
 * like "Exit ADBE until market figures out direction" — label convention
 * leaves those null.
 */
// STOCK cue — something concrete that points to a stock (not just a P&L mention).
// "$0.40 profit" alone shouldn't trigger STOCK; we need a stock-price-shaped
// number (>$5, not a cent-denominated P&L) or an explicit "shares"/"stock" word.
const STOCK_CUE_RE = /\b(?:shares?|stock)s?\b|@\s*\$?\d+(?:\.\d+)?|\bat\s+\$?\d{2,}(?:\.\d+)?\b|\$\d{2,}(?:\.\d+)?\b/i;
function rule_dollarPriceImpliesStock(sig: Signal, text: string): Signal {
  if (sig.strategy != null) return sig;
  if (OPTION_WORD_RE.test(text) || OPTION_NC_NP_RE.test(text)) return sig;
  if (!STOCK_CUE_RE.test(text)) return sig;
  return { ...sig, strategy: 'STOCK' };
}

/**
 * Label convention: on CLOSE/TRIM with a single directional badge, direction is
 * taken from the badge, overriding any position-inferred direction. [Short][Exit]
 * → SHORT always, even if the author's position was LONG puts. The exception
 * is "covered stock I shorted" / "bought back" text — those verbs are
 * authoritative and the earlier `rule_covered_short_direction` already set
 * SHORT; we preserve it when badge is [Long] ambiguously.
 */
const COVERED_OR_BOUGHT_BACK_RE = /\b(?:covered\s+(?:my\s+|the\s+)?stock\s+i\s+shorted|stock\s+i\s+shorted|covered\s+(?:my\s+)?short|bought\s+back\s+(?:my\s+)?short)\b/i;
function rule_exit_direction_from_badge(sig: Signal, text: string, badges: readonly string[]): Signal {
  if (sig.action !== 'CLOSE' && sig.action !== 'TRIM' && sig.action !== 'LEG_OFF') return sig;
  const hasLong = badges.includes('Long');
  const hasShort = badges.includes('Short');
  // Both-direction badges on exit = strangle/straddle close. Label convention
  // leaves direction=null because neither badge wins. Strip LLM's guess.
  if (hasLong && hasShort) return sig.direction == null ? sig : { ...sig, direction: null };
  // Preserve SHORT when covered-short evidence is explicit in the text.
  if (sig.direction === 'SHORT' && COVERED_OR_BOUGHT_BACK_RE.test(text)) return sig;
  if (hasLong) return sig.direction === 'LONG' ? sig : { ...sig, direction: 'LONG' };
  if (hasShort) return sig.direction === 'SHORT' ? sig : { ...sig, direction: 'SHORT' };
  return sig;
}

/**
 * Bare exits with a directional badge and no options/spread language default
 * to strategy=STOCK. Label convention: "Exit Short FRPT took nice profit" +
 * [Exit][Short] badges = closing a short stock position → STOCK. Only fires
 * on CLOSE/TRIM where strategy is still null after the other rules ran.
 */
function rule_bare_exit_badge_is_stock(sig: Signal, text: string, badges: readonly string[]): Signal {
  if (sig.action !== 'CLOSE' && sig.action !== 'TRIM') return sig;
  if (sig.strategy != null) return sig;
  const hasDirBadge = badges.includes('Long') || badges.includes('Short');
  if (!hasDirBadge) return sig;
  if (OPTION_WORD_RE.test(text) || OPTION_NC_NP_RE.test(text)) return sig;
  return { ...sig, strategy: 'STOCK' };
}

/**
 * Strip LLM's guessed direction on bare Exit-only badge messages. Per the
 * user's direction semantics: exit direction must come from prior position
 * context, not a default. When the message has no Long/Short badge and no
 * buy/sell verb, direction should be null (label convention).
 */
const BUY_SELL_VERB_RE = /\b(?:bought|buying|sold|selling|shorted|shorting|short\s+to\s+open|wrote|writing|covered|covering|long\s+exit|short\s+exit|exit\s+long|exit\s+short)\b/i;
function rule_strip_guessed_exit_direction(sig: Signal, text: string, badges: readonly string[]): Signal {
  if (sig.action !== 'CLOSE' && sig.action !== 'TRIM' && sig.action !== 'LEG_OFF') return sig;
  if (sig.direction == null) return sig;
  const hasLong = badges.includes('Long');
  const hasShort = badges.includes('Short');
  if (hasLong || hasShort) return sig; // badge gave the direction — keep
  if (BUY_SELL_VERB_RE.test(text)) return sig;
  // Bare Exit badge + no buy/sell verb → direction was a guess. Strip.
  return { ...sig, direction: null };
}

/**
 * On TRIM with explicit partial qualifier but no exitPercent set, fill 0.5.
 * Also extracts explicit "N%" from "took N% profits" or "N% off" phrases.
 */
const EXPLICIT_PCT_RE = /\btook\s+(\d{1,3})\s*%(?:\s+(?:profits?|gains?|off))?/i;
const EXPLICIT_FRACTION_RE = /\b(\d)\/(\d)\s+(?:off|out|exit|at)\b/i;
function rule_fill_exitpct_on_trim(sig: Signal, text: string): Signal {
  if (sig.action !== 'TRIM') return sig;
  if (sig.exitPercent != null) return sig;

  // Prefer explicit "N%" extraction — "took 70% profits" → 0.7
  const pctMatch = EXPLICIT_PCT_RE.exec(text);
  if (pctMatch) {
    const n = parseInt(pctMatch[1], 10);
    if (n > 0 && n <= 100) return { ...sig, exitPercent: n / 100 };
  }
  // Explicit fraction — "1/2 off", "3/4 out"
  const fracMatch = EXPLICIT_FRACTION_RE.exec(text);
  if (fracMatch) {
    const num = parseInt(fracMatch[1], 10);
    const den = parseInt(fracMatch[2], 10);
    if (den > 0 && num / den <= 1) return { ...sig, exitPercent: Math.round((num / den) * 100) / 100 };
  }
  // Generic "half"/"partial" → 0.5 default
  if (!EXPLICIT_PARTIAL_RE.test(text)) return sig;
  return { ...sig, exitPercent: 0.5 };
}

// Deliberately omitted rule to extract dropped $ prices: trying to tell
// "exit price" from "P&L amount" (both use $) without false positives proved
// too brittle. LLM is responsible for price extraction.

/**
 * exitPercent=1 on CLOSE → strip to undefined. Label convention on
 * "Exit SYM at $X" messages (full close, no partial qualifier) is to leave
 * exitPercent unset. The LLM sometimes emits 1 to signal "full exit" — drop it.
 */
function rule_strip_exitpct_1_on_close(sig: Signal, _text: string): Signal {
  if (sig.action !== 'CLOSE') return sig;
  if (sig.exitPercent !== 1) return sig;
  return { ...sig, exitPercent: undefined };
}

/**
 * TRIM with exitPercent=1 (100%) is semantically a full close, not a trim.
 * "took 100% profit" usually means the trade doubled — still a full close —
 * label convention is action=CLOSE with exitPercent unset.
 */
function rule_trim_100pct_is_close(sig: Signal, _text: string): Signal {
  if (sig.action !== 'TRIM') return sig;
  if (sig.exitPercent !== 1) return sig;
  return { ...sig, action: 'CLOSE', exitPercent: undefined };
}

/**
 * SKILL rule 12: explicit partial qualifier → TRIM + exitPercent.
 * Only flips CLOSE → TRIM; never touches OPEN/ADD. Prefers explicit "N%"
 * or "1/2"/"3/4" fractions over the generic 0.5 default.
 */
function rule_partialExitIsTrim(sig: Signal, text: string): Signal {
  if (sig.action !== 'CLOSE') return sig;
  if (!EXPLICIT_PARTIAL_RE.test(text)) return sig;
  if (EXPLICIT_FULL_RE.test(text)) return sig; // "closed out remainder" — stays CLOSE
  const next: Signal = { ...sig, action: 'TRIM' };
  if (next.exitPercent == null) {
    const pctMatch = EXPLICIT_PCT_RE.exec(text);
    if (pctMatch) {
      const n = parseInt(pctMatch[1], 10);
      if (n > 0 && n <= 100) {
        next.exitPercent = n / 100;
        return next;
      }
    }
    const fracMatch = EXPLICIT_FRACTION_RE.exec(text);
    if (fracMatch) {
      const num = parseInt(fracMatch[1], 10);
      const den = parseInt(fracMatch[2], 10);
      if (den > 0 && num / den <= 1) {
        next.exitPercent = Math.round((num / den) * 100) / 100;
        return next;
      }
    }
    next.exitPercent = 0.5;
  }
  return next;
}

/**
 * "N% profit" / "for $N gain" is P&L narration, not an exit percent. If the
 * LLM parked the % into exitPercent and the text shows it as a profit
 * description, clear it.
 */
function rule_strip_pl_miscoded_as_exitpct(sig: Signal, text: string): Signal {
  if (sig.exitPercent == null) return sig;
  if (sig.action === 'OPEN' || sig.action === 'ADD') {
    return { ...sig, exitPercent: undefined };
  }
  // If "took N%" is in the text, that N% is the EXPLICIT exit percent — never strip.
  if (EXPLICIT_PCT_RE.test(text)) return sig;
  // If the ONLY % in the text is "N% profit/gain/loss", and exitPercent
  // matches it, it's P&L — strip.
  const plMatch = PL_PERCENT_PROFIT_RE.exec(text);
  if (plMatch) {
    const plPercent = parseInt(plMatch[1], 10) / 100;
    if (Math.abs(plPercent - sig.exitPercent) < 0.001 && !EXPLICIT_PARTIAL_RE.test(text.replace(plMatch[0], ''))) {
      return { ...sig, exitPercent: undefined };
    }
  }
  return sig;
}

/**
 * Rule: "i shorted" / "covered short" => direction=SHORT on CLOSE signal
 * referencing stock. Catches "covered stock i shorted" → direction=SHORT.
 */
function rule_covered_short_direction(sig: Signal, text: string): Signal {
  if (sig.action !== 'CLOSE' && sig.action !== 'TRIM') return sig;
  if (sig.strategy !== 'STOCK') return sig;
  if (sig.direction === 'SHORT') return sig;
  if (!COVERED_SHORT_RE.test(text)) return sig;
  return { ...sig, direction: 'SHORT' };
}

/**
 * Previously set direction=LONG on "my shares"/"my stock"/"my long" text,
 * but labels treat these as direction=null. Retained as a no-op.
 */
function rule_my_long_position_direction(sig: Signal, _text: string): Signal {
  return sig;
}

/**
 * "avg'd in" / "averaged in" / "added more" / "adding to" with an OPEN action
 * → this is an ADD, not a fresh open. Label convention treats these as ADD
 * (averaging into a position the author already has).
 */
const AVG_IN_RE = /\b(?:avg'?d?\s+in|averaged?\s+(?:in|down|up|into)|adding\s+(?:more|to)|added\s+(?:more|to))\b/i;
function rule_averaged_in_is_add(sig: Signal, text: string): Signal {
  if (sig.action !== 'OPEN') return sig;
  if (!AVG_IN_RE.test(text)) return sig;
  return { ...sig, action: 'ADD' };
}

/**
 * Lotto/Yolo messages are ALWAYS a speculative BUY — direction=LONG regardless
 * of badge (orchestrator rule 10). Overrides the Short-badge backfill that
 * would otherwise flip "Short ABNB lotto" (bearish bias, BUY puts) to SHORT.
 */
const LOTTO_YOLO_RE = /\b(?:lotto|yolo)s?\b/i;
function rule_lotto_is_long(sig: Signal, text: string): Signal {
  if (sig.action !== 'OPEN' && sig.action !== 'ADD') return sig;
  if (!LOTTO_YOLO_RE.test(text)) return sig;
  if (sig.direction === 'LONG') return sig;
  return { ...sig, direction: 'LONG' };
}

/** "my calls" / "my puts" → direction LONG + strategy CALL/PUT when missing. */
function rule_my_options_direction(sig: Signal, text: string): Signal {
  if (sig.action !== 'CLOSE' && sig.action !== 'TRIM') return sig;
  if (MY_CALLS_RE.test(text)) {
    const next = { ...sig };
    if (next.strategy == null) next.strategy = 'CALL';
    if (next.direction == null) next.direction = 'LONG';
    return next;
  }
  if (MY_PUTS_RE.test(text)) {
    const next = { ...sig };
    if (next.strategy == null) next.strategy = 'PUT';
    if (next.direction == null) next.direction = 'LONG';
    return next;
  }
  return sig;
}

/**
 * Narrow overnight rule: fires only when "overnight" text qualifies a
 * spread/strangle instrument ("overnight pds", "overnight strangle",
 * "strangle for overnight") AND the signal's strategy is a spread or the
 * signal is part of a strangle decomposition (CALL/PUT). Labels treat these
 * specific constructions as expiry="overnight"; other "overnight" mentions
 * (e.g. "swing overnight") are descriptive and stay null.
 */
const OVERNIGHT_SPREAD_RE = /\bovernight["']?\s*(?:pds|cds|pcs|ccs|strangle|straddle|spread)\b|\b(?:strangle|straddle|spread|pds|cds|pcs|ccs|calls?|puts?)\s+(?:for\s+)?["']?overnight["']?\b/i;
function rule_overnight_expiry(sig: Signal, text: string): Signal {
  if (sig.expiry != null) return sig;
  if (!OVERNIGHT_SPREAD_RE.test(text)) return sig;
  return { ...sig, expiry: 'overnight' };
}

/**
 * If the LLM emitted a quantity that coincidentally matches the
 * statedPrice (or, worse, matches a fraction of it like $X.YZ → quantity=YZ
 * integer), and the text contains no "N contracts"/"N shares"/"N lots",
 * drop the quantity.
 */
const EXPLICIT_QTY_RE = /\b\d{1,6}\s*(?:shares?|contracts?|lots?|k\s+shares?)\b|\bone\s+contract\b/i;
function rule_strip_phantom_quantity(sig: Signal, text: string): Signal {
  if (sig.quantity == null) return sig;
  if (EXPLICIT_QTY_RE.test(text)) return sig;
  // Quantity with no explicit shares/contracts marker is unreliable — drop.
  return { ...sig, quantity: null };
}

/**
 * Strip LLM's P&L amount that it misclassified as statedPrice. E.g.
 * "Exit Long AGH .17 gain" — .17 is the P&L, not the exit price. If the
 * only numeric the LLM extracted is inside a "N gain/loss/profit" phrase
 * AND the text has no higher-priority price marker, clear statedPrice.
 */
function rule_strip_pl_miscoded_as_price(sig: Signal, text: string): Signal {
  if (sig.statedPrice == null) return sig;
  if (!PL_DOLLAR_RE.test(text)) return sig;
  // If there's ALSO an "@ $" or "at $" or "$N" before the P&L phrase, keep
  // the price (the LLM probably picked it correctly).
  const beforePL = text.substring(0, (PL_DOLLAR_RE.exec(text)?.index ?? text.length));
  if (/@\s*\$?\d|\bat\s+\$\d|\$\d+(?:\.\d+)?(?!\s*c\s+(?:gain|loss))/i.test(beforePL)) return sig;
  // No explicit price before the P&L — the extracted number was the P&L itself.
  // Clear if the statedPrice matches the P&L number exactly.
  const plMatch = /(?:\bfor\s+(?:a\s+)?)?[+-]?\$?(\.\d+|\d+(?:\.\d+)?)\s*c?\s*(?:\/(?:share|contract))?\s+(?:gain|loss|scratch|profit)\b/i.exec(text);
  if (plMatch) {
    const plNum = parseFloat(plMatch[1].startsWith('.') ? `0${plMatch[1]}` : plMatch[1]);
    if (Math.abs(plNum - sig.statedPrice) < 0.01) {
      return { ...sig, statedPrice: null };
    }
  }
  return sig;
}

// ── Orchestration ───────────────────────────────────────────────────────────

type Rule = (sig: Signal, text: string, badges: readonly string[]) => Signal;

const RULES: Rule[] = [
  // Strip the LLM's guessed exit direction first, so evidence-based rules
  // below can set direction from textual cues without being clobbered after.
  rule_strip_guessed_exit_direction,
  rule_dollarPriceImpliesStock,
  rule_partialExitIsTrim,
  rule_fill_exitpct_on_trim,
  rule_strip_exitpct_1_on_close,
  rule_trim_100pct_is_close,
  rule_strip_pl_miscoded_as_exitpct,
  rule_strip_pl_miscoded_as_price,
  rule_covered_short_direction,
  rule_my_long_position_direction,
  rule_my_options_direction,
  rule_lotto_is_long,
  rule_exit_direction_from_badge,
  rule_overnight_expiry,
  rule_strip_phantom_quantity,
  rule_averaged_in_is_add,
];

export function postProcessSignals(signals: Signal[], messageText: string, badges: readonly string[] = []): Signal[] {
  return signals.map((sig) => RULES.reduce((s, rule) => rule(s, messageText, badges), sig));
}
