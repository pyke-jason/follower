/**
 * Whole-message canonical trade template matching.
 *
 * Only accepts messages whose ENTIRE meaningful content (after stripping
 * badges + symbol + trivial modifiers like parens/p&l/size) matches a known
 * structured-trade template. Returns complete field extraction on match;
 * null otherwise.
 *
 * Design rule: a template must describe the whole core text, not individual
 * fields from prose. Per-field keyword scanning against free prose (e.g. "has
 * `PDS` somewhere" → strategy=PDS) produces false positives on commentary
 * that merely mentions trade terms.
 *
 * Ambiguity is allowed in the output schema. If a message doesn't reveal
 * the strategy ("Long NVDA" alone — could be stock, call, spread), the
 * return is null and the LLM disambiguates.
 *
 * Canonical examples we handle:
 *   "Long NVDA 182.38"        → STOCK at 182.38  (bare price matches STOCK template)
 *   "Short VXX @ 34.20"       → STOCK at 34.20
 *   "Long NVDA 175c 12/21"    → CALL strike=175 expiry=12/21
 *   "Long UNH cds 330/340 for $0.52" → CDS spread
 *
 * What we deliberately DON'T match:
 *   "Long NVDA"                      → ambiguous (stock? call? spread?); LLM decides
 *   "Long NVDA 175c breaking out..." → free prose with trade keywords; LLM decides
 *   "these PDSes look good today"    → commentary mentioning PDS; LLM decides
 *
 * Stock price plausibility: we rely on the fact that a message with only a
 * bare number after the ticker is overwhelmingly a stock price quote. We do
 * not yet verify the number against the symbol's actual market price — that
 * would require broker I/O. If a trader writes "Long NVDA 2.03" meaning an
 * option premium without specifying the strike/expiry, our template will
 * mis-classify as STOCK. A future enhancement should verify the number
 * against a quote band.
 */
import type { Direction, Strategy, TradeAction } from '@/lib/enums.js';

type CanonicalMatch = {
  action: TradeAction;
  direction: Direction | null;
  strategy: Strategy | null;
  strikes: number[] | null;
  expiry: string | null;
  statedPrice: number | null;
  exitPercent: number | null;
  ruleId: string;
  routeReason: string;
};

const MONTH_MAP: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_NAMES = Object.keys(MONTH_MAP).join('|');

function toExpiry(mm: string, dd: string): string {
  const m = parseInt(mm, 10), d = parseInt(dd, 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

function toExpiryFromMonthName(mon: string, day: string): string {
  const m = MONTH_MAP[mon.toLowerCase()];
  const d = parseInt(day, 10);
  if (!m || d < 1 || d > 31) return '';
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

/**
 * Strip the message down to its canonical core:
 *   - remove badge words + symbol (already extracted from structural metadata)
 *   - remove parenthetical content (e.g. "(36c gain)", "(2nd try)")
 *   - remove STRUCTURED trailing P&L annotations ("for $5 gain", "- $1 - loss")
 *
 * Intentionally does NOT strip bare-trailing "profit"/"gain"/"loss"/"scratch"
 * keywords: "Exit Long AGH .17 gain" has the number .17 as the P&L amount,
 * not the exit price, so we need the template match to fail, not to strip
 * "gain" and accidentally promote .17 to a stock price.
 */
function stripToCoreText(text: string, symbol: string): string {
  let t = text;
  // Remove badge words from anywhere
  t = t.replace(/\b(?:Long|Short|Exit)\b/gi, '');
  // Remove the symbol (first occurrence, boundaried)
  t = t.replace(new RegExp(`\\b${symbol}\\b`, 'i'), '');
  // Normalize "MonthName (Day)" → "MM/DD" BEFORE paren stripping so expiry survives
  t = t.replace(new RegExp(`\\b(${MONTH_NAMES})\\s*\\(\\s*(\\d{1,2})\\s*\\)`, 'gi'), (_, mon: string, day: string) => toExpiryFromMonthName(mon, day) || '');
  // Normalize "MonthName DD" and "MonthNameDD" (e.g. "Mar04", "Feb 20") → "MM/DD"
  t = t.replace(new RegExp(`\\b(${MONTH_NAMES})\\s*(\\d{1,2})\\b`, 'gi'), (_, mon: string, day: string) => toExpiryFromMonthName(mon, day) || '');
  // Strip parens (catches "(36c gain)", "(2nd try)", "(-53c loss)", "(Small Account Challenge)")
  t = t.replace(/\([^)]*\)/g, ' ');
  // Strip trailing "- N Contracts" contract-count annotations
  t = t.replace(/\s+-\s+\d+\s+Contracts?\s*-?\s*$/i, '');
  // Strip trailing "/share" / "per share" / "/contract" / "per contract" suffixes (after a numeric)
  t = t.replace(/\/(?:share|contract)s?\s*$/i, '');
  t = t.replace(/\s+per\s+(?:share|contract)s?\s*$/i, '');
  // Strip "for a/some (small|tiny|big|nice|huge|double)? (profit|loss|gain|scratch) of [+-]?$N(\/share|\/contract)?" trailing
  t = t.replace(/\s+for\s+(?:a\s+|some\s+)?(?:small\s+|tiny\s+|big\s+|nice\s+|huge\s+|double\s+)?(?:profit|loss|gain|scratch)s?\s+of\s+[+-]?\$?\d+(?:\.\d+)?\s*(?:\/(?:share|contract)s?)?\s*$/i, '');
  // Strip structured trailing P&L: "for $N gain/loss/scratch/profit" (optionally prefixed with +/- or "a")
  t = t.replace(/\s+for\s+(?:a\s+)?[+-]?\$?\.?\d+(?:\.\d+)?\s*c?\s+(?:gain|loss|scratch|profit)s?\s*\.?\s*$/i, '');
  // Strip "for +$N/share" / "for +N per share" trailing (profit annotation without word gain/loss)
  t = t.replace(/\s+for\s+[+-]\$?\.?\d+(?:\.\d+)?(?:\s*(?:\/(?:share|contract)s?|per\s+(?:share|contract)s?))?\s*$/i, '');
  // Strip structured dash-wrapped P&L: "- $N - small loss"
  t = t.replace(/\s+-\s*\$?\d+(?:\.\d+)?\s*-?\s*(?:small|tiny|big)?\s*(?:loss|gain|scratch|profit)s?\s*$/i, '');
  // Strip trailing "final sell with profit/loss/gain" BEFORE the bare "with profit/loss"
  // stripper so "final sell" does not get left behind as residue.
  t = t.replace(/\s+final\s+sell\s+with\s+(?:profit|loss|gain)s?\.?\s*$/i, '');
  // Strip trailing "with (a)? (profit|loss|gain)" at end
  t = t.replace(/\s+with\s+(?:a\s+)?(?:profit|loss|gain)s?\.?\s*$/i, '');
  // Strip trailing "Expiration" literal noise after dates
  t = t.replace(/\s+Expiration\b/gi, '');
  // Strip commentary modifiers between structural tokens:
  //   "$27 calls again for .93"         → drop " again"
  //   "$27 calls for .95 basically intrinsic" → drop " basically intrinsic"
  //   "$27 calls for $X thanks Pete"    → drop trailing attribution
  // These are tight prose trailers specific to option-style messages.
  t = t.replace(/\b(calls?|puts?)\s+again\b/gi, '$1');
  t = t.replace(/\s+basically\s+intrinsic\s*$/i, '');
  t = t.replace(/,?\s+thanks\s+\w+\s*\.?\s*$/i, '');
  // Strip trailing " ." / double-dots that linger from stripped P&L
  t = t.replace(/\s*\.\s*\.\s*$/, '');
  t = t.replace(/\s*\.\s*$/, '');
  // Normalize whitespace
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

// ── Template table ───────────────────────────────────────────────────────────
// Each entry: { re: whole-core-text regex, map: (match) => CanonicalMatch }

type Template = {
  re: RegExp;
  label: string;
  map: (
    m: RegExpMatchArray,
    action: TradeAction,
  ) => Omit<CanonicalMatch, 'ruleId' | 'routeReason'> | null;
};

const NUM = String.raw`\d+(?:\.\d+)?`;
const DEC = String.raw`\d{1,4}(?:\.\d{1,4})?`;
/** Price that tolerates leading-dot decimals like ".63" in addition to "0.63". */
const PRICE = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
/** Date fragment: MM/DD or M-D (the hyphen form appears after "expiring 9-19"). */
const MMDD = String.raw`\d{1,2}[\/-]\d{1,2}`;

/** Parse an MM/DD or M-D token; returns null if invalid (e.g. "20/03" with month 20). */
function parseMMDD(raw: string): string | null {
  const [mm, dd] = raw.split(/[\/-]/);
  const e = toExpiry(mm, dd);
  return e === '' ? null : e;
}

const TEMPLATES: Template[] = [
  // STOCK open/close: "18.98", "$260.76", "@ 34.20", "at $32.03"
  {
    re: new RegExp(`^\\$?(${DEC})$`),
    label: 'STOCK bare price',
    map: (m, action) => ({ action, direction: null, strategy: 'STOCK', strikes: null, expiry: null, statedPrice: parseFloat(m[1]), exitPercent: null }),
  },
  {
    re: new RegExp(`^@\\s*\\$?(${DEC})$`),
    label: 'STOCK @ price',
    map: (m, action) => ({ action, direction: null, strategy: 'STOCK', strikes: null, expiry: null, statedPrice: parseFloat(m[1]), exitPercent: null }),
  },
  {
    re: new RegExp(`^at\\s+\\$?(${DEC})$`, 'i'),
    label: 'STOCK "at" price',
    map: (m, action) => ({ action, direction: null, strategy: 'STOCK', strikes: null, expiry: null, statedPrice: parseFloat(m[1]), exitPercent: null }),
  },
  // STOCK exit "with (a)? (profit|loss) at $PRICE" — prefix "with loss" appears before the at-price clause.
  {
    re: new RegExp(`^with\\s+(?:a\\s+)?(?:profit|loss|gain)s?\\s+at\\s+\\$?(${DEC})$`, 'i'),
    label: 'STOCK "with loss/profit at $price"',
    map: (m, action) => ({ action, direction: null, strategy: 'STOCK', strikes: null, expiry: null, statedPrice: parseFloat(m[1]), exitPercent: null }),
  },

  // TRIM STOCK: "$PRICE half of the position" / "half of the position $PRICE"
  // Only valid when action is CLOSE (fromExit badge) — we turn it into TRIM in the caller
  // and annotate exitPercent=0.5. Note: we return action=TRIM directly because the
  // template shape "half of the position" is an unambiguous partial exit.
  {
    re: new RegExp(`^\\$?(${DEC})\\s+half\\s+of\\s+the\\s+position$`, 'i'),
    label: 'TRIM STOCK "$price half of the position"',
    map: (_m, action) => action === 'CLOSE' ? ({
      action: 'TRIM', direction: null, strategy: 'STOCK', strikes: null, expiry: null,
      statedPrice: parseFloat(_m[1]), exitPercent: 0.5,
    }) : null,
  },
  {
    re: new RegExp(`^half\\s+of\\s+(?:the\\s+)?(\\w+)?\\s*\\$?(${DEC})$`, 'i'),
    label: 'TRIM STOCK "half of [symbol] $price"',
    map: (_m, action) => action === 'CLOSE' ? ({
      action: 'TRIM', direction: null, strategy: 'STOCK', strikes: null, expiry: null,
      statedPrice: parseFloat(_m[2]), exitPercent: 0.5,
    }) : null,
  },
  // TRIM STOCK: "partial profits $PRICE" (e.g. "Exit MSFT partial profits $499")
  {
    re: new RegExp(`^partial\\s+profits?\\s+\\$?(${DEC})$`, 'i'),
    label: 'TRIM STOCK "partial profits $price"',
    map: (m, action) => action === 'CLOSE' ? ({
      action: 'TRIM', direction: null, strategy: 'STOCK', strikes: null, expiry: null,
      statedPrice: parseFloat(m[1]), exitPercent: 0.5,
    }) : null,
  },
  // TRIM STOCK: "half position at PRICE" / "half position $PRICE"
  {
    re: new RegExp(`^half\\s+position\\s+(?:at\\s+)?\\$?(${DEC})$`, 'i'),
    label: 'TRIM STOCK "half position at price"',
    map: (m, action) => action === 'CLOSE' ? ({
      action: 'TRIM', direction: null, strategy: 'STOCK', strikes: null, expiry: null,
      statedPrice: parseFloat(m[1]), exitPercent: 0.5,
    }) : null,
  },

  // Single-leg option: "175c 12/21", "175c 12/21 2.03", "175c 12/21 @ 2.03", "175c 12/21 for 2.03"
  {
    re: new RegExp(`^(${NUM})([cp])\\s+(\\d{1,2})\\/(\\d{1,2})$`, 'i'),
    label: 'OPT strike+type+MMDD',
    map: (m, action) => ({
      action, direction: null,
      strategy: m[2].toLowerCase() === 'c' ? 'CALL' : 'PUT',
      strikes: [parseFloat(m[1])],
      expiry: toExpiry(m[3], m[4]),
      statedPrice: null, exitPercent: null,
    }),
  },
  {
    re: new RegExp(`^(${NUM})([cp])\\s+(\\d{1,2})\\/(\\d{1,2})\\s+\\$?(${NUM})$`, 'i'),
    label: 'OPT strike+type+MMDD+price',
    map: (m, action) => ({
      action, direction: null,
      strategy: m[2].toLowerCase() === 'c' ? 'CALL' : 'PUT',
      strikes: [parseFloat(m[1])],
      expiry: toExpiry(m[3], m[4]),
      statedPrice: parseFloat(m[5]), exitPercent: null,
    }),
  },
  {
    re: new RegExp(`^(${NUM})([cp])\\s+(\\d{1,2})\\/(\\d{1,2})\\s+(?:@|for)\\s*\\$?(${NUM})$`, 'i'),
    label: 'OPT strike+type+MMDD+@/for+price',
    map: (m, action) => ({
      action, direction: null,
      strategy: m[2].toLowerCase() === 'c' ? 'CALL' : 'PUT',
      strikes: [parseFloat(m[1])],
      expiry: toExpiry(m[3], m[4]),
      statedPrice: parseFloat(m[5]), exitPercent: null,
    }),
  },

  // Single-leg option with "$STRIKE calls|puts" form (word-spelled, no "c"/"p" letter).
  // Variants: "$340 Calls for .48", "$27 calls for .95", "$35 Calls 3/20 for .71"
  //           "$400 Calls for $12.05", "$180 Calls - 2/20 - for $13.10"
  {
    re: new RegExp(`^(?:lotto\\s+)?\\$(${NUM})\\s+(call|put)s?\\s+for\\s+\\$?(${PRICE})$`, 'i'),
    label: 'OPT $strike word-call for price',
    map: (m, action) => ({
      action, direction: null,
      strategy: m[2].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
      strikes: [parseFloat(m[1])],
      expiry: null,
      statedPrice: parseFloat(m[3]), exitPercent: null,
    }),
  },
  {
    re: new RegExp(`^(?:lotto\\s+)?\\$(${NUM})\\s+(call|put)s?\\s+(${MMDD})\\s+for\\s+\\$?(${PRICE})$`, 'i'),
    label: 'OPT $strike word-call MMDD for price',
    map: (m, action) => {
      const expiry = parseMMDD(m[3]);
      if (expiry === null) return null;
      return {
        action, direction: null,
        strategy: m[2].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
        strikes: [parseFloat(m[1])], expiry,
        statedPrice: parseFloat(m[4]), exitPercent: null,
      };
    },
  },
  {
    re: new RegExp(`^(?:lotto\\s+)?\\$(${NUM})\\s+(call|put)s?\\s+-?\\s*(${MMDD})\\s*-?\\s+for\\s+\\$?(${PRICE})$`, 'i'),
    label: 'OPT $strike word-call - MMDD - for price',
    map: (m, action) => {
      const expiry = parseMMDD(m[3]);
      if (expiry === null) return null;
      return {
        action, direction: null,
        strategy: m[2].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
        strikes: [parseFloat(m[1])], expiry,
        statedPrice: parseFloat(m[4]), exitPercent: null,
      };
    },
  },
  // "$17.5 Calls for $3.65 3/20" reversed order (price before date, bare date)
  {
    re: new RegExp(`^\\$(${NUM})\\s+(call|put)s?\\s+for\\s+\\$?(${PRICE})\\s+(${MMDD})$`, 'i'),
    label: 'OPT $strike word-call for price MMDD',
    map: (m, action) => {
      const expiry = parseMMDD(m[4]);
      if (expiry === null) return null;
      return {
        action, direction: null,
        strategy: m[2].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
        strikes: [parseFloat(m[1])], expiry,
        statedPrice: parseFloat(m[3]), exitPercent: null,
      };
    },
  },
  // "using $STRIKE Calls for PRICE"
  {
    re: new RegExp(`^using\\s+(?:the\\s+)?\\$(${NUM})\\s+(call|put)s?\\s+for\\s+\\$?(${PRICE})$`, 'i'),
    label: 'OPT "using $strike calls for price"',
    map: (m, action) => ({
      action, direction: null,
      strategy: m[2].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
      strikes: [parseFloat(m[1])],
      expiry: null,
      statedPrice: parseFloat(m[3]), exitPercent: null,
    }),
  },
  {
    re: new RegExp(`^using\\s+(?:the\\s+)?\\$(${NUM})\\s+(call|put)s?\\s+(${MMDD})\\s+for\\s+\\$?(${PRICE})$`, 'i'),
    label: 'OPT "using $strike calls MMDD for price"',
    map: (m, action) => {
      const expiry = parseMMDD(m[3]);
      if (expiry === null) return null;
      return {
        action, direction: null,
        strategy: m[2].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
        strikes: [parseFloat(m[1])], expiry,
        statedPrice: parseFloat(m[4]), exitPercent: null,
      };
    },
  },
  // "$STRIKE calls expiring MM/DD for PRICE"
  {
    re: new RegExp(`^\\$(${NUM})\\s+(call|put)s?\\s+expiring\\s+(${MMDD})\\s+for\\s+\\$?(${PRICE})$`, 'i'),
    label: 'OPT $strike word-call expiring MMDD for price',
    map: (m, action) => {
      const expiry = parseMMDD(m[3]);
      if (expiry === null) return null;
      return {
        action, direction: null,
        strategy: m[2].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
        strikes: [parseFloat(m[1])], expiry,
        statedPrice: parseFloat(m[4]), exitPercent: null,
      };
    },
  },

  // Sell-to-open single-leg put/call: "sold MM/DD $STRIKE put @ PRICE" / "sold the MM/DD $STRIKE put for PRICE"
  // Direction is always SHORT (selling for premium), overriding the Long badge.
  // After strip, "sold Oct (10) $15 put @ $.60" becomes "sold 10/10 $15 put @ $.60".
  {
    re: new RegExp(`^(?:via\\s+)?(?:sold|selling|writing|wrote)\\s+(?:the\\s+)?(${MMDD})\\s+\\$\\s*(${NUM})\\s+(put|call)s?\\s+(?:@|for|at)\\s*\\$?\\s*(${PRICE})$`, 'i'),
    label: 'SELL-TO-OPEN "sold MMDD $strike put @ price"',
    map: (m, action) => {
      const expiry = parseMMDD(m[1]);
      if (expiry === null) return null;
      return {
        action, direction: 'SHORT',
        strategy: m[3].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
        strikes: [parseFloat(m[2])], expiry,
        statedPrice: parseFloat(m[4]), exitPercent: null,
      };
    },
  },
  // Same but with $STRIKE immediately followed by " put $PRICE" (no "@" / "for"), e.g. "sold Oct (17) $59 put $ 2.40"
  {
    re: new RegExp(`^(?:via\\s+)?(?:sold|selling|writing|wrote)\\s+(?:the\\s+)?(${MMDD})\\s+\\$\\s*(${NUM})\\s+(put|call)s?\\s+\\$\\s*(${PRICE})$`, 'i'),
    label: 'SELL-TO-OPEN "sold MMDD $strike put $price"',
    map: (m, action) => {
      const expiry = parseMMDD(m[1]);
      if (expiry === null) return null;
      return {
        action, direction: 'SHORT',
        strategy: m[3].toLowerCase().startsWith('c') ? 'CALL' : 'PUT',
        strikes: [parseFloat(m[2])], expiry,
        statedPrice: parseFloat(m[4]), exitPercent: null,
      };
    },
  },

  // Spread: "cds 330/340 for $0.52" (existing behavior — with $ prefix and integer prices)
  {
    re: new RegExp(`^(cds|pds|pcs|ccs)\\s+\\$?(${NUM})\\/\\$?(${NUM})\\s+for\\s+\\$?(${NUM})(?:\\s+credit|\\s+debit)?$`, 'i'),
    label: 'SPREAD acronym strikes for price',
    map: (m, action) => {
      const strat = m[1].toUpperCase() as Strategy;
      const bullish = strat === 'CDS' || strat === 'PCS';
      return {
        action, direction: bullish ? 'LONG' : 'SHORT', strategy: strat,
        strikes: [parseFloat(m[2]), parseFloat(m[3])].sort((a, b) => a - b),
        expiry: null, statedPrice: parseFloat(m[4]), exitPercent: null,
      };
    },
  },
  // Spread with leading-dot decimal and optional trailing "credit"/"debit"/"expiring DATE"
  {
    re: new RegExp(`^(cds|pds|pcs|ccs)\\s+\\$?(${NUM})\\/\\$?(${NUM})\\s+for\\s+\\$?(${PRICE})(?:\\s+credit|\\s+debit)?(?:\\s+expiring\\s+(${MMDD}))?$`, 'i'),
    label: 'SPREAD acronym strikes for PRICE [credit/debit] [expiring DATE]',
    map: (m, action) => {
      const strat = m[1].toUpperCase() as Strategy;
      const bullish = strat === 'CDS' || strat === 'PCS';
      let expiry: string | null = null;
      if (m[5]) {
        expiry = parseMMDD(m[5]);
        if (expiry === null) return null;
      }
      return {
        action, direction: bullish ? 'LONG' : 'SHORT', strategy: strat,
        strikes: [parseFloat(m[2]), parseFloat(m[3])].sort((a, b) => a - b),
        expiry, statedPrice: parseFloat(m[4]), exitPercent: null,
      };
    },
  },
  // Spread with bare $PRICE (no "for"): "CDS $320/$325 $2.00"
  {
    re: new RegExp(`^(cds|pds|pcs|ccs)\\s+\\$?(${NUM})\\/\\$?(${NUM})\\s+\\$(${PRICE})$`, 'i'),
    label: 'SPREAD acronym strikes bare $price',
    map: (m, action) => {
      const strat = m[1].toUpperCase() as Strategy;
      const bullish = strat === 'CDS' || strat === 'PCS';
      return {
        action, direction: bullish ? 'LONG' : 'SHORT', strategy: strat,
        strikes: [parseFloat(m[2]), parseFloat(m[3])].sort((a, b) => a - b),
        expiry: null, statedPrice: parseFloat(m[4]), exitPercent: null,
      };
    },
  },
];

// Option-related word keywords. If present anywhere in the raw text (including
// inside stripped parens), a STOCK template match would be unsafe — e.g.
// "Long CWVX 17.56 (non stop call...)" template-matches STOCK at 17.56 but
// the paren's "call" means the trader is buying calls.
//
// Word-form only (call/put/calls/puts/spread/strike/etc). NOT "Nc"/"Np"
// patterns because those appear inside P&L annotations like "(-53c loss)"
// where the c is "cents" not a call suffix.
const OPTION_CUE_RE = /\b(?:call|put|calls|puts|spread|strike|premium|credit|debit|cds|pds|pcs|ccs|leap|lotto|yolo|strangle|straddle)\b/i;

/**
 * Try to fully classify a message deterministically. Returns null if no
 * canonical template matches — caller should fall through to the LLM.
 */
export function matchCanonicalTrade(
  rawText: string,
  symbol: string,
  action: TradeAction,
): CanonicalMatch | null {
  const core = stripToCoreText(rawText, symbol);
  if (core === '') return null;
  for (const tpl of TEMPLATES) {
    const m = tpl.re.exec(core);
    if (!m) continue;
    const match = tpl.map(m, action);
    if (!match) continue;
    // If we're about to call this STOCK but the original message contains
    // option-related cues (most often inside stripped parens), bail out —
    // ambiguous, let the LLM handle it.
    if (match.strategy === 'STOCK' && OPTION_CUE_RE.test(rawText)) return null;
    return {
      ...match,
      ruleId: `canonical.${slugifyRuleId(tpl.label)}`,
      routeReason: tpl.label,
    };
  }
  return null;
}

function slugifyRuleId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
