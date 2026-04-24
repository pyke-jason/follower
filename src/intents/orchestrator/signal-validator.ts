/**
 * Signal verification harness.
 *
 * Runs deterministic validators over postProcessSignals output. Each validator
 * is a pure function that returns structured Issue[] objects with concrete
 * textual evidence. If any issues are raised, the caller makes ONE targeted
 * repair call to the LLM with the evidence baked into the prompt.
 *
 * Pattern (per April 2026 SOTA): cheap deterministic check → single LLM repair
 * with concrete concern → re-validate → flag if still broken. No LLM-as-judge,
 * no N-sample self-consistency, no >1 repair call.
 */
import type { Signal } from '@/agent/schemas.js';
import type { ChatHistoryProvider } from './types.js';

export type ValidatorIssue = {
  signalIndex: number;
  field: string;
  /** Concrete evidence quoted from the message/history. Not a conclusion. */
  evidence: string;
  /** Phrased as a question to reconsider, not a directive. */
  concern: string;
};

type ValidatorInput = {
  signals: Signal[];
  messageText: string;
  badges: readonly string[];
  author: string;
  history: ChatHistoryProvider;
};

type Validator = (ctx: ValidatorInput) => Promise<ValidatorIssue[]> | ValidatorIssue[];

// ── Text probes ─────────────────────────────────────────────────────────────
const LOTTO_YOLO_RE = /\b(?:lotto|yolo)s?\b/i;
const CALLS_WORD_RE = /\bcalls?\b/i;
const PUTS_WORD_RE = /\bputs?\b/i;
const STRIKE_CALL_NOTATION_RE = /\$?\d{1,4}(?:\.\d+)?\s*c\b(?!all)/i;
const STRIKE_PUT_NOTATION_RE = /\$?\d{1,4}(?:\.\d+)?\s*p\b(?!ut)/i;
const SPREAD_RE = /\b(?:cds|pds|pcs|ccs|spread|credit\s+spread|debit\s+spread)\b/i;
const SHARES_RE = /\b(?:shares?|stock|equity|equities)\b/i;
const SOLD_TO_OPEN_RE = /\b(?:sold\s+to\s+open|sto|wrote|writing)\b|\bsold\b[\s\S]{1,40}?\b(?:puts?|calls?|\d{1,4}\s*[cp])\b/i;
// Any "X%" followed by profit/gain/loss/return (not "N% off/out/out of")
const PCT_PNL_RE = /\b(\d{1,3})\s*%\s*(?:profit|gain|loss|return)/i;
// Size qualifier that would legitimize a TRIM
const SIZE_QUALIFIER_RE = /\b(?:half|partial(?:s|\s|$)|still\s+holding|some\s+off|scaling|scaled|trimmed?|took\s+partial|\d\/[234]|small\s+part|part\s+of)/i;

// ── Validators ──────────────────────────────────────────────────────────────

/** Lotto/Yolo messages are ALWAYS a speculative BUY → direction=LONG. */
function v_lotto_is_long(ctx: ValidatorInput): ValidatorIssue[] {
  if (!LOTTO_YOLO_RE.test(ctx.messageText)) return [];
  const issues: ValidatorIssue[] = [];
  ctx.signals.forEach((s, i) => {
    if (s.direction === 'SHORT') {
      issues.push({
        signalIndex: i,
        field: 'direction',
        evidence: `Message contains "lotto" or "yolo" (speculative BUY language), but you set direction=SHORT.`,
        concern: `Is this a sell-to-open? Lotto/Yolo means the author is BUYING options — direction should be LONG.`,
      });
    }
  });
  return issues;
}

/** strategy=STOCK but the text contains unambiguous options language. */
function v_strategy_text_mismatch(ctx: ValidatorInput): ValidatorIssue[] {
  const hasCalls = CALLS_WORD_RE.test(ctx.messageText) || STRIKE_CALL_NOTATION_RE.test(ctx.messageText);
  const hasPuts = PUTS_WORD_RE.test(ctx.messageText) || STRIKE_PUT_NOTATION_RE.test(ctx.messageText);
  const hasSpread = SPREAD_RE.test(ctx.messageText);
  const hasShares = SHARES_RE.test(ctx.messageText);
  const issues: ValidatorIssue[] = [];
  ctx.signals.forEach((s, i) => {
    if (s.strategy !== 'STOCK') return;
    if (hasShares) return; // "shares" word overrides — it IS stock
    if (hasCalls) {
      issues.push({
        signalIndex: i,
        field: 'strategy',
        evidence: `Message mentions "call(s)" or option strike notation like "$Nc", but strategy=STOCK.`,
        concern: `Should this be strategy=CALL? Re-check the message for options language.`,
      });
    } else if (hasPuts) {
      issues.push({
        signalIndex: i,
        field: 'strategy',
        evidence: `Message mentions "put(s)" or option strike notation like "$Np", but strategy=STOCK.`,
        concern: `Should this be strategy=PUT? Re-check the message for options language.`,
      });
    } else if (hasSpread) {
      issues.push({
        signalIndex: i,
        field: 'strategy',
        evidence: `Message mentions a spread acronym (cds/pds/pcs/ccs/spread), but strategy=STOCK.`,
        concern: `Should this be a spread strategy (CDS/PDS/PCS/CCS) rather than STOCK?`,
      });
    }
  });
  return issues;
}

/** action=TRIM with only P&L percentage as evidence (no size qualifier) → probably full CLOSE. */
function v_pnl_not_trim_percent(ctx: ValidatorInput): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  const pnlMatch = PCT_PNL_RE.exec(ctx.messageText);
  if (!pnlMatch) return issues;
  const hasSizeQualifier = SIZE_QUALIFIER_RE.test(ctx.messageText);
  if (hasSizeQualifier) return issues; // size qualifier present — TRIM is fine
  ctx.signals.forEach((s, i) => {
    if (s.action !== 'TRIM') return;
    // Compare exitPercent to the P&L percentage — if they match or exitPercent looks like the P&L number
    const pnlFrac = parseInt(pnlMatch[1], 10) / 100;
    if (s.exitPercent != null && Math.abs(s.exitPercent - pnlFrac) < 0.01) {
      issues.push({
        signalIndex: i,
        field: 'action',
        evidence: `The only percent in the message is "${pnlMatch[0]}" (P&L), with no size qualifier like "half", "partial", "1/3", or "small part".`,
        concern: `Is "${pnlMatch[1]}%" describing profit size or exit size? If it's profit, this is likely action=CLOSE (full exit), not TRIM.`,
      });
    }
  });
  return issues;
}

/** "sold [strike][c|p]" / "wrote" / "sold to open" → direction=SHORT on options. */
function v_sold_to_open_is_short(ctx: ValidatorInput): ValidatorIssue[] {
  if (!SOLD_TO_OPEN_RE.test(ctx.messageText)) return [];
  const issues: ValidatorIssue[] = [];
  ctx.signals.forEach((s, i) => {
    if (s.action !== 'OPEN' && s.action !== 'ADD') return;
    if (s.strategy !== 'CALL' && s.strategy !== 'PUT') return;
    if (s.direction === 'SHORT') return;
    issues.push({
      signalIndex: i,
      field: 'direction',
      evidence: `Message contains sell-to-open language ("sold [strike]", "wrote", "sold to open"), but direction=${s.direction ?? 'null'}.`,
      concern: `Is the author SELLING the option for premium (direction=SHORT)? Sold/wrote is authoritative for SHORT on options.`,
    });
  });
  return issues;
}

/**
 * Exit on ticker with ambiguous/incomplete instrument language. Consults the
 * author's recent history for a clear options open on the same ticker. Fires
 * when: (a) draft is STOCK/null and history shows CALL or PUT open, OR
 * (b) draft is CALL but history shows PUT open (or vice versa). Current
 * message text overrides history only when it's explicit.
 */
async function v_prior_position_strategy(ctx: ValidatorInput): Promise<ValidatorIssue[]> {
  const issues: ValidatorIssue[] = [];
  const exits = ctx.signals
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.action === 'CLOSE' || s.action === 'TRIM' || s.action === 'LEG_OFF');
  if (exits.length === 0) return issues;
  // If the current message has UNAMBIGUOUS instrument language, history is not
  // needed. "my calls", "$30p", "cds", "shares", "lotto"/"yolo" all tell us
  // the instrument category in-message.
  const msgHasCalls = CALLS_WORD_RE.test(ctx.messageText) || STRIKE_CALL_NOTATION_RE.test(ctx.messageText);
  const msgHasPuts = PUTS_WORD_RE.test(ctx.messageText) || STRIKE_PUT_NOTATION_RE.test(ctx.messageText);
  if (msgHasCalls || msgHasPuts || SPREAD_RE.test(ctx.messageText) || SHARES_RE.test(ctx.messageText)) return issues;
  if (LOTTO_YOLO_RE.test(ctx.messageText)) return issues;
  let history: string;
  try {
    history = await ctx.history.getRecentMessages(ctx.author, 30);
  } catch {
    return issues;
  }
  if (!history) return issues;
  for (const { s, i } of exits) {
    const sym = s.symbol;
    if (!sym) continue;
    // Look for the author's most recent OPEN on this ticker with options language.
    const openRe = new RegExp(`\\b${escapeRegExp(sym)}\\b[^\\n]{0,120}`, 'gi');
    let bestHint: 'CALL' | 'PUT' | null = null;
    let bestExcerpt = '';
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(history)) !== null) {
      const excerpt = m[0];
      const hasCalls = /\bcalls?\b/i.test(excerpt) || /\b\d{1,4}(?:\.\d+)?\s*c\b/i.test(excerpt);
      const hasPuts = /\bputs?\b/i.test(excerpt) || /\b\d{1,4}(?:\.\d+)?\s*p\b/i.test(excerpt);
      if (hasPuts && !hasCalls) { bestHint = 'PUT'; bestExcerpt = excerpt; }
      else if (hasCalls && !hasPuts) { bestHint = 'CALL'; bestExcerpt = excerpt; }
    }
    if (!bestHint) continue;
    const draftStrategy = s.strategy;
    const conflict = draftStrategy === 'STOCK' || draftStrategy == null ||
      (bestHint === 'PUT' && draftStrategy === 'CALL') ||
      (bestHint === 'CALL' && draftStrategy === 'PUT');
    if (!conflict) continue;
    issues.push({
      signalIndex: i,
      field: 'strategy',
      evidence: `Author's recent history on ${sym}: "${bestExcerpt.slice(0, 160)}". Current message has no explicit instrument language.`,
      concern: `Is this exit closing the ${bestHint} position the author opened earlier? Your draft says strategy=${draftStrategy ?? 'null'}.`,
    });
  }
  return issues;
}

/**
 * Strikes in the draft must be findable in the current message text. If the
 * LLM emits strikes=[96] but the text has no "96" number, they're hallucinated
 * from chat history — strip them.
 */
function v_hallucinated_strikes(ctx: ValidatorInput): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  ctx.signals.forEach((s, i) => {
    if (!s.strikes || s.strikes.length === 0) return;
    for (const strike of s.strikes) {
      // Accept exact match or with decimal. "96" in "at $96" / "96c" / "96p" / "$96"
      const strikeStr = String(strike);
      const strikeNoDecimal = strikeStr.replace(/\.0+$/, '');
      const rx = new RegExp(`(?:^|\\D)(?:${escapeRegExp(strikeStr)}|${escapeRegExp(strikeNoDecimal)})(?:\\D|$)`);
      if (!rx.test(ctx.messageText)) {
        issues.push({
          signalIndex: i,
          field: 'strikes',
          evidence: `Draft strikes include ${strike}, but the message text does not contain "${strike}" as a number. The strike may have been inferred from earlier chat messages rather than the current one.`,
          concern: `Is ${strike} actually stated in THIS message? If not, omit strikes and let downstream position matching find the strike.`,
        });
        return; // one issue per signal is enough
      }
    }
  });
  return issues;
}

/** The text has a clear DOLLAR price marker but statedPrice is null. */
function v_dropped_price(ctx: ValidatorInput): ValidatorIssue[] {
  const issues: ValidatorIssue[] = [];
  // "for X%" and "X% profit/gain/loss" are P&L, NOT prices. Strip them from consideration.
  const textWithoutPnl = ctx.messageText
    .replace(/\bfor\s+[~\s]*\d+(?:\.\d+)?\s*%[^\s]*/gi, '')
    .replace(/\b\d{1,3}\s*%\s*(?:profit|gain|loss|return)s?\b/gi, '')
    .replace(/\b(?:for|of)\s+(?:a\s+)?\$?\d+(?:\.\d+)?\s*c?\s*(?:gain|loss|profit|scratch)\b/gi, '');
  // Require a $ or @ anchor on the number to distinguish price from size/qty/strike.
  const priceMarkers = [
    /\bfor\s+\$\.?\d/i,              // "for $.63" / "for $12"
    /\bfor\s+[~\s]*\.\d+/i,          // "for .93" (bare decimal only makes sense as price)
    /@\s*\$?\d+(?:\.\d+)?/i,         // "@ 2.10"
    /\bat\s+\$\d/i,                  // "at $54"
  ];
  const hasMarker = priceMarkers.some((re) => re.test(textWithoutPnl));
  if (!hasMarker) return issues;
  ctx.signals.forEach((s, i) => {
    if (s.statedPrice != null) return;
    if (s.action !== 'OPEN' && s.action !== 'ADD' && s.action !== 'CLOSE' && s.action !== 'TRIM') return;
    issues.push({
      signalIndex: i,
      field: 'statedPrice',
      evidence: `Message contains a dollar price marker ($N, "for $X", "@ X", or "at $X"), but statedPrice is null.`,
      concern: `Is there a stated fill price you missed? Percentages (N%) are P&L, not prices — look for a dollar number.`,
    });
  });
  return issues;
}

// ── Orchestration ───────────────────────────────────────────────────────────

const VALIDATORS: Validator[] = [
  v_lotto_is_long,
  v_strategy_text_mismatch,
  v_sold_to_open_is_short,
  v_prior_position_strategy,
  v_hallucinated_strikes,
  v_dropped_price,
];

/** Run all validators and collect issues. */
export async function validateSignals(input: ValidatorInput): Promise<ValidatorIssue[]> {
  const all: ValidatorIssue[] = [];
  for (const v of VALIDATORS) {
    const result = await v(input);
    all.push(...result);
  }
  return all;
}

/** Build the user prompt appendix that asks the LLM to reconsider with evidence. */
function buildRepairAppendix(draft: Signal[], issues: ValidatorIssue[]): string {
  const issueLines = issues
    .map((i) => `• [signal ${i.signalIndex} / ${i.field}] ${i.concern}\n  Evidence: ${i.evidence}`)
    .join('\n\n');
  return [
    ``,
    `─────────────────────────`,
    `VERIFICATION FEEDBACK`,
    `─────────────────────────`,
    `Your initial answer was:`,
    JSON.stringify(draft, null, 2),
    ``,
    `A deterministic post-check raised these concerns:`,
    issueLines,
    ``,
    `Please reconsider the classification. If any concern is unfounded, explain briefly and proceed. Otherwise, correct the affected field(s) and call submit_decision with your final answer.`,
  ].join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
