/**
 * Shared classification knowledge used by both the live signal classifier
 * (signal-classifier.ts) and the backtest intent extractor (extract-intent.ts).
 *
 * Contains strategy definitions, strike inference heuristics, direction rules,
 * signal action definitions, and flag-for-review criteria. Each consumer
 * composes their own system prompt from this shared base plus path-specific
 * additions (e.g. live tools, backtest context, examples).
 */

export const STRATEGY_KNOWLEDGE = `CDS (Call Debit Spread): 2 legs, both CALL. BUY lower strike, SELL higher strike. Default expiry: this Friday.
  "LONG AAPL CDS 172.5/177.5" -> Buy 172.5C, Sell 177.5C, this Friday.
PDS (Put Debit Spread): 2 legs, both PUT. BUY higher strike, SELL lower strike. Default expiry: this Friday.
  "SHORT SPOT PDS 570/565" -> Buy 570P, Sell 565P, this Friday.
PCS (Put Credit Spread): SELL the spread for credit. Map to direction: SHORT, strategy: PDS. Legs reversed from long PDS: SELL higher strike put, BUY lower strike put. If the message says "credit" or "for X credit", it confirms PCS. PCS is bullish; PDS is bearish.
Naked call: 1 leg, optionType CALL, action BUY.
Naked put: 1 leg, optionType PUT, action BUY.
Calendar/time spread: When both Long+Short badges appear, flag for review.`;

export const DIRECTION_RULES = `The direction field means whether you are BUYING (LONG) or SELLING (SHORT) the option/spread.
It does NOT represent the trader's stock-level view.

Core rule: derive direction from the actual trade mechanics, not the Long/Short prefix.
- Debit strategies (buying options or spreads): direction is LONG, always.
- Direction is SHORT only when genuinely SELLING (writing) options for credit, or short-selling stock.
- The words "Bought" and "Sold" in the message are authoritative -- they override any prefix.

Confirming with exit context: LOSS with exit < entry = they bought (paid high, sold low). GAIN with exit < entry = they sold to open (collected premium, bought back cheap).`;

export const STRIKE_INFERENCE = `Traders often omit strikes ("Short ALGN pds", "Long AAPL cds"). This is normal -- infer them:

1. Get the current stock price via get_quote (or use prefetched data).
2. Call get_options_chain with the default expiry (this Friday) and option type (PUT for PDS, CALL for CDS).
3. Pick the nearest ATM strike as the long (BUY) leg.
4. Pick the next available strike as the short (SELL) leg. Width heuristic: $2.50 if stock <$50, $5 if $50-200, $10 if >$200.
5. If the trader mentions a net premium ("for .09"), scan the chain for the strike combo whose net debit best matches.
6. Use the mid-price of the spread as limitPrice.

If a trader-specified strike does not exist in the chain, flag for review.`;

export const SIGNAL_ACTIONS = `All signals omit quantity -- the system calculates position size.

OPEN: New position. Include symbol, direction, strategy, limitPrice, legs (required for options).
CLOSE: Full exit. Omit legs -- the system reverses existing position legs. Get a fresh quote for limitPrice (ignore the trader's stated fill).
ADD: Adding to existing position. Verify the position exists. Same fields as OPEN.
TRIM: Partial exit. Include exitPercent (0.5 = half, 0.8 = 80%). Omit legs.
LEG_OFF: Close one leg of a spread, hold the other. Include targetStrategy (CALL or PUT) -- the strategy after the closed leg is removed. Omit legs.`;

export const FLAG_CRITERIA = `Only flag_for_review when:
- The strategy TYPE itself is ambiguous (is it stock or options? call or put spread?)
- Both Long+Short badges appear (possible calendar/time spread -- unsupported)
- The symbol is unrecognizable or clearly wrong
- A trader-specified strike does not exist in the chain

Inferring strikes from the options chain is your job, not guessing. Do NOT flag just because strikes are missing.`;

export const SLANG_GUIDE = `"Lotto" / "Yolo" = speculative BUY (always buy-to-open, never sell-to-open).
"Scalp" = short-duration trade, no effect on direction or strategy parsing.
"Short [ticker] puts" = bearish, BUYING puts (direction: LONG).`;

export const GENERAL_RULES = `- Only parse trades for tracked traders in the whitelist. Skip paper trades tagged "(paper)".
- Messages may contain multiple signals ("Exit TXN, Short TSLA") -- return ALL in the signals array.
- Always explain your reasoning -- your steps are audited.
- If you don't understand a financial concept, say so. Never fabricate mechanics.`;
