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

export type CanonicalMatch = {
  action: TradeAction;
  direction: Direction | null;
  strategy: Strategy | null;
  strikes: number[] | null;
  expiry: string | null;
  statedPrice: number | null;
};

const MONTH_MAP: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

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
 *   - remove the symbol (already extracted)
 *   - remove parenthetical content
 *   - remove trailing p&l annotations like "for $5 gain", "for .30c loss"
 *   - remove trailing commentary modifiers ("spec size", "for a swing", "small loss")
 *   - collapse whitespace
 */
function stripToCoreText(text: string, symbol: string): string {
  let t = text;
  // Remove badge words from anywhere
  t = t.replace(/\b(?:Long|Short|Exit)\b/gi, '');
  // Remove the symbol (first occurrence, boundaried)
  t = t.replace(new RegExp(`\\b${symbol}\\b`, 'i'), '');
  // Strip parens
  t = t.replace(/\([^)]*\)/g, ' ');
  // Strip trailing P&L annotations
  t = t.replace(/\s+for\s+\$?\.?\d+(?:\.\d+)?\s*c?\s+(?:gain|loss|scratch|profit)\s*$/i, '');
  t = t.replace(/\s+-\s*\$?\d+(?:\.\d+)?\s*-?\s*(?:small\s+)?(?:loss|gain|scratch)\s*$/i, '');
  t = t.replace(/\s+(?:small|tiny|big)?\s*(?:loss|gain|scratch|profit)\s*$/i, '');
  // Strip common size modifiers
  t = t.replace(/\bspec\s+size\b/gi, '');
  t = t.replace(/\bfor\s+a\s+swing\b/gi, '');
  t = t.replace(/\b2nd\s+try\b/gi, '');
  // Trim "-" separators
  t = t.replace(/\s+-\s+/g, ' ');
  // Normalize
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

// ── Template table ───────────────────────────────────────────────────────────
// Each entry: { re: whole-core-text regex, map: (match) => CanonicalMatch }

type Template = {
  re: RegExp;
  label: string;
  map: (m: RegExpMatchArray, action: TradeAction) => CanonicalMatch | null;
};

const NUM = String.raw`\d+(?:\.\d+)?`;
const DEC = String.raw`\d{1,4}(?:\.\d{1,4})?`;

const TEMPLATES: Template[] = [
  // STOCK open/close: "18.98", "$260.76", "@ 34.20", "at $32.03"
  {
    re: new RegExp(`^\\$?(${DEC})$`),
    label: 'STOCK bare price',
    map: (m, action) => ({ action, direction: null, strategy: 'STOCK', strikes: null, expiry: null, statedPrice: parseFloat(m[1]) }),
  },
  {
    re: new RegExp(`^@\\s*\\$?(${DEC})$`),
    label: 'STOCK @ price',
    map: (m, action) => ({ action, direction: null, strategy: 'STOCK', strikes: null, expiry: null, statedPrice: parseFloat(m[1]) }),
  },
  {
    re: new RegExp(`^at\\s+\\$?(${DEC})$`, 'i'),
    label: 'STOCK "at" price',
    map: (m, action) => ({ action, direction: null, strategy: 'STOCK', strikes: null, expiry: null, statedPrice: parseFloat(m[1]) }),
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
      statedPrice: null,
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
      statedPrice: parseFloat(m[5]),
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
      statedPrice: parseFloat(m[5]),
    }),
  },

  // Spread: "cds 330/340 for $0.52"
  {
    re: new RegExp(`^(cds|pds|pcs|ccs)\\s+\\$?(${NUM})\\/\\$?(${NUM})\\s+for\\s+\\$?(${NUM})(?:\\s+credit|\\s+debit)?$`, 'i'),
    label: 'SPREAD acronym strikes for price',
    map: (m, action) => {
      const strat = m[1].toUpperCase() as Strategy;
      const bullish = strat === 'CDS' || strat === 'PCS';
      return {
        action, direction: bullish ? 'LONG' : 'SHORT', strategy: strat,
        strikes: [parseFloat(m[2]), parseFloat(m[3])].sort((a, b) => a - b),
        expiry: null, statedPrice: parseFloat(m[4]),
      };
    },
  },
];

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
  if (core === '') {
    // No remaining content — bare "Long SYMBOL" / "Exit SYMBOL" style.
    // Classify as bare STOCK trade if there's a direction-implying action.
    // Actually no — if all we have is the ticker, we don't know strategy.
    // Return null so LLM can decide.
    return null;
  }
  for (const tpl of TEMPLATES) {
    const m = tpl.re.exec(core);
    if (m) return tpl.map(m, action);
  }
  return null;
}
