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

/** Explicit partial-exit qualifiers that turn a CLOSE into a TRIM.
 *  Note: "small part" removed — label convention is only explicit
 *  fractions/percentages/"partial"/"half"/"still holding" counts as partial. */
const EXPLICIT_PARTIAL_RE = /\b(?:half|partial(?:\s+profits?)?|1\/[234]|\d+\s*%(?!\s*profit)|still\s+holding|some\s+off|took\s+(?:more|additional|further|another)\s+(?:gains?|profits?)|took\s+(?:small\s+)?(?:gains?|profits?)\s+again|scaling\s+out|scaled\s+out|trimmed|took\s+partial)\b/i;

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

/** SKILL rule 8: "A stated dollar price implies STOCK unless options language is present." */
function rule_dollarPriceImpliesStock(sig: Signal, text: string): Signal {
  if (sig.strategy != null) return sig;
  if (sig.statedPrice == null) return sig;
  // Only fire when no option markers anywhere
  if (OPTION_WORD_RE.test(text) || OPTION_NC_NP_RE.test(text)) return sig;
  return { ...sig, strategy: 'STOCK' };
}

/**
 * SKILL rule 12: explicit partial qualifier → TRIM + exitPercent 0.5.
 * Only flips CLOSE → TRIM; never touches OPEN/ADD.
 */
function rule_partialExitIsTrim(sig: Signal, text: string): Signal {
  if (sig.action !== 'CLOSE') return sig;
  if (!EXPLICIT_PARTIAL_RE.test(text)) return sig;
  if (EXPLICIT_FULL_RE.test(text)) return sig; // "closed out remainder" — stays CLOSE
  const next: Signal = { ...sig, action: 'TRIM' };
  if (next.exitPercent == null) next.exitPercent = 0.5;
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
 * Rule: "my shares"/"my stock"/"my long" → direction=LONG on CLOSE/TRIM
 * of STOCK. Catches "Exit OPEN remainder of my shares".
 */
function rule_my_long_position_direction(sig: Signal, text: string): Signal {
  if (sig.action !== 'CLOSE' && sig.action !== 'TRIM') return sig;
  if (sig.direction != null) return sig;
  if (!MY_LONG_POSITION_RE.test(text)) return sig;
  // Only apply to stock-strategy exits (options have other semantics)
  if (sig.strategy !== 'STOCK' && sig.strategy != null) return sig;
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
 * "for overnight" as expiry — only on OPEN/ADD actions. For exits,
 * "overnight" usually refers to the position being closed, not the expiry
 * of this new action.
 */
function rule_overnight_expiry(sig: Signal, text: string): Signal {
  if (sig.expiry != null) return sig;
  if (sig.action !== 'OPEN' && sig.action !== 'ADD') return sig;
  // Require "for overnight" specifically (not just any "overnight" mention)
  if (!/\bfor\s+overnight\b/i.test(text)) return sig;
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

const RULES: Array<(sig: Signal, text: string) => Signal> = [
  rule_dollarPriceImpliesStock,
  rule_partialExitIsTrim,
  rule_strip_pl_miscoded_as_exitpct,
  rule_strip_pl_miscoded_as_price,
  rule_covered_short_direction,
  rule_my_long_position_direction,
  rule_my_options_direction,
  rule_overnight_expiry,
  rule_strip_phantom_quantity,
];

export function postProcessSignals(signals: Signal[], messageText: string): Signal[] {
  return signals.map((sig) => RULES.reduce((s, rule) => rule(s, messageText), sig));
}
