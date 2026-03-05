import type { BrokerService } from '../broker/interface.js';
import type { OrderLeg } from '../broker/types.js';
import { roundCents } from '../lib/numbers.js';

// ─── Result Types ────────────────────────────────────

export type CreditDebitConfidence = 'STRUCTURAL' | 'QUOTE_BASED';

export type CreditDebitResult = {
  /** true = net credit (you receive premium), false = net debit (you pay premium). */
  isCredit: boolean;
  /** How the determination was made. */
  confidence: CreditDebitConfidence;
  /**
   * Net premium magnitude (always positive) from quote midpoints.
   * Only present when confidence === 'QUOTE_BASED' or when validation fetched quotes.
   */
  netPremium?: number;
  /**
   * Structural determination if available, even when quotes were used.
   * Lets callers detect conflicts between structure and market.
   */
  structuralIsCredit?: boolean;
  /** Human-readable warning when quotes conflict with structure or are unreliable. */
  warning?: string;
};

// ─── Midpoint ────────────────────────────────────────

/**
 * Always-positive midpoint price for any leg combination.
 *
 * Stock: (bid + ask) / 2 for the underlying.
 * Options / spreads: nets BUY legs (buy at ask, sell at bid) against
 * SELL legs (sell at bid, buy at ask), returns abs of the result.
 */
export async function getMidpoint(
  broker: BrokerService,
  legs: OrderLeg[],
): Promise<number> {
  if (legs.every(l => l.type === 'STOCK')) {
    const quote = await broker.getQuote(legs[0].symbol);
    return roundCents((quote.bid + quote.ask) / 2);
  }

  let netBid = 0;
  let netAsk = 0;

  for (const leg of legs) {
    const quote = await broker.getQuote(leg.symbol);

    if (leg.action === 'BUY') {
      netBid += quote.bid;
      netAsk += quote.ask;
    } else {
      netBid -= quote.ask;
      netAsk -= quote.bid;
    }
  }

  return Math.abs(roundCents((netBid + netAsk) / 2));
}

// ─── Structural Credit/Debit ─────────────────────────

/**
 * Pure structural credit/debit determination — no quotes, no async.
 *
 * Returns `true` (credit), `false` (debit), or `null` (indeterminate — needs quotes).
 *
 * ## Guaranteed-correct cases:
 *
 * 1. **All STOCK legs** → always false (no premium exchanged).
 *
 * 2. **All option legs same action** (naked, straddle, strangle):
 *    SELL → credit, BUY → debit. Quantities don't matter because
 *    every leg moves cash the same direction.
 *
 * 3. **Standard 1:1 vertical spread** (exactly 2 option legs, same type,
 *    same expiry, equal quantity):
 *    - CALL: lower-strike call is always more valuable (no-arbitrage).
 *      Selling the lower strike = credit.
 *    - PUT: higher-strike put is always more valuable (no-arbitrage).
 *      Selling the higher strike = credit.
 *
 * ## Cases that return null (need quotes):
 *
 * - Calendar / diagonal spreads (different expiries — time value is not orderable by strike)
 * - Ratio spreads (unequal quantities — the cheaper leg might dominate by volume)
 * - Iron condors / iron butterflies (mixed CALL + PUT legs)
 * - Butterflies / condors with 3+ legs of the same type
 * - Any stock + option combo where the option side has mixed actions
 */
export function isCreditOrderStructural(legs: OrderLeg[]): boolean | null {
  // ── Case 1: Pure stock ──
  if (legs.every(l => l.type === 'STOCK')) return false;

  // Separate option legs from stock legs.
  const optionLegs = legs.filter(l => l.type !== 'STOCK');
  if (optionLegs.length === 0) return false;

  // ── Case 2: All option legs share the same action ──
  // Naked options, straddles, strangles — direction is unambiguous.
  const actions = new Set(optionLegs.map(l => l.action));
  if (actions.size === 1) {
    return optionLegs[0].action === 'SELL';
  }

  // ── Case 3: Standard 1:1 vertical spread ──
  // Requirements:
  //   a) exactly 2 option legs
  //   b) same option type (both CALL or both PUT)
  //   c) same expiry (not a calendar/diagonal)
  //   d) equal quantity (not a ratio spread)
  //   e) different strikes (not the same option bought and sold — that's a wash)
  //   f) mixed actions (one BUY, one SELL — already guaranteed by actions.size > 1)
  if (optionLegs.length !== 2) return null;

  const [a, b] = optionLegs;
  if (a.type !== b.type) return null;        // mixed CALL/PUT → iron spread
  if (a.expiry !== b.expiry) return null;    // different expiry → calendar/diagonal
  if (a.quantity !== b.quantity) return null; // different qty → ratio spread
  if (a.strike === b.strike) return null;    // same strike, opposite actions — unusual

  // Sort by strike to identify which leg is structurally more valuable.
  const sorted = [...optionLegs].sort((x, y) => x.strike - y.strike);
  const [lowerStrike, higherStrike] = sorted;

  if (a.type === 'CALL') {
    // A lower-strike call always has greater theoretical value than a
    // higher-strike call at the same expiry. This is a no-arbitrage
    // property: C(K1) >= C(K2) when K1 < K2.
    // Selling the more valuable leg → net credit.
    return lowerStrike.action === 'SELL';
  } else {
    // A higher-strike put always has greater theoretical value than a
    // lower-strike put at the same expiry. P(K2) >= P(K1) when K2 > K1.
    return higherStrike.action === 'SELL';
  }
}

// ─── Quote-Based Check ───────────────────────────────

/**
 * Determine credit/debit using live quotes.
 *
 * For each leg we fetch the quote and compute:
 *   SELL legs: +midpoint × quantity  (cash in)
 *   BUY legs:  −midpoint × quantity  (cash out)
 *
 * Net > 0 → credit. Net < 0 → debit.
 *
 * Also computes a "spread width ratio" to detect unreliable results:
 *   totalBidAskWidth / |netPremium|
 * If this ratio exceeds a threshold the midpoint is considered unreliable
 * because the bid-ask noise swamps the signal.
 */
async function isCreditOrderFromQuotes(
  broker: BrokerService,
  legs: OrderLeg[],
): Promise<{ isCredit: boolean; netPremium: number; warning?: string }> {
  let netMid = 0;
  let totalBidAskWidth = 0;

  for (const leg of legs) {
    const quote = await broker.getQuote(leg.symbol);
    const mid = (quote.bid + quote.ask) / 2;
    const width = quote.ask - quote.bid;

    totalBidAskWidth += width * leg.quantity;

    if (leg.action === 'SELL') {
      netMid += mid * leg.quantity;
    } else {
      netMid -= mid * leg.quantity;
    }
  }

  const netPremium = Math.abs(roundCents(netMid));
  const isCredit = netMid > 0;

  // Warn if the total bid-ask width is >= 2x the net premium.
  // This means the spread noise is so large that a small quote shift
  // could flip the sign of the net premium.
  let warning: string | undefined;
  if (netPremium > 0 && totalBidAskWidth / netPremium >= 2) {
    warning =
      `Wide bid-ask: total spread width ${roundCents(totalBidAskWidth)} ` +
      `vs net premium ${netPremium}. Midpoint-based credit/debit ` +
      `determination may be unreliable.`;
  } else if (netPremium === 0) {
    warning = 'Net premium is $0.00 at midpoint — credit/debit is ambiguous.';
  }

  return { isCredit, netPremium, warning };
}

// ─── Combined: Structural First, Quote Fallback ─────

/**
 * Production-grade credit/debit determination.
 *
 * 1. Tries structural (deterministic, sync, free) first.
 * 2. Falls back to live quotes when structure is ambiguous.
 * 3. When both are available, trusts structure over quotes —
 *    but warns if quotes disagree (wide bid-ask / illiquid market).
 *
 * ## Why structure wins over quotes:
 *
 * For standard verticals, no-arbitrage guarantees which leg is more
 * valuable. If the midpoint disagrees, it means quotes are stale,
 * crossed, or illiquid — not that the spread changed economic nature.
 * A put credit spread (sell higher strike, buy lower strike) is
 * ALWAYS a credit by construction. A midpoint showing debit just means
 * the market is too wide to trust the midpoint for pricing.
 *
 * ## The wide bid-ask "flip" scenario:
 *
 * Consider a PCS: Sell 100P (bid 1.00, ask 5.00, mid 3.00),
 *                 Buy  95P (bid 2.00, ask 6.00, mid 4.00).
 * Midpoint says debit (-$1.00), but structurally 100P > 95P always.
 * We return isCredit=true (structural) with a warning about the
 * quote conflict. The caller should:
 *   - Use the structural answer for sign convention / chase direction.
 *   - Be cautious about the limit price — may need manual review.
 */
export async function isCreditOrder(
  broker: BrokerService,
  legs: OrderLeg[],
): Promise<CreditDebitResult> {
  const structural = isCreditOrderStructural(legs);

  // ── Structural determination succeeded ──
  if (structural !== null) {
    return {
      isCredit: structural,
      confidence: 'STRUCTURAL',
      structuralIsCredit: structural,
    };
  }

  // ── Structural indeterminate — fetch quotes ──
  const quoteResult = await isCreditOrderFromQuotes(broker, legs);

  return {
    isCredit: quoteResult.isCredit,
    confidence: 'QUOTE_BASED',
    netPremium: quoteResult.netPremium,
    structuralIsCredit: undefined,
    warning: quoteResult.warning,
  };
}

/**
 * Extended version that ALSO fetches quotes when structural succeeds,
 * to detect and warn about quote/structure conflicts.
 *
 * Use this for order placement where you want belt-and-suspenders
 * validation. Skip it for hot-path UI where you just need the sign.
 */
export async function isCreditOrderWithValidation(
  broker: BrokerService,
  legs: OrderLeg[],
): Promise<CreditDebitResult> {
  const structural = isCreditOrderStructural(legs);

  // Always fetch quotes (even if structural succeeded).
  const quoteResult = await isCreditOrderFromQuotes(broker, legs);

  // ── Structural succeeded ──
  if (structural !== null) {
    // Check for conflict: structural says credit but quotes say debit (or vice versa).
    if (structural !== quoteResult.isCredit) {
      return {
        isCredit: structural, // trust structure
        confidence: 'STRUCTURAL',
        netPremium: quoteResult.netPremium,
        structuralIsCredit: structural,
        warning:
          `CONFLICT: Structural analysis says ${structural ? 'CREDIT' : 'DEBIT'} ` +
          `but quote midpoint says ${quoteResult.isCredit ? 'CREDIT' : 'DEBIT'} ` +
          `(net ${quoteResult.netPremium}). This likely indicates illiquid/wide ` +
          `quotes. Structural answer is authoritative — review limit price carefully.`,
      };
    }

    return {
      isCredit: structural,
      confidence: 'STRUCTURAL',
      netPremium: quoteResult.netPremium,
      structuralIsCredit: structural,
      warning: quoteResult.warning, // pass through bid-ask width warnings
    };
  }

  // ── Structural indeterminate — quotes only ──
  return {
    isCredit: quoteResult.isCredit,
    confidence: 'QUOTE_BASED',
    netPremium: quoteResult.netPremium,
    structuralIsCredit: undefined,
    warning: quoteResult.warning,
  };
}
